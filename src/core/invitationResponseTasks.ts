import { db, getAppSettings } from "./db";
import { buildContext } from "./context";
import { buildListeningContext, listeningContextPrompt } from "./music";
import { buildCoupleIslandContext, coupleIslandContextPrompt, respondCoupleIslandInvitation } from "./coupleIsland";
import { buildOnlineCrossModeContinuity } from "./crossModeContinuity";
import { inferChatPresenceContext } from "./chatPresence";
import { forumInteropContextForChat } from "./forum";
import { resolveConversationProvider } from "./providerPresets";
import { autoTranslateCharacter, completedTranslation } from "./bilingual";
import { chatSettingsOf } from "./character";
import { createMessageInnerVoice, innerVoiceContinuityContext } from "./innerVoice";
import { replyBubbleCountPlanOf, parseStrictReplyTurn, type GeneratedReplyTurn } from "./replyBubbles";
import { parseStructuredJsonWithMeta } from "./structuredJson";
import { apiErrorInfoOf, createApiErrorInfo, OpenAIProvider, ProviderError, type ProviderChatResult } from "./provider";
import { now, SCHEMA_VERSION, uid, type BackgroundTask, type Character, type ChatProviderCallPurpose, type ChatProviderCallTrace, type InvitationDecision, type InvitationResponseTaskPayload, type Message, type ProviderSettings, type ReplyBubbleCountDiagnostics, type ReplyBubbleCountPlan } from "./types";
import { invitationResponseBubbleCountPlan, invitationResponseCardId } from "./invitationResponseTaskModel";
import { executeCharacterMusicAction } from "./music";

const LEASE_MS = 30_000;
const OWNER_ID = uid();
const MAX_CALLS = 2;

type InvitationTaskResult = { state: "completed" | "failed"; conversationId: string; taskId: string; outputMessageIds: string[]; error?: string };

type InvitationRoot = Record<string, unknown> & { d?: unknown };

function emit() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("mira:chat-reply-change"));
}
function payloadOf(task: BackgroundTask) { return task.payload as InvitationResponseTaskPayload; }
function owns(stored: BackgroundTask | undefined, task: BackgroundTask) {
  return Boolean(stored && stored.state === "running" && stored.leaseOwnerId === task.leaseOwnerId && stored.leaseGeneration === task.leaseGeneration);
}
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }
function decisionOf(value: unknown): InvitationDecision | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const row = value as Record<string, unknown>;
  if (row.type === "accept") return { type: "accept" };
  if (row.type === "decline" && typeof row.reason === "string" && row.reason.trim()) return { type: "decline", reason: row.reason.trim().slice(0, 120) };
}
function rootOf(response: ProviderChatResult): InvitationRoot {
  const parsed = parseStructuredJsonWithMeta(response.text, { transportMarkedIncomplete: response.truncated });
  if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) throw new ProviderError("format", "邀请回应 JSON 无法识别", "", createApiErrorInfo("format", { providerCode: response.truncated ? "truncated_json" : "invalid_invitation_decision", failureStage: "provider-parse", ...response }));
  return parsed.value as InvitationRoot;
}
function decisionFromRoot(root: InvitationRoot, forced?: InvitationDecision) {
  const decision = forced ?? decisionOf(root.d);
  if (!decision) throw new ProviderError("format", "邀请回应缺少有效的接受或拒绝决定", "", createApiErrorInfo("format", { providerCode: "invalid_invitation_decision", failureStage: "role-protocol" }));
  return decision;
}
function traceResult(ordinal: 1 | 2, purpose: ChatProviderCallPurpose, response: ProviderChatResult): ChatProviderCallTrace {
  return { ordinal, purpose, state: "completed", responseShape: response.responseShape, rawLength: response.rawLength, finishReason: response.finishReason, transportMode: response.transportMode, receivedChars: response.receivedChars, receivedBytes: response.receivedBytes, parseStatus: response.parseStatus, strictParseSucceeded: response.strictParseSucceeded, repairAttempted: response.repairAttempted, repairedParseSucceeded: response.repairedParseSucceeded, outerContainerClosed: response.outerContainerClosed, unterminatedString: response.unterminatedString, hasMessages: response.hasMessages, hasInnerVoice: response.hasInnerVoice, wireFormat: response.wireFormat, completeVisibleFieldRecovered: response.completeVisibleFieldRecovered };
}
async function reserve(task: BackgroundTask, purpose: ChatProviderCallPurpose) {
  let ordinal: 1 | 2 = 1;
  await db.transaction("rw", db.backgroundTasks, async () => {
    const stored = await db.backgroundTasks.get(task.id);
    if (!owns(stored, task)) throw new ProviderError("aborted", "邀请回应任务已被其他页面接管");
    const payload = payloadOf(stored!);
    if (payload.providerCallCount >= MAX_CALLS) throw new ProviderError("format", "邀请回应调用次数已用尽");
    ordinal = (payload.providerCallCount + 1) as 1 | 2;
    const trace: ChatProviderCallTrace = { ordinal, purpose, state: "started" };
    const next: InvitationResponseTaskPayload = { ...payload, phase: "deciding", providerCallCount: ordinal, providerCallTrace: [...payload.providerCallTrace, trace] };
    await db.backgroundTasks.update(task.id, { payload: next, leaseExpiresAt: now() + LEASE_MS, updatedAt: now() });
    task.payload = next;
  });
  return ordinal;
}
async function finish(task: BackgroundTask, ordinal: 1 | 2, response?: ProviderChatResult, error?: unknown) {
  await db.transaction("rw", db.backgroundTasks, async () => {
    const stored = await db.backgroundTasks.get(task.id);
    if (!owns(stored, task)) return;
    const payload = payloadOf(stored!);
    const traces = payload.providerCallTrace.map((trace) => trace.ordinal === ordinal && trace.state === "started" ? { ...trace, ...(response ? traceResult(ordinal, trace.purpose, response) : { state: error instanceof ProviderError && error.kind === "aborted" ? "aborted" as const : "failed" as const, errorKind: error instanceof ProviderError ? error.kind : "format", providerCode: apiErrorInfoOf(error)?.providerCode }) } : trace);
    const next = { ...payload, providerCallTrace: traces };
    await db.backgroundTasks.update(task.id, { payload: next, leaseExpiresAt: now() + LEASE_MS, updatedAt: now() });
    task.payload = next;
  });
}
async function recordInvitationCountDiagnostics(task: BackgroundTask, ordinal: 1 | 2, diagnostics: ReplyBubbleCountDiagnostics) {
  await db.transaction("rw", db.backgroundTasks, async () => {
    const stored = await db.backgroundTasks.get(task.id);
    if (!owns(stored, task)) return;
    const payload = payloadOf(stored!);
    const providerCallTrace = payload.providerCallTrace.map((trace) =>
      trace.ordinal === ordinal ? { ...trace, ...diagnostics } : trace,
    );
    const next: InvitationResponseTaskPayload = { ...payload, bubbleCountDiagnostics: diagnostics, providerCallTrace };
    await db.backgroundTasks.update(task.id, { payload: next, leaseExpiresAt: now() + LEASE_MS, updatedAt: now() });
    task.payload = next;
  });
}
function invitationCountError(diagnostics: ReplyBubbleCountDiagnostics, response: ProviderChatResult) {
  const message = diagnostics.countMode === "exact"
    ? `角色回复未达到已设置的精确 ${diagnostics.allowedMin} 条气泡`
    : `角色回复超出已设置的 ${diagnostics.allowedMin}–${diagnostics.allowedMax} 条范围，且无法在不改变内容的情况下安全调整`;
  return new ProviderError("format", message, "", createApiErrorInfo("format", {
    providerCode: "bubble_count_out_of_range",
    failureStage: "bubble-count",
    responseShape: response.responseShape,
    rawLength: response.rawLength,
    finishReason: response.finishReason,
    parseStatus: response.parseStatus,
    strictParseSucceeded: response.strictParseSucceeded,
    repairAttempted: response.repairAttempted,
    repairedParseSucceeded: response.repairedParseSucceeded,
    outerContainerClosed: response.outerContainerClosed,
    unterminatedString: response.unterminatedString,
    hasMessages: response.hasMessages,
    hasInnerVoice: response.hasInnerVoice,
    wireFormat: response.wireFormat,
    protocolValidationReached: true,
    transportMode: response.transportMode,
    receivedChars: response.receivedChars,
    receivedBytes: response.receivedBytes,
    tailKind: response.tailKind,
    ...diagnostics,
  }));
}
async function markFailed(task: BackgroundTask, error: unknown) {
  const apiError = apiErrorInfoOf(error) ?? createApiErrorInfo("format", { providerCode: "invalid_invitation_decision", failureStage: "role-protocol" });
  await db.transaction("rw", db.backgroundTasks, async () => {
    const stored = await db.backgroundTasks.get(task.id);
    if (!owns(stored, task)) return;
    const payload = payloadOf(stored!);
    await db.backgroundTasks.put({ ...stored!, payload: { ...payload, phase: "failed", lastApiError: apiError }, state: "failed", lastError: errorText(error), nextAttemptAt: Number.MAX_SAFE_INTEGER, leaseExpiresAt: undefined, leaseOwnerId: undefined, updatedAt: now() });
  });
  await markInvitationCardStatus(task, "failed", apiError.providerCode);
  emit();
}
async function markInvitationCardStatus(task: BackgroundTask, status: "queued" | "deciding" | "failed", code?: string) {
  const payload = payloadOf(task), message = await db.messages.get(payload.invitationMessageId);
  if (!message) return;
  const attachments = message.attachments?.map((attachment) => {
    if (payload.invitationType === "couple-island" && attachment.type === "couple-island-invitation" && attachment.cardRole !== "response") return { ...attachment, responseStatus: status, responseTaskEventId: task.eventId };
    if (payload.invitationType === "music" && attachment.type === "music-invitation" && attachment.cardRole !== "response") return { ...attachment, responseStatus: status, responseTaskEventId: task.eventId };
    return attachment;
  });
  await db.messages.update(message.id, { attachments, updatedAt: now() });
}
function bubbleCountPrompt(plan: ReplyBubbleCountPlan) {
  if (plan.mode === "exact") return `在 m 中返回恰好 ${plan.preferred} 条有意义的后续文字气泡。`;
  if (plan.mode === "range") return `在 m 中返回 ${plan.min}–${plan.max} 条有意义的后续文字气泡，建议接近 ${plan.preferred} 条，但不要为了凑数添加填充句。`;
  return `在 m 中自然返回 1–8 条有意义的后续文字气泡，建议接近 ${plan.preferred} 条，但偏好数量不是硬性要求。`;
}
function invitationPrompt(type: "couple-island" | "music", character: Character, countPlan: ReplyBubbleCountPlan, decisionRequired: boolean) {
  const decision = type === "couple-island" ? "茶侣岛" : "一起听";
  return [
    `这是一次${decision}邀请回应。你是${character.name}，只根据人物设定、关系和当前上下文作出自然决定。`,
    decisionRequired ? `必须在 d 中返回 {"type":"accept"} 或 {"type":"decline","reason":"简短自然的理由"}。` : `d 已由本地决定，仍需返回 d 字段并使用 {"type":"accept"}。`,
    bubbleCountPrompt(countPlan),
    "不要在气泡中重复卡片标题或接受/拒绝决定，不要为了数量添加重复句、编号或无意义语气词。",
    "m 中每一项就是一个完整聊天气泡；不要把单项中的完整句子按标点再次拆分。",
    "v 必须包含完整七段心声 s.p、s.e、s.u、s.d、s.r、s.a、s.x，以及连续情绪 q.e；所有字段都是简短非空字符串。",
    "只输出一个紧凑单行 JSON，不要 Markdown、代码围栏、解释或 JSON 之外的内容。",
    JSON.stringify({ d: { type: "accept" }, m: [{ c: "符合当前情境的文字", t: "必要译文" }], v: { s: { p: "身体此刻", e: "情绪与心理", u: "没说出口的话", d: "嘴硬与自我欺骗", r: "被触发的回忆", a: "天使的想法", x: "恶魔的想法" }, q: { e: "当前情绪" } } }),
  ].join(" ");
}
async function contextFor(task: BackgroundTask, conversation: import("./types").Conversation, character: Character, provider: ProviderSettings, settings: import("./types").AppSettings, messages: Message[]) {
  const payload = payloadOf(task), invitation = messages.find((message) => message.id === payload.invitationMessageId), history = messages.filter((message) => message.status === "complete" && (!invitation || message.createdAt <= invitation.createdAt));
  const userText = invitation?.content || "用户刚刚发来了邀请";
  const [loreBooks, memories, mediaAssets, meetSessions, forumContext] = await Promise.all([db.loreBooks.toArray(), db.memories.toArray(), db.mediaAssets.toArray(), db.meetSessions.where("conversationId").equals(conversation.id).toArray(), forumInteropContextForChat(character.id)]);
  const presence = inferChatPresenceContext({ conversation, actorId: character.id, messages: history, meetSessions });
  const crossModeContinuity = buildOnlineCrossModeContinuity({ conversation, actorId: character.id, meetSessions, names: { [character.id]: character.name } });
  const context = buildContext({ character, conversation, messages: history, loreBooks, memories, userText, settings, provider, mediaAssets, characters: [character], forumContext, scene: "private-chat", presence, crossModeContinuity, timeAt: new Date() });
  const continuity = innerVoiceContinuityContext(history, character.id);
  if (continuity) context.push({ role: "system", content: continuity });
  const listening = payload.invitationType === "music" ? await buildListeningContext(conversation.id) : undefined;
  const island = payload.invitationType === "couple-island" ? await buildCoupleIslandContext(conversation.id, character.id) : undefined;
  const extra = [payload.invitationType === "music" ? listeningContextPrompt(listening) : "", payload.invitationType === "couple-island" ? coupleIslandContextPrompt(island) : ""].filter(Boolean);
  context.push(...extra.map((content) => ({ role: "system" as const, content })));
  return { context, invitation, history, listening, island };
}
function messageRows(task: BackgroundTask, character: Character, provider: ProviderSettings, turn: GeneratedReplyTurn, base: number, roundId: string) {
  const payload = payloadOf(task), speakerTurnId = uid(), voice = turn.innerVoice ? createMessageInnerVoice({ draft: turn.innerVoice, actorType: "character", actorId: character.id, speakerTurnId, contents: turn.parts.map((part) => part.content), provider, createdAt: base }) : undefined;
  return turn.parts.map((part, index): Message => ({ id: uid(), schemaVersion: SCHEMA_VERSION, createdAt: base + index + 1, updatedAt: base + index + 1, conversationId: task.conversationId!, senderType: "character", senderId: character.id, content: part.content, translation: part.translation ? completedTranslation(part.content, part.translation, provider.model) : undefined, innerVoice: index === 0 ? voice : undefined, status: "complete", generation: { model: provider.model, temperature: provider.temperature, stream: false, roundId, speakerTurnId, segmentIndex: index, taskEventId: task.eventId, phase: "completed", attempt: task.attempts, startedAt: base, lastProgressAt: base + index + 1 } }));
}
async function saveText(task: BackgroundTask, character: Character, provider: ProviderSettings, turn: GeneratedReplyTurn, cardAt: number) {
  const rows = messageRows(task, character, provider, turn, cardAt, `invitation:${task.eventId}`);
  if (!rows.length) return [];
  await db.transaction("rw", [db.messages, db.conversations], async () => {
    await db.messages.bulkPut(rows);
    await db.conversations.update(task.conversationId!, { lastActivityAt: rows.at(-1)!.createdAt, updatedAt: rows.at(-1)!.createdAt });
  });
  return rows;
}
async function processInvitation(task: BackgroundTask, controller: AbortController): Promise<InvitationTaskResult> {
  const payload = payloadOf(task), conversation = task.conversationId ? await db.conversations.get(task.conversationId) : undefined, character = task.characterId ? await db.characters.get(task.characterId) : undefined;
  if (!conversation || !character) throw new Error("邀请回应缺少会话或角色");
  const settings = await getAppSettings(), resolved = await resolveConversationProvider(conversation, await (await import("./db")).getProvider()), provider = resolved.provider;
  const messages = await db.messages.where("conversationId").equals(conversation.id).sortBy("createdAt"), characterSettings = chatSettingsOf(character), bilingual = autoTranslateCharacter(character, conversation), { context, invitation, listening, island } = await contextFor(task, conversation, character, provider, settings, messages);
  if (!invitation) throw new Error("找不到待回应的邀请卡片");
  const strategyRequired = payload.invitationType === "couple-island" ? characterSettings.strategyMode.enabled : true;
  const forcedDecision: InvitationDecision | undefined = payload.invitationType === "couple-island" && !strategyRequired ? { type: "accept" } : undefined;
  const bubbleCountPlan = payload.bubbleCountPlan ?? replyBubbleCountPlanOf(character, context, "private", payload.targetBubbleCount);
  let decision: InvitationDecision | undefined;
  let turn: GeneratedReplyTurn | undefined;
  let textError: unknown;
  let lastError: unknown;
  const attempts = forcedDecision ? 1 : 2;
  for (let attempt = 0; attempt < attempts && (!decision || !turn); attempt++) {
    const ordinal = await reserve(task, attempt ? "regeneration" : "generation");
    try {
      const retryNote = attempt ? "上一次回应的决策或文字没有完整通过校验；从头生成完整 JSON，不要续写。" : "";
      const request = { role: "user" as const, content: invitationPrompt(payload.invitationType, character, bubbleCountPlan, Boolean(strategyRequired)) + " " + retryNote };
      const response = await new OpenAIProvider({ ...provider, stream: attempt === 1 }).chatWithMeta([...context, request], { stream: attempt === 1, signal: controller.signal, temperature: attempt ? 0.1 : provider.temperature, timeoutMs: null });
      await finish(task, ordinal, response);
      decision = decisionFromRoot(rootOf(response), decision ?? forcedDecision);
      try {
        const parsedTurn = parseStrictReplyTurn(response.text, bilingual, { min: bubbleCountPlan.min, max: bubbleCountPlan.max, adaptive: bubbleCountPlan.mode === "adaptive" }, true, response, bubbleCountPlan);
        if (parsedTurn.countDiagnostics) await recordInvitationCountDiagnostics(task, ordinal, parsedTurn.countDiagnostics);
        if (!parsedTurn.compliant) throw invitationCountError(parsedTurn.countDiagnostics!, response);
        turn = parsedTurn;
        textError = undefined;
      } catch (error) {
        textError = error;
      }
    } catch (error) {
      await finish(task, ordinal, undefined, error).catch(() => {});
      if (forcedDecision || decision) { decision = decision ?? forcedDecision; textError = error; }
      else lastError = error;
    }
  }
  if (!decision) { await markFailed(task, lastError ?? new ProviderError("format", "邀请回应未能完成")); return { state: "failed", conversationId: conversation.id, taskId: task.id, outputMessageIds: [], error: errorText(lastError) }; }
  let cardAt = now();
  if (payload.invitationType === "couple-island") await respondCoupleIslandInvitation(payload.invitationMessageId, decision.type === "accept" ? "accept" : "decline", decision.type === "decline" ? decision.reason : undefined);
  else await executeCharacterMusicAction({ conversationId: conversation.id, characterId: character.id, action: decision.type === "accept" ? { type: "accept-invite" } : { type: "decline-invite" } });
  cardAt = now();
  const responseId = invitationResponseCardId(payload.invitationType, payload.invitationMessageId), current = await db.backgroundTasks.get(task.id), nextPayload = { ...payloadOf(current ?? task), phase: "completed" as const, decision, cardSaved: true, textSaved: false, lastApiError: textError ? apiErrorInfoOf(textError) : undefined };
  await db.backgroundTasks.put({ ...(current ?? task), payload: nextPayload, state: "completed", leaseExpiresAt: undefined, leaseOwnerId: undefined, updatedAt: now() });
  let rows: Message[] = [];
  if (turn && !textError) {
    try { rows = await saveText(task, character, provider, turn, cardAt); await db.backgroundTasks.update(task.id, { payload: { ...nextPayload, textSaved: rows.length > 0 }, updatedAt: now() }); } catch { /* card success is independent of optional text persistence */ }
  }
  emit();
  return { state: "completed", conversationId: conversation.id, taskId: task.id, outputMessageIds: [responseId, ...rows.map((row) => row.id)] };
}

export async function processInvitationResponseTask(task: BackgroundTask, controller = new AbortController()): Promise<InvitationTaskResult> {
  const heartbeat = setInterval(() => {
    void db.transaction("rw", db.backgroundTasks, async () => {
      const stored = await db.backgroundTasks.get(task.id);
      if (owns(stored, task)) await db.backgroundTasks.update(task.id, { leaseExpiresAt: now() + LEASE_MS, updatedAt: now() });
    }).catch(() => undefined);
  }, 10_000);
  try { return await processInvitation(task, controller); }
  catch (error) {
    if (!(error instanceof ProviderError && error.kind === "aborted")) await markFailed(task, error);
    throw error;
  }
  finally { clearInterval(heartbeat); }
}
export async function retryInvitationResponse(eventId: string) {
  const task = await db.backgroundTasks.where("eventId").equals(eventId).first();
  if (!task || task.type !== "invitation-response") return;
  const payload = payloadOf(task);
  await db.backgroundTasks.update(task.id, { payload: { ...payload, phase: "queued", generationCycle: payload.generationCycle + 1, providerCallCount: 0, providerCallTrace: [], lastApiError: undefined }, state: "pending", nextAttemptAt: now(), lastError: undefined, updatedAt: now() });
  await markInvitationCardStatus(task, "queued");
  emit();
}
export async function invitationResponseDiagnostic(eventId: string) {
  const task = await db.backgroundTasks.where("eventId").equals(eventId).first();
  if (!task || task.type !== "invitation-response") return JSON.stringify({ feature: "invitation-response", stage: "task-not-found" }, null, 2);
  const payload = payloadOf(task);
  return JSON.stringify({ feature: "invitation-response", taskId: task.id, invitationType: payload.invitationType, invitationMessageId: payload.invitationMessageId, state: task.state, phase: payload.phase, generationCycle: payload.generationCycle, providerCallCount: payload.providerCallCount, providerCallTrace: payload.providerCallTrace, cardSaved: payload.cardSaved, textSaved: payload.textSaved, providerCode: payload.lastApiError?.providerCode, failureStage: payload.lastApiError?.failureStage }, null, 2);
}
export async function ensureInvitationResponseTaskForMessage(messageId: string, type: "couple-island" | "music") {
  const message = await db.messages.get(messageId), attachment = message?.attachments?.find((item): item is Extract<import("./types").MessageAttachment, { type: "music-invitation" } | { type: "couple-island-invitation" }> => item.type === (type === "music" ? "music-invitation" : "couple-island-invitation"));
  if (!message || !attachment || attachment.cardRole === "response" || attachment.state !== "pending") return;
  const characterId = attachment.characterId, character = await db.characters.get(characterId), conversation = await db.conversations.get(message.conversationId);
  if (!character || !conversation) return;
  const eventId = `invitation-response:${type}:${messageId}`, existing = await db.backgroundTasks.where("eventId").equals(eventId).first();
  if (existing) return existing;
  const history = await db.messages.where("conversationId").equals(message.conversationId).filter((row) => row.createdAt < message.createdAt).toArray();
  const bubbleCountPlan = invitationResponseBubbleCountPlan(character, history);
  const task: BackgroundTask = { id: uid(), schemaVersion: SCHEMA_VERSION, createdAt: now(), updatedAt: now(), type: "invitation-response", entityId: messageId, characterId, conversationId: message.conversationId, state: "pending", scheduledAt: now(), nextAttemptAt: now(), attempts: 0, eventId, payload: { invitationType: type, invitationMessageId: messageId, phase: "queued", generationCycle: 1, providerCallLimit: 2, providerCallCount: 0, providerCallTrace: [], targetBubbleCount: bubbleCountPlan.preferred, bubbleCountPlan } };
  await db.transaction("rw", [db.messages, db.backgroundTasks], async () => {
    if (await db.backgroundTasks.where("eventId").equals(eventId).first()) return;
    await db.messages.update(messageId, { attachments: message.attachments?.map((item) => item === attachment ? { ...item, responseStatus: "queued", responseTaskEventId: eventId } : item), updatedAt: now() });
    await db.backgroundTasks.add(task);
  });
  emit();
  return task;
}
async function retireLegacyInvitationTask(invitationMessageId: string, conversationId: string) {
  const tasks = await db.backgroundTasks.where("conversationId").equals(conversationId).filter((task) => {
    if (task.type !== "chat-reply" || task.state === "completed") return false;
    const payload = task.payload as { sourceMessageId?: unknown };
    return payload.sourceMessageId === invitationMessageId;
  }).toArray();
  for (const task of tasks) {
    const generated = await db.messages.where("conversationId").equals(conversationId).filter((message) => message.generation?.taskEventId === task.eventId && message.status !== "complete").toArray();
    await db.transaction("rw", [db.messages, db.backgroundTasks], async () => {
      if (generated.length) await db.messages.bulkDelete(generated.map((message) => message.id));
      const payload = task.payload as Record<string, unknown>;
      await db.backgroundTasks.put({
        ...task,
        payload: { ...payload, cancelled: true, phase: "completed" },
        state: "completed",
        leaseExpiresAt: undefined,
        leaseOwnerId: undefined,
        nextAttemptAt: Number.MAX_SAFE_INTEGER,
        updatedAt: now(),
      });
    });
  }
}
export async function recoverInvitationResponseTasks() {
  const messages = await db.messages.where("kind").anyOf("music-invitation", "couple-island-invitation").toArray();
  for (const message of messages) {
    const attachment = message.attachments?.find((item) => item.type === "music-invitation" || item.type === "couple-island-invitation");
    if (!attachment || message.senderType !== "user" || attachment.cardRole === "response") continue;
    await retireLegacyInvitationTask(message.id, message.conversationId);
    if (attachment.state === "pending") await ensureInvitationResponseTaskForMessage(message.id, attachment.type === "music-invitation" ? "music" : "couple-island");
  }
}
