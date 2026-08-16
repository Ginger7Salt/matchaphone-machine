import { db } from "./db";
import { clearPersonaDraft } from "./userPersonaDraft";
import { defaultAppSettings, type BackgroundTask } from "./types";

const LIFECYCLE_LOCK_KEY = "mira:data-lifecycle-lock-v1";
const LIFECYCLE_LOCK_TTL_MS = 5 * 60 * 1000;
let mutationDepth = 0;
let mutationToken = "";

interface LifecycleLock {
  token: string;
  expiresAt: number;
}

function readSharedLifecycleLock(): LifecycleLock | undefined {
  if (typeof localStorage === "undefined") return;
  try {
    const value = JSON.parse(localStorage.getItem(LIFECYCLE_LOCK_KEY) ?? "null") as Partial<LifecycleLock> | null;
    if (!value || typeof value.token !== "string" || typeof value.expiresAt !== "number") return;
    if (value.expiresAt <= Date.now()) {
      localStorage.removeItem(LIFECYCLE_LOCK_KEY);
      return;
    }
    return { token: value.token, expiresAt: value.expiresAt };
  } catch {
    return;
  }
}

function publishLifecycleState(active: boolean) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("mira:data-lifecycle", { detail: { active } }));
}

export function dataLifecycleMutationActive() {
  return mutationDepth > 0 || Boolean(readSharedLifecycleLock());
}

export async function withDataLifecycleMutation<T>(work: () => Promise<T>): Promise<T> {
  const outermost = mutationDepth === 0;
  mutationDepth += 1;
  if (outermost) {
    mutationToken = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    try {
      localStorage.setItem(
        LIFECYCLE_LOCK_KEY,
        JSON.stringify({ token: mutationToken, expiresAt: Date.now() + LIFECYCLE_LOCK_TTL_MS }),
      );
    } catch {}
    publishLifecycleState(true);
  }
  try {
    return await work();
  } finally {
    mutationDepth = Math.max(0, mutationDepth - 1);
    if (outermost) {
      try {
        if (readSharedLifecycleLock()?.token === mutationToken) localStorage.removeItem(LIFECYCLE_LOCK_KEY);
      } catch {}
      mutationToken = "";
      publishLifecycleState(false);
    }
  }
}

/** Settings that remain bound to this browser when a portable backup is restored. */
export const DEVICE_SETTING_KEYS = new Set([
  "provider",
  "speech",
  "image-generation",
  "model-services-v1",
  "embedding-service",
  "provider-presets-v1",
  "github-backup",
]);

type ReferenceKind = "character" | "conversation" | "message" | "session" | "island";
interface TaskReference {
  kind: ReferenceKind;
  id: string;
}

function referenceKindOfKey(key: string): ReferenceKind | undefined {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (normalized.endsWith("characterid") || normalized.endsWith("characterids") || normalized.endsWith("participantid") || normalized.endsWith("participantids") || normalized.endsWith("speakerid") || normalized.endsWith("speakerids") || normalized.endsWith("memberid") || normalized.endsWith("memberids") || normalized === "speakerorder") return "character";
  if (normalized.endsWith("conversationid") || normalized.endsWith("conversationids")) return "conversation";
  if (normalized.endsWith("messageid") || normalized.endsWith("messageids")) return "message";
  if (normalized.endsWith("sessionid") || normalized.endsWith("sessionids")) return "session";
  if (normalized.endsWith("islandid") || normalized.endsWith("islandids")) return "island";
  return;
}

function taskPayloadReferences(value: unknown, inheritedKind?: ReferenceKind, seen = new Set<object>()): TaskReference[] {
  if (typeof value === "string") return inheritedKind ? [{ kind: inheritedKind, id: value }] : [];
  if (!value || typeof value !== "object") return [];
  if (seen.has(value as object)) return [];
  seen.add(value as object);
  if (Array.isArray(value)) return value.flatMap((item) => taskPayloadReferences(item, inheritedKind, seen));
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const mappedCharacterIds = (normalized === "targetbubblecounts" || normalized === "groupprovidercallbudgets") && item && typeof item === "object" && !Array.isArray(item)
      ? Object.keys(item as Record<string, unknown>).map((id) => ({ kind: "character" as const, id }))
      : [];
    return [...mappedCharacterIds, ...taskPayloadReferences(item, referenceKindOfKey(key), seen)];
  });
}

export function backgroundTaskReferenceIds(task: BackgroundTask): TaskReference[] {
  const references = taskPayloadReferences(task.payload);
  if (task.characterId) references.push({ kind: "character", id: task.characterId });
  if (task.conversationId) references.push({ kind: "conversation", id: task.conversationId });
  return references;
}

export function backgroundTaskReferences(task: BackgroundTask, ids: Iterable<string>) {
  const wanted = new Set(ids);
  if (wanted.has(task.entityId)) return true;
  return backgroundTaskReferenceIds(task).some((reference) => wanted.has(reference.id));
}

export async function deleteBackgroundTasksReferencing(ids: Iterable<string>) {
  const values = [...new Set(ids)];
  if (!values.length) return 0;
  const tasks = await db.backgroundTasks.toArray();
  const targets = tasks.filter((task) => backgroundTaskReferences(task, values)).map((task) => task.id);
  if (targets.length) await db.backgroundTasks.bulkDelete(targets);
  return targets.length;
}

export type OrphanRecordKind =
  | "background-task"
  | "message"
  | "memory-vector"
  | "media-reference"
  | "meet-participant"
  | "music-event"
  | "island"
  | "island-object"
  | "island-entry"
  | "island-event";
export interface OrphanRecord {
  kind: OrphanRecordKind;
  recordId: string;
  reason: string;
  repair: "delete" | "report";
}
export interface OrphanAudit {
  issues: OrphanRecord[];
  counts: Partial<Record<OrphanRecordKind, number>>;
}

function summarize(issues: OrphanRecord[]): OrphanAudit {
  const counts: Partial<Record<OrphanRecordKind, number>> = {};
  for (const issue of issues) counts[issue.kind] = (counts[issue.kind] ?? 0) + 1;
  return { issues, counts };
}

export async function findOrphanRecords(): Promise<OrphanAudit> {
  const [
    characters,
    conversations,
    messages,
    memories,
    mediaAssets,
    tasks,
    vectors,
    meetSessions,
    listeningSessions,
    musicEvents,
    islands,
    objects,
    entries,
    events,
  ] = await Promise.all([
    db.characters.toArray(),
    db.conversations.toArray(),
    db.messages.toArray(),
    db.memories.toArray(),
    db.mediaAssets.toArray(),
    db.backgroundTasks.toArray(),
    db.memoryVectors.toArray(),
    db.meetSessions.toArray(),
    db.listeningSessions.toArray(),
    db.musicEvents.toArray(),
    db.coupleIslands.toArray(),
    db.coupleIslandObjects.toArray(),
    db.coupleIslandEntries.toArray(),
    db.coupleIslandEvents.toArray(),
  ]);
  const existing: Record<ReferenceKind, Set<string>> = {
    character: new Set(characters.map((row) => row.id)),
    conversation: new Set(conversations.map((row) => row.id)),
    message: new Set(messages.map((row) => row.id)),
    session: new Set([...meetSessions.map((row) => row.id), ...listeningSessions.map((row) => row.id)]),
    island: new Set(islands.map((row) => row.id)),
  };
  const memoryIds = new Set(memories.map((row) => row.id));
  const mediaIds = new Set(mediaAssets.map((row) => row.id));
  const issues: OrphanRecord[] = [];

  for (const task of tasks) {
    const missing = backgroundTaskReferenceIds(task).find((reference) => !existing[reference.kind].has(reference.id));
    if (missing) issues.push({ kind: "background-task", recordId: task.id, reason: `missing-${missing.kind}`, repair: "delete" });
  }
  for (const message of messages) {
    if (!existing.conversation.has(message.conversationId)) issues.push({ kind: "message", recordId: message.id, reason: "missing-conversation", repair: "report" });
    for (const attachment of message.attachments ?? []) {
      if ("assetId" in attachment && attachment.assetId && !mediaIds.has(attachment.assetId)) issues.push({ kind: "media-reference", recordId: message.id, reason: "missing-media-asset", repair: "report" });
    }
  }
  for (const vector of vectors) if (!memoryIds.has(vector.memoryId) || !existing.character.has(vector.characterId)) issues.push({ kind: "memory-vector", recordId: vector.memoryId, reason: "missing-memory-or-character", repair: "delete" });
  for (const session of meetSessions) if (session.participantIds.some((id) => !existing.character.has(id))) issues.push({ kind: "meet-participant", recordId: session.id, reason: "missing-character", repair: "report" });
  for (const event of musicEvents) if (!new Set(listeningSessions.map((row) => row.id)).has(event.sessionId) || (event.characterId && !existing.character.has(event.characterId))) issues.push({ kind: "music-event", recordId: event.id, reason: "missing-session-or-character", repair: "delete" });
  for (const island of islands) if (!existing.character.has(island.characterId) || !existing.conversation.has(island.conversationId)) issues.push({ kind: "island", recordId: island.id, reason: "missing-character-or-conversation", repair: "report" });
  for (const row of objects) if (!existing.island.has(row.islandId)) issues.push({ kind: "island-object", recordId: row.id, reason: "missing-island", repair: "delete" });
  for (const row of entries) if (!existing.island.has(row.islandId)) issues.push({ kind: "island-entry", recordId: row.id, reason: "missing-island", repair: "delete" });
  for (const row of events) if (!existing.island.has(row.islandId)) issues.push({ kind: "island-event", recordId: row.id, reason: "missing-island", repair: "delete" });
  return summarize(issues);
}

export async function repairOrphanRecords(audit?: OrphanAudit) {
  const report = audit ?? (await findOrphanRecords());
  const deletable = report.issues.filter((issue) => issue.repair === "delete");
  await withDataLifecycleMutation(() =>
    db.transaction(
      "rw",
      [db.backgroundTasks, db.memoryVectors, db.musicEvents, db.coupleIslandObjects, db.coupleIslandEntries, db.coupleIslandEvents],
      async () => {
        const ids = (kind: OrphanRecordKind) => deletable.filter((issue) => issue.kind === kind).map((issue) => issue.recordId);
        await Promise.all([
          db.backgroundTasks.bulkDelete(ids("background-task")),
          db.memoryVectors.bulkDelete(ids("memory-vector")),
          db.musicEvents.bulkDelete(ids("music-event")),
          db.coupleIslandObjects.bulkDelete(ids("island-object")),
          db.coupleIslandEntries.bulkDelete(ids("island-entry")),
          db.coupleIslandEvents.bulkDelete(ids("island-event")),
        ]);
      },
    ),
  );
  return { deleted: deletable.length, reported: report.issues.length - deletable.length, counts: report.counts };
}

async function clearBrowserRuntime() {
  let cachesCleared = true;
  let serviceWorkersCleared = true;
  if (typeof caches !== "undefined") {
    try {
      const keys = await caches.keys();
      const results = await Promise.all(keys.map((key) => caches.delete(key)));
      cachesCleared = results.every(Boolean);
    } catch {
      cachesCleared = false;
    }
  }
  if (typeof navigator !== "undefined" && "serviceWorker" in navigator && typeof navigator.serviceWorker.getRegistrations === "function") {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      const results = await Promise.all(registrations.map((registration) => registration.unregister()));
      serviceWorkersCleared = results.every(Boolean);
    } catch {
      serviceWorkersCleared = false;
    }
  }
  return { cachesCleared, serviceWorkersCleared };
}

export async function resetUserData() {
  return withDataLifecycleMutation(async () => {
    const tables = db.tables;
    await db.transaction("rw", tables, async () => {
      await Promise.all(tables.map((table) => table.clear()));
      await db.settings.put({ key: "app", value: { ...defaultAppSettings, onboarded: false } });
    });
    let personaCleared = true;
    try {
      await clearPersonaDraft();
    } catch {
      personaCleared = false;
    }
    const runtime = await clearBrowserRuntime();
    try {
      sessionStorage.clear();
    } catch {}
    return { personaCleared, ...runtime, activationPreserved: true };
  });
}
