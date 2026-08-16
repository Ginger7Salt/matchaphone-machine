import { beforeEach, describe, expect, it } from "vitest";
import { claimDueBackgroundTasks } from "./backgroundTasks";
import { deleteCharacterCascade } from "./backup";
import { claimNextChatReplyTask } from "./chatReplyTasks";
import { withDataLifecycleMutation } from "./dataLifecycle";
import { db } from "./db";
import type { BackgroundTask } from "./types";

const task = (overrides: Partial<BackgroundTask>): BackgroundTask => ({
  id: "task",
  schemaVersion: 1,
  createdAt: 1,
  updatedAt: 1,
  type: "memory-extraction",
  entityId: "entity",
  state: "pending",
  scheduledAt: 1,
  nextAttemptAt: 1,
  attempts: 0,
  eventId: "event",
  payload: {},
  ...overrides,
});

const character = (id: string) => ({ id, schemaVersion: 1, createdAt: 1, updatedAt: 1, name: id });
const conversation = (id: string, type: "private" | "group", memberIds: string[]) => ({ id, schemaVersion: 1, createdAt: 1, updatedAt: 1, title: id, type, memberIds, presetIds: [], loreBookIds: [], lastActivityAt: 1 });
const message = (id: string, conversationId: string, senderId: string, assetId?: string) => ({ id, schemaVersion: 1, createdAt: 1, updatedAt: 1, conversationId, senderType: "character", senderId, content: id, status: "complete", attachments: assetId ? [{ type: "image", assetId, description: "fixture" }] : undefined });

beforeEach(async () => {
  await db.delete();
  await db.open();
  localStorage.clear();
});

describe("character lifecycle cascade", () => {
  it("removes owned data and tasks while preserving shared conversations and media", async () => {
    await db.characters.bulkAdd([character("deleted"), character("kept")] as any);
    await db.conversations.bulkAdd([
      conversation("private", "private", ["deleted"]),
      conversation("group", "group", ["deleted", "kept"]),
    ] as any);
    await db.mediaAssets.bulkAdd([
      { id: "removed-media", createdAt: 1, updatedAt: 1, purpose: "chat-image", mimeType: "image/png", sizeBytes: 1, data: "data:image/png;base64,AA==" },
      { id: "shared-media", createdAt: 1, updatedAt: 1, purpose: "chat-image", mimeType: "image/png", sizeBytes: 1, data: "data:image/png;base64,AA==" },
    ] as any);
    await db.messages.bulkAdd([
      message("private-message", "private", "deleted", "removed-media"),
      message("deleted-group-message", "group", "deleted", "shared-media"),
      message("kept-group-message", "group", "kept", "shared-media"),
    ] as any);
    await db.backgroundTasks.bulkAdd([
      task({ id: "direct", eventId: "direct", characterId: "deleted" }),
      task({ id: "message-ref", eventId: "message-ref", payload: { sourceMessageId: "private-message" } }),
      task({ id: "group-map", eventId: "group-map", conversationId: "group", payload: { targetBubbleCounts: { deleted: 2, kept: 2 } } }),
      task({ id: "unrelated", eventId: "unrelated", characterId: "kept", conversationId: "group" }),
    ]);
    await db.listeningSessions.add({ id: "listening", schemaVersion: 1, createdAt: 1, updatedAt: 1, state: "ended", conversationId: "private", characterId: "deleted", queue: [], startedAt: 1 } as any);
    await db.musicEvents.add({ id: "music-event", schemaVersion: 1, createdAt: 1, updatedAt: 1, sessionId: "listening", conversationId: "private", characterId: "deleted", type: "summary", actor: "system" } as any);
    await db.coupleIslands.add({ id: "island", schemaVersion: 1, createdAt: 1, updatedAt: 1, characterId: "deleted", conversationId: "private", status: "active", name: "island", level: 1, experience: 0, heartShells: 0, themeId: "default", weather: "clear", lastActivityAt: 1 } as any);
    await db.coupleIslandEntries.add({ id: "island-entry", schemaVersion: 1, createdAt: 1, updatedAt: 1, islandId: "island", kind: "memory", authorType: "both", text: "fixture" } as any);
    await db.meetSessions.add({ id: "meet", schemaVersion: 1, createdAt: 1, updatedAt: 1, conversationId: "group", participantIds: ["deleted", "kept"], initiator: "user", scene: { opening: "fixture" }, suggestionsEnabled: true, status: "ended", entries: [], startedAt: 1, lastActivityAt: 1 } as any);
    await db.forumServers.add({ id: "server", schemaVersion: 1, createdAt: 1, updatedAt: 1, name: "server", description: "", iconText: "S", color: "#000", order: 0, characterIds: ["deleted", "kept"], memberProfiles: { deleted: { actorType: "character", actorId: "deleted", displayName: "deleted", handle: "deleted", bio: "", persona: "", joinedAt: 1, updatedAt: 1 } } } as any);
    await db.forumPosts.bulkAdd([
      { id: "authored", schemaVersion: 1, createdAt: 1, updatedAt: 1, channelId: "channel", authorType: "character", authorId: "deleted", authorName: "deleted", title: "fixture", content: "fixture", tags: [], pinned: false, reactions: [], replies: [], lastActivityAt: 1 },
      { id: "kept-post", schemaVersion: 1, createdAt: 1, updatedAt: 1, channelId: "channel", authorType: "character", authorId: "kept", authorName: "kept", title: "fixture", content: "fixture", tags: [], pinned: false, reactions: [], replies: [{ id: "deleted-reply", authorType: "character", authorId: "deleted", authorName: "deleted", content: "fixture", createdAt: 2, reactions: [] }, { id: "kept-reply", authorType: "character", authorId: "kept", authorName: "kept", content: "fixture", createdAt: 3, reactions: [] }], lastActivityAt: 3 },
    ] as any);

    await deleteCharacterCascade("deleted");
    await deleteCharacterCascade("deleted");

    expect(await db.characters.get("deleted")).toBeUndefined();
    expect(await db.conversations.get("private")).toBeUndefined();
    expect(await db.conversations.get("group")).toMatchObject({ memberIds: ["kept"] });
    expect(await db.messages.get("private-message")).toBeUndefined();
    expect(await db.messages.get("deleted-group-message")).toBeUndefined();
    expect(await db.messages.get("kept-group-message")).toBeTruthy();
    expect((await db.backgroundTasks.toArray()).map((row) => row.id)).toEqual(["unrelated"]);
    expect(await db.listeningSessions.get("listening")).toBeUndefined();
    expect(await db.musicEvents.get("music-event")).toBeUndefined();
    expect(await db.coupleIslands.get("island")).toBeUndefined();
    expect(await db.coupleIslandEntries.get("island-entry")).toBeUndefined();
    expect(await db.meetSessions.get("meet")).toMatchObject({ participantIds: ["kept"] });
    expect(await db.forumPosts.get("authored")).toBeUndefined();
    expect((await db.forumPosts.get("kept-post"))?.replies.map((reply) => reply.id)).toEqual(["kept-reply"]);
    expect(await db.mediaAssets.get("removed-media")).toBeUndefined();
    expect(await db.mediaAssets.get("shared-media")).toBeTruthy();
  });
});

describe("lifecycle task gate", () => {
  it("prevents generic and chat task claims during a destructive mutation", async () => {
    await db.backgroundTasks.bulkAdd([
      task({ id: "generic", eventId: "generic", type: "proactive-check" }),
      task({ id: "chat", eventId: "chat", type: "chat-reply", conversationId: "conversation", payload: { mode: "private", phase: "queued", autoResumeCount: 0 } }),
    ]);
    await withDataLifecycleMutation(async () => {
      await expect(claimDueBackgroundTasks(10, 10)).resolves.toEqual([]);
      await expect(claimNextChatReplyTask()).resolves.toBeUndefined();
    });
    expect((await db.backgroundTasks.toArray()).every((row) => row.state === "pending")).toBe(true);
  });
});
