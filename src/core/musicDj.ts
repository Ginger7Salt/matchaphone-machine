import { db } from "./db";
import {localTimeContext} from "./localTime";
import { addIslandEntry, coupleIslandForConversation } from "./coupleIsland";
import { enqueueBackgroundTask } from "./backgroundTasks";
import { PUBLIC_DEMO_MODE, publicDemoBackendError } from "./publicDemo";
import { OpenAIProvider } from "./provider";
import { normalizeReplyBubbles } from "./replyBubbles";
import { commitMoodImprintRecall, createMoodImprintForSession, enrichMoodImprint, moodImprintContext, selectMoodImprintForRecall } from "./musicMoodImprint";
import {
  now,
  SCHEMA_VERSION,
  uid,
  type Character,
  type ListeningQueueEntry,
  type ListeningSession,
  type Message,
  type MusicEvent,
  type MusicTrack,
  type ProviderSettings,
} from "./types";

const MUSIC_GATEWAY_ORIGIN = PUBLIC_DEMO_MODE ? "" : "https://matchaphone-d5gjgy87ybfb50382-1463048417.ap-shanghai.app.tcloudbase.com";
const MUSIC_API_BASE = typeof location !== "undefined" && /tcloudbaseapp\.com$/i.test(location.hostname) ? MUSIC_GATEWAY_ORIGIN + "/api/music" : "/api/music";

export function characterDjSettings(character: Pick<Character, "chatSettings">) {
  return {
    canInviteToListen: character.chatSettings?.music?.canInviteToListen ?? true,
    canControlPlayback: character.chatSettings?.music?.canControlPlayback ?? true,
    commentaryLevel: character.chatSettings?.music?.commentaryLevel ?? ("medium" as const),
    djEnabled: character.chatSettings?.music?.djEnabled ?? true,
    controlMode: character.chatSettings?.music?.controlMode ?? ("balanced" as const),
    allowNeteaseSearch: character.chatSettings?.music?.allowNeteaseSearch ?? true,
    moodImprintEnabled: character.chatSettings?.music?.moodImprintEnabled ?? true,
    moodRecallEnabled: character.chatSettings?.music?.moodRecallEnabled ?? true,
    lastProactiveInviteAt: character.chatSettings?.music?.lastProactiveInviteAt,
    lastCommentAt: character.chatSettings?.music?.lastCommentAt,
    lastCommentTrackId: character.chatSettings?.music?.lastCommentTrackId,
  };
}

export function normalizeListeningQueueEntries(session: Pick<ListeningSession, "queue" | "queueEntries" | "selectedBy" | "startedAt">): ListeningQueueEntry[] {
  const existing = session.queueEntries ?? [];
  return session.queue.map((trackId, index) => existing[index]?.trackId === trackId
    ? existing[index]
    : existing.find((entry) => entry.trackId === trackId) ?? { trackId, selectedBy: session.selectedBy, addedAt: session.startedAt });
}

export async function buildMusicDjCandidates(characterId: string, limit = 12) {
  const [tracks, playlists, events, files] = await Promise.all([
    db.musicTracks.toArray(),
    db.musicPlaylists.toArray(),
    db.musicEvents.where("characterId").equals(characterId).toArray(),
    db.musicFiles.toArray(),
  ]);
  const fileIds = new Set(files.map((file) => file.id));
  const available = new Map(tracks.filter((track) =>
    track.libraryStatus !== "temporary" && !track.unavailableReason &&
    (track.source !== "local-file" || Boolean(track.localFileId && fileIds.has(track.localFileId))),
  ).map((track) => [track.id, track]));
  const chosen: MusicTrack[] = [], seen = new Set<string>();
  const add = (trackId?: string) => {
    const track = trackId ? available.get(trackId) : undefined;
    if (track && !seen.has(track.id) && chosen.length < limit) { seen.add(track.id); chosen.push(track); }
  };
  events.filter((event) => event.actor === "character" && (event.type === "queue-add" || event.type === "track-change"))
    .sort((a, b) => b.createdAt - a.createdAt).forEach((event) => add(event.trackId));
  tracks.filter((track) => track.favorite).sort((a, b) => (b.lastPlayedAt ?? b.updatedAt) - (a.lastPlayedAt ?? a.updatedAt)).forEach((track) => add(track.id));
  tracks.filter((track) => track.lastPlayedAt).sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0)).forEach((track) => add(track.id));
  playlists.filter((playlist) => playlist.source === "local").sort((a, b) => b.updatedAt - a.updatedAt).forEach((playlist) => playlist.trackIds.forEach(add));
  tracks.sort((a, b) => b.importedAt - a.importedAt).forEach((track) => add(track.id));
  return chosen;
}

async function addEvent(session: ListeningSession, type: MusicEvent["type"], actor: MusicEvent["actor"], trackId?: string, detail?: string) {
  const stamp = now();
  await db.musicEvents.add({ id: uid(), schemaVersion: SCHEMA_VERSION, createdAt: stamp, updatedAt: stamp, sessionId: session.id, conversationId: session.conversationId, characterId: session.characterId, type, actor, trackId, positionMs: session.positionMs, detail });
}

function dispatchMusicAction(detail: Record<string, unknown>) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("mira:music-action", { detail }));
}

export async function syncListeningQueue(input: { sessionId: string; queue: string[]; currentIndex: number; actor: "user" | "character" | "system"; changedTrackId?: string; eventType?: "queue-add" | "queue-remove" }) {
  const session = await db.listeningSessions.get(input.sessionId);
  if (!session || session.state !== "active") return;
  const previous = normalizeListeningQueueEntries(session), used = new Set<number>(), stamp = now();
  const queueEntries = input.queue.map((trackId) => {
    const index = previous.findIndex((entry, entryIndex) => !used.has(entryIndex) && entry.trackId === trackId);
    if (index >= 0) { used.add(index); return previous[index]; }
    return { trackId, selectedBy: input.actor === "character" ? "character" as const : "user" as const, addedAt: stamp };
  });
  await db.listeningSessions.update(session.id, { queue: input.queue, queueEntries, currentIndex: Math.max(0, Math.min(input.currentIndex, Math.max(0, input.queue.length - 1))), updatedAt: stamp });
  if (input.eventType && input.changedTrackId) await addEvent({ ...session, queue: input.queue, queueEntries }, input.eventType, input.actor, input.changedTrackId);
  return db.listeningSessions.get(session.id);
}

export async function queueListeningTrack(sessionId: string, trackId: string, placement: "next" | "end", actor: "user" | "character" = "character") {
  const [session, track] = await Promise.all([db.listeningSessions.get(sessionId), db.musicTracks.get(trackId)]);
  if (!session || session.state !== "active") return { executed: false as const, reason: "一起听会话未激活" };
  if (!track) return { executed: false as const, reason: "歌曲不在音乐库中" };
  const queue = [...session.queue], entries = normalizeListeningQueueEntries(session);
  const at = placement === "next" ? Math.min(queue.length, session.currentIndex + 1) : queue.length;
  queue.splice(at, 0, trackId);
  entries.splice(at, 0, { trackId, selectedBy: actor, addedAt: now() });
  await db.listeningSessions.update(session.id, { queue, queueEntries: entries, updatedAt: now() });
  await addEvent({ ...session, queue, queueEntries: entries }, "queue-add", actor, trackId, placement === "next" ? "添加为下一首" : "添加到队尾");
  dispatchMusicAction({ type: "queue-track", trackId, placement, selectedBy: actor });
  if (!session.currentTrackId || !session.queue.length) {
    dispatchMusicAction({ type: "play", trackId, selectedBy: actor });
    await db.listeningSessions.update(session.id, { currentTrackId: trackId, currentIndex: queue.indexOf(trackId), selectedBy: actor, playbackState: "playing", positionMs: 0, updatedAt: now() });
    await addEvent(session, "track-change", actor, trackId, "开始播放角色点歌");
  }
  return { executed: true as const, track, session: await db.listeningSessions.get(session.id) };
}

function normalizeSearch(value: string) {
  return value.toLocaleLowerCase().replace(/[\s·・—_\-，,。.!！?？'"“”‘’()（）【】\[\]]+/g, "");
}
function uniqueHighConfidence(query: string, tracks: MusicTrack[]) {
  if (tracks.length === 1) return tracks[0];
  const wanted = normalizeSearch(query);
  const exact = tracks.filter((track) => {
    const title = normalizeSearch(track.title), full = normalizeSearch(track.title + track.artists.join(""));
    return title === wanted || full === wanted || (wanted.length >= 3 && (full.includes(wanted) || wanted.includes(full)));
  });
  return exact.length === 1 ? exact[0] : undefined;
}
async function gateway<T>(path: string): Promise<T> {
  if (PUBLIC_DEMO_MODE) throw publicDemoBackendError("音乐服务");
  const response = await fetch(MUSIC_API_BASE + path, { credentials: "include" });
  const raw = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(raw?.message ?? `音乐服务请求失败：${response.status}`));
  return raw as T;
}
async function rememberTemporaryTracks(tracks: MusicTrack[]) {
  const stamp = now(), existing = await db.musicTracks.bulkGet(tracks.map((track) => track.id));
  const stored = tracks.map((track, index) => ({
    ...track,
    schemaVersion: SCHEMA_VERSION,
    libraryStatus: existing[index]?.libraryStatus ?? ("temporary" as const),
    favorite: existing[index]?.favorite ?? track.favorite,
    createdAt: existing[index]?.createdAt ?? track.createdAt ?? stamp,
    updatedAt: stamp,
    importedAt: existing[index]?.importedAt ?? track.importedAt ?? stamp,
  }));
  await db.musicTracks.bulkPut(stored);
  if (typeof window !== "undefined") window.dispatchEvent(new Event("mira:music-library-changed"));
  return stored;
}

export async function createMusicSearchCandidateMessage(input: { session: ListeningSession; query: string; tracks: MusicTrack[]; placement: "next" | "end" }) {
  const tracks = await rememberTemporaryTracks(input.tracks.slice(0, 3)), stamp = now();
  const message: Message = {
    id: uid(), schemaVersion: SCHEMA_VERSION, createdAt: stamp, updatedAt: stamp,
    conversationId: input.session.conversationId, senderType: "character", senderId: input.session.characterId,
    content: `我找到了 ${tracks.length} 首“${input.query}”候选，请你选一首。`, kind: "music-search-candidates",
    attachments: [{ type: "music-search-candidates", sessionId: input.session.id, characterId: input.session.characterId, query: input.query, trackIds: tracks.map((track) => track.id), placement: input.placement, state: "pending" }],
    status: "complete", origin: "proactive",
  };
  await db.messages.add(message);
  await addEvent(input.session, "candidate-search", "character", undefined, input.query);
  await db.conversations.update(input.session.conversationId, { lastActivityAt: stamp, updatedAt: stamp });
  return message;
}

async function createMusicNotice(session: ListeningSession, text: string) {
  const stamp = now(), message: Message = { id: uid(), schemaVersion: SCHEMA_VERSION, createdAt: stamp, updatedAt: stamp, conversationId: session.conversationId, senderType: "system", content: text, kind: "music-event", attachments: [{ type: "music-event", sessionId: session.id, eventType: "candidate-search" }], status: "complete", origin: "proactive" };
  await db.messages.add(message); await db.conversations.update(session.conversationId, { lastActivityAt: stamp, updatedAt: stamp }); return message;
}

export async function searchTrackForCharacter(session: ListeningSession, character: Character, query: string, placement: "next" | "end") {
  const settings = characterDjSettings(character);
  if (!settings.allowNeteaseSearch) { const reason = "该角色的网易云搜索已关闭，将继续使用本地音乐库"; await createMusicNotice(session, reason); return { executed: false as const, reason }; }
  try {
    const capabilities = await gateway<{ authenticated: boolean; search: boolean; reasons?: { search?: string } }>("/capabilities");
    if (!capabilities.authenticated || !capabilities.search) { const reason = capabilities.reasons?.search || "当前网易云歌曲搜索不可用，将继续使用本地音乐库"; await createMusicNotice(session, reason); return { executed: false as const, reason }; }
    const result = await gateway<{ tracks: MusicTrack[]; total: number }>(`/search?q=${encodeURIComponent(query)}&offset=0&limit=5`);
    const tracks = await rememberTemporaryTracks(result.tracks.slice(0, 5)), exact = uniqueHighConfidence(query, tracks);
    if (exact) return queueListeningTrack(session.id, exact.id, placement, "character");
    if (tracks.length) return { executed: true as const, pendingSelection: true as const, message: await createMusicSearchCandidateMessage({ session, query, tracks, placement }) };
    const reason = "没有找到匹配的网易云歌曲，角色会继续从本地音乐库挑选"; await createMusicNotice(session, reason); return { executed: false as const, reason };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "网易云搜索失败"; await createMusicNotice(session, reason + "，将继续使用本地音乐库"); return { executed: false as const, reason };
  }
}

export async function selectMusicSearchCandidate(messageId: string, trackId: string) {
  const message = await db.messages.get(messageId), attachment = message?.attachments?.find((item) => item.type === "music-search-candidates");
  if (!message || !attachment || attachment.type !== "music-search-candidates" || attachment.state !== "pending" || !attachment.trackIds.includes(trackId)) return { executed: false as const, reason: "候选已失效" };
  const session = await db.listeningSessions.get(attachment.sessionId);
  if (!session || session.state !== "active" || session.characterId !== attachment.characterId) return { executed: false as const, reason: "一起听会话已结束" };
  const result = await queueListeningTrack(session.id, trackId, attachment.placement, "user");
  if (!result.executed) return result;
  const stamp = now();
  await db.messages.update(message.id, { updatedAt: stamp, attachments: message.attachments?.map((item) => item.type === "music-search-candidates" ? { ...item, state: "selected" as const, selectedTrackId: trackId, processedAt: stamp } : item) });
  return result;
}

export async function createMusicControlProposal(session: ListeningSession, control: "pause" | "next" | "clear-queue", reason: string) {
  const stamp = now(), message: Message = {
    id: uid(), schemaVersion: SCHEMA_VERSION, createdAt: stamp, updatedAt: stamp,
    conversationId: session.conversationId, senderType: "character", senderId: session.characterId,
    content: reason.trim() || "想调整一下播放。", kind: "music-control-proposal",
    attachments: [{ type: "music-control-proposal", sessionId: session.id, characterId: session.characterId, control, reason: reason.trim().slice(0, 240) || "想调整一下播放。", state: "pending" }],
    status: "complete", origin: "proactive",
  };
  await db.messages.add(message);
  await addEvent(session, "control-proposal", "character", session.currentTrackId, control);
  await db.conversations.update(session.conversationId, { lastActivityAt: stamp, updatedAt: stamp });
  return message;
}

export async function respondMusicControlProposal(messageId: string, accept: boolean) {
  const message = await db.messages.get(messageId), attachment = message?.attachments?.find((item) => item.type === "music-control-proposal");
  if (!message || !attachment || attachment.type !== "music-control-proposal" || attachment.state !== "pending") return { executed: false as const, reason: "请求已处理" };
  const session = await db.listeningSessions.get(attachment.sessionId);
  if (!session || session.state !== "active" || session.characterId !== attachment.characterId) return { executed: false as const, reason: "一起听会话已结束" };
  const stamp = now();
  await db.messages.update(message.id, { updatedAt: stamp, attachments: message.attachments?.map((item) => item.type === "music-control-proposal" ? { ...item, state: accept ? "accepted" as const : "declined" as const, processedAt: stamp } : item) });
  if (!accept) return { executed: true as const, accepted: false as const };
  dispatchMusicAction({ type: attachment.control });
  if (attachment.control === "pause") await db.listeningSessions.update(session.id, { playbackState: "paused", updatedAt: stamp });
  if (attachment.control === "clear-queue") await syncListeningQueue({ sessionId: session.id, queue: [], currentIndex: 0, actor: "user", changedTrackId: session.currentTrackId, eventType: "queue-remove" });
  return { executed: true as const, accepted: true as const };
}

export async function createListeningSummary(sessionId: string) {
  const session = await db.listeningSessions.get(sessionId);
  if (!session) return;
  if (session.summaryMessageId) return db.messages.get(session.summaryMessageId);
  const events = (await db.musicEvents.where("sessionId").equals(session.id).toArray()).sort((a, b) => a.createdAt - b.createdAt);
  const trackIds: string[] = [];
  for (const event of events) if (event.trackId && ["play", "track-change", "queue-add"].includes(event.type) && !trackIds.includes(event.trackId)) trackIds.push(event.trackId);
  if (!trackIds.length && session.currentTrackId) trackIds.push(session.currentTrackId);
  const listenedMs = session.totalListenedMs ?? Math.max(0, (session.endedAt ?? now()) - session.startedAt), representativeTrackId = trackIds[0], stamp = now();
  const message: Message = {
    id: uid(), schemaVersion: SCHEMA_VERSION, createdAt: stamp, updatedAt: stamp,
    conversationId: session.conversationId, senderType: "system",
    content: `一起听结束 · ${trackIds.length} 首歌 · ${Math.max(1, Math.round(listenedMs / 60000))} 分钟`, kind: "music-session-summary",
    attachments: [{ type: "music-session-summary", sessionId: session.id, characterId: session.characterId, trackIds, queueEntries: normalizeListeningQueueEntries(session), listenedMs, representativeTrackId }],
    status: "complete", origin: "proactive",
  };
  let created = false;
  await db.transaction("rw", [db.listeningSessions, db.messages, db.musicEvents, db.conversations], async () => {
    const fresh = await db.listeningSessions.get(session.id);
    if (!fresh || fresh.summaryMessageId) return;
    await db.messages.add(message);
    await db.listeningSessions.update(session.id, { summaryMessageId: message.id, updatedAt: stamp });
    await addEvent(session, "summary", "system", representativeTrackId, message.content);
    await db.conversations.update(session.conversationId, { lastActivityAt: stamp, updatedAt: stamp });
    created = true;
  });
  if (!created) { const fresh = await db.listeningSessions.get(session.id); return fresh?.summaryMessageId ? db.messages.get(fresh.summaryMessageId) : undefined; }
  await createMoodImprintForSession(session.id);
  if (trackIds.length >= 2 || listenedMs >= 10 * 60_000) {
    const island = await coupleIslandForConversation(session.conversationId, session.characterId);
    if (island?.status === "active") {
      const existing = await db.coupleIslandEntries.where("islandId").equals(island.id).filter((entry) => entry.sourceIds?.includes(session.id) ?? false).first();
      if (!existing) {
        const tracks = (await db.musicTracks.bulkGet(trackIds)).filter((track): track is MusicTrack => Boolean(track));
        await addIslandEntry({ islandId: island.id, kind: "memory", authorType: "both", title: "一起听的时光", text: `一起听了${tracks.map((track) => `《${track.title}》`).join("、") || `${trackIds.length} 首歌`}，陪伴了约 ${Math.max(1, Math.round(listenedMs / 60000))} 分钟。`, sourceIds: [session.id] });
      }
    }
  }
  await enqueueBackgroundTask({ type: "music-dj-turn", entityId: `music-summary:${session.id}`, characterId: session.characterId, conversationId: session.conversationId, eventId: `music-summary:${session.id}`, scheduledAt: stamp, payload: { sessionId: session.id, kind: "summary" } });
  if (typeof window !== "undefined") window.dispatchEvent(new Event("mira:proactive-check"));
  return message;
}

export async function scheduleMusicDjTurn(sessionId: string, trackId: string, positionMs: number) {
  const session = await db.listeningSessions.get(sessionId);
  if (!session || session.state !== "active" || session.currentTrackId !== trackId || positionMs < 20_000 || (session.djTurnCount ?? 0) >= 12) return;
  const character = await db.characters.get(session.characterId);
  if (!character) return;
  const settings = characterDjSettings(character);
  if (!settings.djEnabled && settings.commentaryLevel === "off" && !settings.moodRecallEnabled) return;
  if (settings.lastCommentTrackId === trackId || (settings.lastCommentAt && now() - settings.lastCommentAt < 120_000)) return;
  const task = await enqueueBackgroundTask({ type: "music-dj-turn", entityId: `music-dj:${session.id}:${trackId}`, characterId: session.characterId, conversationId: session.conversationId, eventId: `music-dj-turn:${session.id}:${trackId}`, scheduledAt: now(), payload: { sessionId: session.id, trackId, kind: "turn" } });
  if (typeof window !== "undefined") window.dispatchEvent(new Event("mira:proactive-check"));
  return task;
}

function parseJson(raw: string) {
  return JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")) as Record<string, unknown>;
}
async function updateCharacterMusicSettings(character: Character, patch: Partial<NonNullable<Character["chatSettings"]>["music"]>) {
  const music = { ...characterDjSettings(character), ...patch };
  await db.characters.update(character.id, { chatSettings: { ...character.chatSettings!, music } });
}

export async function runMusicDjTurn(sessionId: string, provider: ProviderSettings) {
  const session = await db.listeningSessions.get(sessionId);
  const character = session ? await db.characters.get(session.characterId) : undefined;
  if (!session || session.state !== "active" || session.playbackState !== "playing" || !character || (session.djTurnCount ?? 0) >= 12) return;
  const settings = characterDjSettings(character), track = session.currentTrackId ? await db.musicTracks.get(session.currentTrackId) : undefined;
  if (!track || settings.lastCommentTrackId === track.id || (settings.lastCommentAt && now() - settings.lastCommentAt < 120_000)) return;
  const candidates = await buildMusicDjCandidates(character.id), upcoming = Math.max(0, session.queue.length - session.currentIndex - 1);
  const moodImprint = settings.moodRecallEnabled ? await selectMoodImprintForRecall(session, track) : undefined;
  const recallInstruction = moodImprint ? `\n本轮命中了音乐专属心情印记。你必须自然提起下面真实内容中的一件事，不得增加未发生的细节，不要说“系统记录”或“心情印记”：\n${moodImprintContext(moodImprint, character)}` : "";
  const raw = await new OpenAIProvider({ ...provider, stream: false }).chat([
    { role: "system", content: `${localTimeContext({enabled:character.proactive.timeAware,label:"陪听当前时间"})}\n你是${character.name}。性格：${character.personality}。说话风格：${character.speakingStyle}。你正在陪用户听歌，只能根据真实歌曲回应，不编造。只返回严格 JSON：{"comment":"一句自然短评或空字符串","queueTrackId":"候选ID或空字符串","placement":"next|end"}。短评约20字且语义完整，最多拆成两个短气泡。${settings.commentaryLevel === "off" && !moodImprint ? "comment 必须为空。" : "每首最多评论一次。"}${!settings.djEnabled || !settings.canControlPlayback || upcoming > 1 ? "queueTrackId 必须为空。" : "可从候选中选择一首。"}${recallInstruction}` },
    { role: "user", content: `当前歌曲：${track.title} - ${track.artists.join(" / ")}，播放约 ${Math.floor(session.positionMs / 1000)} 秒。队列剩余 ${upcoming} 首。候选：\n${candidates.map((item) => `${item.id} | ${item.title} - ${item.artists.join(" / ")}`).join("\n") || "无"}` },
  ], { stream: false });
  const parsed = parseJson(raw), comment = typeof parsed.comment === "string" ? parsed.comment.trim() : "", queueTrackId = typeof parsed.queueTrackId === "string" ? parsed.queueTrackId : "", placement = parsed.placement === "end" ? "end" as const : "next" as const, stamp = now();
  if (comment) {
    const parts = normalizeReplyBubbles([{ content: comment }], { min: 1, max: 2, adaptive: true }).parts;
    const messages: Message[] = parts.map((part, index) => ({ id: uid(), schemaVersion: SCHEMA_VERSION, createdAt: stamp + index, updatedAt: stamp + index, conversationId: session.conversationId, senderType: "character", senderId: character.id, content: part.content, kind: "text", status: "complete", origin: "proactive" }));
    await db.messages.bulkAdd(messages);
    await addEvent(session, "comment", "character", track.id, comment.slice(0, 240));
    await db.conversations.update(session.conversationId, { lastActivityAt: stamp, updatedAt: stamp });
    if (moodImprint) await commitMoodImprintRecall(session, moodImprint, track, comment);
  }
  if (queueTrackId && upcoming <= 1 && candidates.some((item) => item.id === queueTrackId)) await queueListeningTrack(session.id, queueTrackId, placement, "character");
  await db.listeningSessions.update(session.id, { djTurnCount: (session.djTurnCount ?? 0) + 1, updatedAt: stamp });
  await updateCharacterMusicSettings(character, { lastCommentAt: stamp, lastCommentTrackId: track.id });
}
export async function runMusicSessionClosingNote(sessionId: string, provider: ProviderSettings) {
  const session = await db.listeningSessions.get(sessionId);
  if (!session?.summaryMessageId) return;
  const [message, character] = await Promise.all([db.messages.get(session.summaryMessageId), db.characters.get(session.characterId)]);
  if (!message || !character) return;
  const attachment = message.attachments?.find((item) => item.type === "music-session-summary");
  if (!attachment || attachment.type !== "music-session-summary" || attachment.closingNote) return;
  const tracks = (await db.musicTracks.bulkGet(attachment.trackIds)).filter((track): track is MusicTrack => Boolean(track));
  const imprint = session.moodImprint;
  const imprintFacts = imprint ? `\n真实聊天片段：\n${imprint.quotes.map((quote) => `${quote.senderType === "user" ? "用户" : character.name}：${quote.textSnapshot}`).join("\n")}` : "";
  const raw = await new OpenAIProvider({ ...provider, stream: false }).chat([
    { role: "system", content: `${localTimeContext({enabled:character.proactive.timeAware,label:"陪听当前时间"})}\n你是${character.name}。只能根据真实一起听记录输出严格 JSON：{"closingNote":"不超过40字的结束语","imprintSummary":"不超过60字的真实回忆摘要","moodTags":["1至3个标签"]}。标签只能选安心、心动、想念、治愈、平静、开心、温柔、释然、低落、热烈。不编造事件。没有聊天片段时 imprintSummary 为空、moodTags 为空。` },
    { role: "user", content: `歌曲：${tracks.map((track) => `${track.title}-${track.artists.join("/")}`).join("、") || "无"}；时长约${Math.max(1, Math.round(attachment.listenedMs / 60000))}分钟。${imprintFacts}` },
  ], { stream: false });
  let parsed: Record<string, unknown> = {};
  try { parsed = parseJson(raw); } catch { parsed = {}; }
  const fallback = raw.trim().replace(/^```|```$/g, ""), note = (typeof parsed.closingNote === "string" ? parsed.closingNote : fallback).trim().slice(0, 80);
  if (imprint) await enrichMoodImprint(session.id, typeof parsed.imprintSummary === "string" ? parsed.imprintSummary : undefined, parsed.moodTags);
  if (!note) return;
  await db.messages.update(message.id, { updatedAt: now(), attachments: message.attachments?.map((item) => item.type === "music-session-summary" ? { ...item, closingNote: note } : item) });
}
