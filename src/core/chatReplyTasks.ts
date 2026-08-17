import { dataLifecycleMutationActive } from "./dataLifecycle";
import { db, getAppSettings, getProvider } from "./db";
import { buildContext } from "./context";
import { buildListeningContext, executeCharacterMusicAction, listeningContextPrompt } from "./music";
import { buildCoupleIslandContext, coupleIslandContextPrompt, executeCharacterIslandAction, respondCoupleIslandInvitation, rewardIslandChat } from "./coupleIsland";
import {
  inferChatPresenceContext,
  type ChatPresenceContext,
} from "./chatPresence";
import { validateLocalCharacterReply } from "./replyValidation";
import { currentTimeFactReply, findCurrentTimeReplyContradiction } from "./localTime";
import { buildOnlineCrossModeContinuity } from "./crossModeContinuity";
import { selectMemories, recordMemoryAccess } from "./memory";
import { recallMemoriesWithEmbeddings } from "./embedding";
import { forumInteropContextForChat } from "./forum";
import { chatSettingsOf } from "./character";
import { canCharacterInteract } from "./conversationSettings";
import { conversationInnerVoiceEnabled, createMessageInnerVoice, innerVoiceContinuityContext, type GeneratedInnerVoice } from "./innerVoice";
import { reviewCharacterReply } from "./personaEngine";
import { resolveSecondaryProvider } from "./modelServices";
import {
  apiErrorInfoOf,
  createApiErrorInfo,
  OpenAIProvider,
  ProviderError,
  type ProviderChatInvoker,
  type ProviderChatResult,
} from "./provider";
import { groupActors, type GroupActor } from "./groupNpcs";
import {
  generateCharacterReplyTurn,
} from "./groupChat";
import { autoTranslateCharacter, completedTranslation } from "./bilingual";
import { maybeAttachCharacterVoice } from "./speech";
import {
  normalizeReplyBubbles,
  normalizeStrictReplyBubbles,
  replyBubbleCountPlanOf,
  replyBubbleRangeOf,
  type ReplyBubblePart,
} from "./replyBubbles";
import { decidePendingTransfer } from "./transfer";
import { maybeCreateCharacterCommerce } from "./mall";
import {
  evaluateStrategyInteraction,
  generateConfessionMessages,
  saveConfessionMessages,
} from "./relationshipStrategy";
import { maybeCreateMeetInvitation } from "./meetService";
import { notifyChatReplyCompleted } from "./notifications";
import { processInvitationResponseTask, invitationResponseDiagnostic, retryInvitationResponse, ensureInvitationResponseTaskForMessage } from "./invitationResponseTasks";
import { resolveConversationProvider } from "./providerPresets";
import {
  now,
  SCHEMA_VERSION,
  uid,
  type AppSettings,
  type BackgroundTask,
  type Character,
  type ChatGroupProviderCallBudget,
  type ChatProviderCallPurpose,
  type ChatProviderCallTrace,
  type ChatReplyTaskPayload,
  type ReplyBubbleCountDiagnostics,
  type ReplyBubbleCountPlan,
  type Conversation,
  type LoreBook,
  type MediaAsset,
  type Memory,
  type Message,
  type ProviderSettings,
  type RegenerationReason,
  type StickerItem,
} from "./types";

const CHAT_REPLY_LEASE_MS = 30_000;
const CHAT_PROVIDER_CALL_LIMIT = 2 as const;
const AUTO_RESUME_DELAY_MS = 2_000;
const CHAT_REPLY_OWNER_ID = uid();
const activeControllers = new Map<string, AbortController>();
export type ChatReplyGuidance = {
  reasons: RegenerationReason[];
  instruction: string;
};
export type EnqueueChatReplyInput = {
  conversationId: string;
  mode: "private" | "group";
  targetMessageId?: string;
  guidance?: ChatReplyGuidance;
  speakerOrder?: string[];
  startIndex?: number;
  roundId?: string;
};
export interface EnsureChatReplyTaskResult {
  task: BackgroundTask;
  placeholder: Message;
  action: "created" | "reused" | "requeued" | "recovered";
}
export interface ChatReplyProcessOutcome {
  state: "completed" | "retrying" | "failed";
  conversationId: string;
  taskId: string;
  outputMessageIds: string[];
  error?: string;
}
function emit() {
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event("mira:chat-reply-change"));
}
function taskPayload(task: BackgroundTask) {
  return task.payload as ChatReplyTaskPayload;
}
class ChatReplyLeaseLostError extends Error {
  constructor() {
    super("聊天回复任务已由其他页面接管");
    this.name = "ChatReplyLeaseLostError";
  }
}
function taskOwnsLease(stored: BackgroundTask | undefined, claimed: BackgroundTask) {
  return Boolean(
    stored &&
      stored.state === "running" &&
      stored.leaseOwnerId === claimed.leaseOwnerId &&
      stored.leaseGeneration === claimed.leaseGeneration,
  );
}
function taskOwnsExecution(
  stored: BackgroundTask | undefined,
  claimed: BackgroundTask,
  allowCompleted = false,
) {
  return Boolean(
    stored &&
      (stored.state === "running" || (allowCompleted && stored.state === "completed")) &&
      stored.leaseOwnerId === claimed.leaseOwnerId &&
      stored.leaseGeneration === claimed.leaseGeneration,
  );
}
async function assertTaskLease(task: BackgroundTask) {
  const stored = await db.backgroundTasks.get(task.id);
  if (!taskOwnsLease(stored, task)) throw new ChatReplyLeaseLostError();
  return stored!;
}
function providerBudgetError(actorId?: string) {
  return new ProviderError(
    "format",
    actorId
      ? "该群聊角色本轮模型调用已达到两次上限，请手动重试该角色回复"
      : "本轮模型调用已达到两次上限，请手动重试新一轮生成",
    "",
    createApiErrorInfo("format", { providerCode: "call_budget_exhausted" }),
  );
}
function groupBudgetOf(
  payload: ChatReplyTaskPayload,
  actorId: string,
): ChatGroupProviderCallBudget {
  const current = payload.groupProviderCallBudgets?.[actorId];
  if (current) return current;
  const legacyCount = payload.groupProviderCallBudgets
    ? 0
    : Math.min(payload.providerCallCount ?? 0, CHAT_PROVIDER_CALL_LIMIT);
  return {
    providerCallLimit: CHAT_PROVIDER_CALL_LIMIT,
    providerCallCount: legacyCount,
    providerCallTrace: legacyCount ? (payload.providerCallTrace ?? []) : [],
    state: "pending",
  };
}
function validPersistedBubbleCountPlan(value: unknown): value is ReplyBubbleCountPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const plan = value as Partial<ReplyBubbleCountPlan>;
  return (plan.mode === "adaptive" || plan.mode === "range" || plan.mode === "exact") &&
    Number.isInteger(plan.min) && Number.isInteger(plan.max) && Number.isInteger(plan.preferred) &&
    Number(plan.min) >= 1 && Number(plan.max) <= 8 && Number(plan.min) <= Number(plan.max) &&
    Number(plan.preferred) >= Number(plan.min) && Number(plan.preferred) <= Number(plan.max);
}

async function ensurePersistedBubbleCountPlan(
  task: BackgroundTask,
  character: Character,
  context: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  scene: "private" | "group",
  actorId?: string,
) {
  const initialPayload = taskPayload(task);
  const existingPlan = actorId
    ? initialPayload.bubbleCountPlans?.[actorId]
    : initialPayload.bubbleCountPlan;
  if (validPersistedBubbleCountPlan(existingPlan)) return existingPlan;
  const legacyTarget = actorId
    ? initialPayload.targetBubbleCounts?.[actorId]
    : initialPayload.targetBubbleCount;
  const selected = replyBubbleCountPlanOf(character, context, scene, legacyTarget);
  let countPlan = selected;
  await db.transaction("rw", db.backgroundTasks, async () => {
    const stored = await db.backgroundTasks.get(task.id);
    if (!taskOwnsLease(stored, task)) throw new ChatReplyLeaseLostError();
    const payload = taskPayload(stored!);
    const storedPlan = actorId
      ? payload.bubbleCountPlans?.[actorId]
      : payload.bubbleCountPlan;
    const storedTarget = actorId
      ? payload.targetBubbleCounts?.[actorId]
      : payload.targetBubbleCount;
    countPlan = validPersistedBubbleCountPlan(storedPlan)
      ? storedPlan
      : replyBubbleCountPlanOf(character, context, scene, storedTarget ?? selected.preferred);
    const nextPayload: ChatReplyTaskPayload = actorId
      ? {
          ...payload,
          targetBubbleCounts: {
            ...(payload.targetBubbleCounts ?? {}),
            [actorId]: countPlan.preferred,
          },
          bubbleCountPlans: {
            ...(payload.bubbleCountPlans ?? {}),
            [actorId]: countPlan,
          },
        }
      : {
          ...payload,
          targetBubbleCount: countPlan.preferred,
          bubbleCountPlan: countPlan,
        };
    await db.backgroundTasks.update(task.id, { payload: nextPayload, updatedAt: now() });
    task.payload = nextPayload;
  });
  return countPlan;
}

async function reserveProviderCall(
  task: BackgroundTask,
  purpose: ChatProviderCallPurpose,
  allowCompleted = false,
  actorId?: string,
) {
  let ordinal: 1 | 2 | undefined;
  await db.transaction("rw", db.backgroundTasks, async () => {
    const stored = await db.backgroundTasks.get(task.id);
    if (!taskOwnsExecution(stored, task, allowCompleted))
      throw new ChatReplyLeaseLostError();
    const payload = taskPayload(stored!);
    if (payload.mode === "group") {
      if (!actorId)
        throw new ProviderError(
          "format",
          "群聊模型调用缺少角色预算标识",
          "",
          createApiErrorInfo("format", { providerCode: "missing_group_call_scope" }),
        );
      const budget = groupBudgetOf(payload, actorId);
      if (budget.providerCallCount >= budget.providerCallLimit)
        throw providerBudgetError(actorId);
      ordinal = (budget.providerCallCount + 1) as 1 | 2;
      const nextBudget: ChatGroupProviderCallBudget = {
        ...budget,
        providerCallLimit: CHAT_PROVIDER_CALL_LIMIT,
        providerCallCount: ordinal,
        providerCallTrace: [
          ...budget.providerCallTrace,
          { ordinal, purpose, state: "started" as const },
        ].slice(-CHAT_PROVIDER_CALL_LIMIT),
        leaseGeneration: stored!.leaseGeneration,
        state: "running",
      };
      const nextPayload: ChatReplyTaskPayload = {
        ...payload,
        groupProviderCallBudgets: {
          ...(payload.groupProviderCallBudgets ?? {}),
          [actorId]: nextBudget,
        },
      };
      await db.backgroundTasks.update(task.id, { payload: nextPayload, updatedAt: now() });
      task.payload = nextPayload;
      return;
    }
    const count = payload.providerCallCount ?? 0;
    if (count >= (payload.providerCallLimit ?? CHAT_PROVIDER_CALL_LIMIT))
      throw providerBudgetError();
    ordinal = (count + 1) as 1 | 2;
    const trace: ChatProviderCallTrace[] = [
      ...(payload.providerCallTrace ?? []),
      { ordinal, purpose, state: "started" as const },
    ].slice(-CHAT_PROVIDER_CALL_LIMIT);
    const nextPayload: ChatReplyTaskPayload = {
      ...payload,
      providerCallLimit: CHAT_PROVIDER_CALL_LIMIT,
      providerCallCount: ordinal,
      providerCallTrace: trace,
    };
    await db.backgroundTasks.update(task.id, { payload: nextPayload, updatedAt: now() });
    task.payload = nextPayload;
  });
  if (!ordinal) throw providerBudgetError(actorId);
  return ordinal;
}
async function finishProviderCall(
  task: BackgroundTask,
  ordinal: 1 | 2,
  result: ProviderChatResult | undefined,
  error?: unknown,
  allowCompleted = false,
  actorId?: string,
) {
  await db.transaction("rw", db.backgroundTasks, async () => {
    const stored = await db.backgroundTasks.get(task.id);
    if (!taskOwnsExecution(stored, task, allowCompleted))
      throw new ChatReplyLeaseLostError();
    const payload = taskPayload(stored!);
    const finishTrace = (trace: ChatProviderCallTrace[]) =>
      trace.map((entry) =>
        entry.ordinal !== ordinal
          ? entry
          : {
              ...entry,
              state: error
                ? error instanceof ProviderError && error.kind === "aborted"
                  ? "aborted"
                  : "failed"
                : "completed",
              responseShape: result?.responseShape ?? (error instanceof ProviderError ? error.apiError?.responseShape : undefined),
              rawLength: result?.rawLength ?? (error instanceof ProviderError ? error.apiError?.rawLength : undefined),
              finishReason: result?.finishReason ?? (error instanceof ProviderError ? error.apiError?.finishReason : undefined),
              errorKind: error instanceof ProviderError ? error.kind : error ? "unknown" : undefined,
              providerCode: error instanceof ProviderError ? error.apiError?.providerCode : undefined,
              transportMode: result?.transportMode ?? (error instanceof ProviderError ? error.apiError?.transportMode : undefined),
              receivedChars: result?.receivedChars ?? (error instanceof ProviderError ? error.apiError?.receivedChars : undefined),
              receivedBytes: result?.receivedBytes ?? (error instanceof ProviderError ? error.apiError?.receivedBytes : undefined),
              declaredContentLength: result?.declaredContentLength ?? (error instanceof ProviderError ? error.apiError?.declaredContentLength : undefined),
              contentLengthMatched: result?.contentLengthMatched ?? (error instanceof ProviderError ? error.apiError?.contentLengthMatched : undefined),
              parseStatus: result?.parseStatus ?? (error instanceof ProviderError ? error.apiError?.parseStatus : undefined),
              strictParseSucceeded: result?.strictParseSucceeded ?? (error instanceof ProviderError ? error.apiError?.strictParseSucceeded : undefined),
              repairAttempted: result?.repairAttempted ?? (error instanceof ProviderError ? error.apiError?.repairAttempted : undefined),
              repairedParseSucceeded: result?.repairedParseSucceeded ?? (error instanceof ProviderError ? error.apiError?.repairedParseSucceeded : undefined),
              outerContainerClosed: result?.outerContainerClosed ?? (error instanceof ProviderError ? error.apiError?.outerContainerClosed : undefined),
              unterminatedString: result?.unterminatedString ?? (error instanceof ProviderError ? error.apiError?.unterminatedString : undefined),
              hasMessages: result?.hasMessages ?? (error instanceof ProviderError ? error.apiError?.hasMessages : undefined),
              hasInnerVoice: result?.hasInnerVoice ?? (error instanceof ProviderError ? error.apiError?.hasInnerVoice : undefined),
              wireFormat: result?.wireFormat ?? (error instanceof ProviderError ? error.apiError?.wireFormat : undefined),
              protocolValidationReached: result?.protocolValidationReached ?? (error instanceof ProviderError ? error.apiError?.protocolValidationReached : undefined),
              completeVisibleFieldRecovered: result?.completeVisibleFieldRecovered ?? (error instanceof ProviderError ? error.apiError?.completeVisibleFieldRecovered : undefined),
              tailKind: result?.tailKind ?? (error instanceof ProviderError ? error.apiError?.tailKind : undefined),
              failureStage: error instanceof ProviderError ? error.apiError?.failureStage : undefined,
            },
      ) satisfies ChatProviderCallTrace[];
    let nextPayload: ChatReplyTaskPayload;
    if (payload.mode === "group") {
      if (!actorId) throw new ChatReplyLeaseLostError();
      const budget = groupBudgetOf(payload, actorId);
      nextPayload = {
        ...payload,
        groupProviderCallBudgets: {
          ...(payload.groupProviderCallBudgets ?? {}),
          [actorId]: {
            ...budget,
            providerCallTrace: finishTrace(budget.providerCallTrace),
            leaseGeneration: stored!.leaseGeneration,
          },
        },
      };
    } else {
      nextPayload = {
        ...payload,
        providerCallTrace: finishTrace(payload.providerCallTrace ?? []),
      };
    }
    await db.backgroundTasks.update(task.id, { payload: nextPayload, updatedAt: now() });
    task.payload = nextPayload;
  });
}
async function recordBubbleCountValidation(
  task: BackgroundTask,
  ordinal: 1 | 2,
  diagnostics: ReplyBubbleCountDiagnostics,
  actorId?: string,
) {
  await db.transaction("rw", db.backgroundTasks, async () => {
    const stored = await db.backgroundTasks.get(task.id);
    if (!taskOwnsLease(stored, task)) return;
    const payload = taskPayload(stored!);
    let nextPayload: ChatReplyTaskPayload;
    if (payload.mode === "group" && actorId) {
      const budget = groupBudgetOf(payload, actorId);
      nextPayload = {
        ...payload,
        groupProviderCallBudgets: {
          ...(payload.groupProviderCallBudgets ?? {}),
          [actorId]: {
            ...budget,
            providerCallTrace: budget.providerCallTrace.map((trace) =>
              trace.ordinal === ordinal ? { ...trace, ...diagnostics } : trace,
            ),
          },
        },
        bubbleCountDiagnosticsByActor: {
          ...(payload.bubbleCountDiagnosticsByActor ?? {}),
          [actorId]: diagnostics,
        },
      };
    } else {
      nextPayload = {
        ...payload,
        providerCallTrace: (payload.providerCallTrace ?? []).map((trace) =>
          trace.ordinal === ordinal ? { ...trace, ...diagnostics } : trace,
        ),
        bubbleCountDiagnostics: diagnostics,
      };
    }
    await db.backgroundTasks.update(task.id, { payload: nextPayload, updatedAt: now() });
    task.payload = nextPayload;
  });
}

function providerInvokerForTask(
  task: BackgroundTask,
  allowCompleted = false,
  actorId?: string,
): ProviderChatInvoker {
  return async (settings, messages, options, purpose) => {
    const ordinal = await reserveProviderCall(task, purpose, allowCompleted, actorId);
    let result: ProviderChatResult;
    try {
      result = await new OpenAIProvider(settings).chatWithMeta(messages, {
        ...options,
        timeoutMs: null,
      });
    } catch (error) {
      await finishProviderCall(task, ordinal, undefined, error, allowCompleted, actorId).catch(() => {});
      throw error;
    }
    // Once the provider call is recorded as completed, a phase/store refresh failure
    // must not rewrite that completed call as failed or trigger another API request.
    await finishProviderCall(task, ordinal, result, undefined, allowCompleted, actorId);
    if (!allowCompleted) await updatePhase(task, "parsing");
    return result;
  };
}
function isStickerMessage(message: Message | undefined) {
  return Boolean(
    message &&
      (message.kind === "sticker" ||
        (message.attachments?.length === 1 &&
          message.attachments[0]?.type === "sticker")),
  );
}
async function availableReplyStickers(
  conversation: Conversation,
  speakerId: string,
  history: Message[],
) {
  const settings = conversation.chatSettings;
  if (!settings?.permissions?.proactiveSticker) return [] as StickerItem[];
  const packIds = [...new Set(settings.proactiveStickerPackIds ?? [])];
  if (!packIds.length) return [] as StickerItem[];
  const previousSpeakerMessage = [...history]
    .reverse()
    .find(
      (message) =>
        message.senderId === speakerId &&
        (message.senderType === "character" || message.senderType === "npc"),
    );
  if (isStickerMessage(previousSpeakerMessage)) return [] as StickerItem[];
  const packs = await db.stickerPacks.bulkGet(packIds);
  const stickers = packs
    .filter(Boolean)
    .flatMap((pack) => pack!.stickers)
    .filter(
      (sticker, index, list) =>
        list.findIndex((candidate) => candidate.id === sticker.id) === index,
    );
  return stickers;
}
function replyStickerMessage(input: {
  conversationId: string;
  senderType: "character" | "npc";
  senderId: string;
  sticker: StickerItem;
  createdAt: number;
  provider: ProviderSettings;
  task: BackgroundTask;
  roundId?: string;
  speakerTurnId: string;
  segmentIndex: number;
}): Message {
  const { sticker, task } = input;
  return {
    id: uid(),
    schemaVersion: SCHEMA_VERSION,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    conversationId: input.conversationId,
    senderType: input.senderType,
    senderId: input.senderId,
    content: "[表情包]",
    kind: "sticker",
    attachments: [
      {
        type: "sticker",
        stickerId: sticker.id,
        assetId: sticker.assetId,
        url: sticker.url,
        name: sticker.name,
        description: sticker.description || sticker.name,
      },
    ],
    status: "complete",
    generation: {
      model: input.provider.model,
      temperature: input.provider.temperature,
      stream: false,
      roundId: input.roundId,
      speakerTurnId: input.speakerTurnId,
      segmentIndex: input.segmentIndex,
      taskEventId: task.eventId,
      phase: "completed",
      attempt: task.attempts,
      lastProgressAt: input.createdAt,
    },
  };
}
function retryable(error: unknown) {
  return (
    error instanceof ProviderError &&
    ["timeout", "network", "cors", "interrupted", "server"].includes(error.kind)
  );
}
function errorText(error: unknown) {
  return error instanceof ProviderError
    ? error.message
    : error instanceof Error
      ? error.message
      : "\u56de\u590d\u751f\u6210\u5931\u8d25";
}
async function unfinishedTask(conversationId: string) {
  return db.backgroundTasks
    .where("conversationId")
    .equals(conversationId)
    .filter((task) => (task.type === "chat-reply" || task.type === "invitation-response") && task.state !== "completed")
    .first();
}
export async function chatReplyTaskForConversation(conversationId: string) {
  return unfinishedTask(conversationId);
}
function validReplyTaskPayload(value: unknown): value is ChatReplyTaskPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<ChatReplyTaskPayload>;
  return (
    (payload.mode === "private" || payload.mode === "group") &&
    typeof payload.outputMessageId === "string" &&
    Boolean(payload.outputMessageId) &&
    typeof payload.phase === "string"
  );
}
async function retireBrokenTask(task: BackgroundTask, payload?: ChatReplyTaskPayload) {
  const generated = await db.messages
    .where("conversationId")
    .equals(task.conversationId ?? "")
    .filter((message) => message.generation?.taskEventId === task.eventId)
    .toArray();
  const unfinished = generated.filter((message) => message.status !== "complete");
  if (unfinished.length) await db.messages.bulkDelete(unfinished.map((message) => message.id));
  if (payload?.originalMessages?.length) await db.messages.bulkPut(payload.originalMessages);
  else if (payload?.originalMessage) await db.messages.put(payload.originalMessage);
  await db.backgroundTasks.put({
    ...task,
    payload: { ...(validReplyTaskPayload(task.payload) ? task.payload : {}), cancelled: true },
    state: "completed",
    leaseExpiresAt: undefined,
    updatedAt: now(),
  });
}

export async function ensureRunnableChatReplyTask(
  input: EnqueueChatReplyInput,
): Promise<EnsureChatReplyTaskResult> {
  const [conversation, globalProvider] = await Promise.all([
    db.conversations.get(input.conversationId),
    getProvider(),
  ]);
  if (!conversation) throw new Error("\u4f1a\u8bdd\u4e0d\u5b58\u5728");
  const characters = (
      await db.characters.bulkGet(conversation.memberIds)
    ).filter((character): character is Character => Boolean(character)),
    npcAssetIds = (conversation.groupNpcs ?? [])
      .map((npc) => npc.avatarAssetId)
      .filter((id): id is string => Boolean(id)),
    assets = (await db.mediaAssets.bulkGet(npcAssetIds)).filter(
      (asset): asset is MediaAsset => Boolean(asset),
    ),
    actors = groupActors(conversation, characters, assets),
    privateCharacter = characters[0],
    resolvedProvider = await resolveConversationProvider(
      conversation,
      globalProvider,
    ),
    provider = resolvedProvider.provider,
    innerVoiceRequired =
      input.mode === "private" || conversationInnerVoiceEnabled(conversation);
  if (
    input.mode === "private" &&
    (!privateCharacter || !canCharacterInteract(privateCharacter))
  )
    throw new Error("\u5f53\u524d\u89d2\u8272\u4e0d\u53ef\u56de\u590d");
  if (input.mode === "group" && !actors.length)
    throw new Error("\u7fa4\u804a\u6ca1\u6709\u53ef\u56de\u590d\u6210\u5458");
  const messages = await db.messages
      .where("conversationId")
      .equals(conversation.id)
      .sortBy("createdAt"),
    target = input.targetMessageId
      ? messages.find((message) => message.id === input.targetMessageId)
      : undefined,
    originalMessages = target?.generation?.speakerTurnId
      ? messages
          .filter(
            (message) =>
              message.generation?.speakerTurnId ===
              target.generation?.speakerTurnId,
          )
          .sort((x, y) => x.createdAt - y.createdAt)
      : undefined,
    original = originalMessages?.[0] ?? target,
    sourcePool = original
      ? messages.filter((message) => message.createdAt < original.createdAt)
      : messages,
    source = [...sourcePool]
      .reverse()
      .find(
        (message) =>
          message.senderType === "user" && message.status === "complete",
      ),
    t = now(),
    outputMessageId = original?.id ?? uid(),
    eventId = "chat-reply:" + conversation.id + ":" + outputMessageId,
    taskId = uid(),
    requestedSpeakerId =
      input.mode === "group" && target?.senderId ? target.senderId : undefined,
    speakerOrder = input.speakerOrder?.length
      ? input.speakerOrder
      : input.mode === "group"
        ? requestedSpeakerId
          ? [requestedSpeakerId]
          : actors.map((actor) => actor.id)
        : undefined,
    sender =
      input.mode === "private"
        ? privateCharacter!
        : (actors.find(
            (actor) => actor.id === speakerOrder?.[input.startIndex ?? 0],
          )?.character ?? actors[0].character);
  const bubbleContext = sourcePool.map((message) => ({
    role: (message.senderType === "user" ? "user" : "assistant") as "user" | "assistant",
    content: message.content,
  }));
  const bubbleCountPlan = input.mode === "private"
    ? replyBubbleCountPlanOf(sender, bubbleContext, "private")
    : undefined;
  const bubbleCountPlans = input.mode === "group"
    ? Object.fromEntries(
        (speakerOrder ?? []).flatMap((speakerId) => {
          const actor = actors.find((item) => item.id === speakerId);
          return actor
            ? [[speakerId, replyBubbleCountPlanOf(actor.character, bubbleContext, "group")]]
            : [];
        }),
      )
    : undefined;
  const targetBubbleCount = bubbleCountPlan?.preferred;
  const targetBubbleCounts = bubbleCountPlans
    ? Object.fromEntries(Object.entries(bubbleCountPlans).map(([speakerId, plan]) => [speakerId, plan.preferred]))
    : undefined;
  const generation = {
    model: provider.model,
    temperature: provider.temperature,
    stream: false,
    taskEventId: eventId,
    phase: "queued" as const,
    attempt: 0,
    startedAt: t,
    lastProgressAt: t,
  };
  const placeholder: Message = original
    ? {
        ...original,
        id: outputMessageId,
        senderType:
          input.mode === "group"
            ? (actors.find((actor) => actor.id === sender.id)?.type ??
              "character")
            : "character",
        senderId: sender.id,
        content: "",
        translation: undefined,
        innerVoice: undefined,
        kind: original.kind === "voice" ? "text" : original.kind,
        attachments: (original.attachments ?? []).filter(
          (attachment) => attachment.type !== "voice",
        ),
        status: "generating",
        updatedAt: t,
        generation,
      }
    : {
        id: outputMessageId,
        schemaVersion: SCHEMA_VERSION,
        createdAt: t,
        updatedAt: t,
        conversationId: conversation.id,
        senderType:
          input.mode === "group"
            ? (actors.find((actor) => actor.id === sender.id)?.type ??
              "character")
            : "character",
        senderId: sender.id,
        content: "",
        status: "generating",
        generation,
      };
  const payload: ChatReplyTaskPayload = {
    mode: input.mode,
    outputMessageId,
    sourceMessageId: source?.id,
    regenerationTargetId: target?.id,
    regenerationReasons: input.guidance?.reasons,
    regenerationInstruction: input.guidance?.instruction,
    roundId: input.roundId ?? (input.mode === "group" ? uid() : undefined),
    speakerOrder,
    nextSpeakerIndex: input.startIndex ?? 0,
    providerPresetId: resolvedProvider.presetId ?? "",
    innerVoiceRequired,
    phase: "queued",
    autoResumeCount: 0,
    generationCycle: 1,
    providerCallLimit: CHAT_PROVIDER_CALL_LIMIT,
    providerCallCount: 0,
    providerCallTrace: [],
    targetBubbleCount,
    targetBubbleCounts,
    bubbleCountPlan,
    bubbleCountPlans,
    groupProviderCallBudgets: input.mode === "group" ? {} : undefined,
    originalMessage: target && !originalMessages ? { ...target } : undefined,
    originalMessages: originalMessages?.map((message) => ({ ...message })),
  };
  const task: BackgroundTask = {
    id: taskId,
    schemaVersion: SCHEMA_VERSION,
    createdAt: t,
    updatedAt: t,
    type: "chat-reply",
    entityId: outputMessageId,
    characterId: sender.id,
    conversationId: conversation.id,
    state: "pending",
    scheduledAt: t,
    nextAttemptAt: t,
    attempts: 0,
    eventId,
    payload,
  };
  let ensured: EnsureChatReplyTaskResult | undefined;
  await db.transaction(
    "rw",
    [db.messages, db.backgroundTasks, db.conversations],
    async () => {
      const existingRows = await db.backgroundTasks
        .where("conversationId")
        .equals(input.conversationId)
        .filter((row) => row.type === "chat-reply" && row.state !== "completed")
        .toArray();
      const ranked = existingRows.sort((a, b) => {
        const rank = (row: BackgroundTask) =>
          row.state === "running" && (row.leaseExpiresAt ?? 0) > t
            ? 0
            : row.state === "pending"
              ? 1
              : row.state === "running"
                ? 2
                : 3;
        return rank(a) - rank(b) || b.updatedAt - a.updatedAt;
      });
      for (const existing of ranked) {
        const existingPayload = validReplyTaskPayload(existing.payload)
          ? existing.payload
          : undefined;
        const existingPlaceholder = existingPayload?.outputMessageId
          ? await db.messages.get(existingPayload.outputMessageId)
          : undefined;
        if (!ensured && existingPayload && existingPlaceholder && !existingPayload.cancelled) {
          const activeLease =
            existing.state === "running" && (existing.leaseExpiresAt ?? 0) > t;
          const shouldRequeue = existing.state === "failed" ||
            (existing.state === "running" && !activeLease) ||
            existing.nextAttemptAt > t;
          const startsNewCycle = existing.state === "failed";
          const nextPayload: ChatReplyTaskPayload = {
            ...existingPayload,
            phase: activeLease ? existingPayload.phase : "queued",
            cancelled: false,
            lastApiError: startsNewCycle ? undefined : existingPayload.lastApiError,
            generationCycle: startsNewCycle
              ? (existingPayload.generationCycle ?? 1) + 1
              : (existingPayload.generationCycle ?? 1),
            providerCallLimit: CHAT_PROVIDER_CALL_LIMIT,
            providerCallCount: startsNewCycle
              ? 0
              : (existingPayload.providerCallCount ?? 0),
            providerCallTrace: startsNewCycle
              ? []
              : (existingPayload.providerCallTrace ?? []),
            groupProviderCallBudgets: startsNewCycle
              ? existingPayload.mode === "group"
                ? {}
                : undefined
              : existingPayload.groupProviderCallBudgets,
            failureStage: startsNewCycle ? undefined : existingPayload.failureStage,
          };
          const nextTask: BackgroundTask = {
            ...existing,
            payload: nextPayload,
            state: activeLease ? "running" : "pending",
            nextAttemptAt: activeLease ? existing.nextAttemptAt : t,
            leaseExpiresAt: activeLease ? existing.leaseExpiresAt : undefined,
            leaseOwnerId: activeLease ? existing.leaseOwnerId : undefined,
            leaseGeneration: existing.leaseGeneration,
            lastError: activeLease ? existing.lastError : undefined,
            attempts: activeLease ? existing.attempts : 0,
            updatedAt: t,
          };
          const nextPlaceholder: Message = {
            ...existingPlaceholder,
            content: activeLease ? existingPlaceholder.content : "",
            translation: activeLease ? existingPlaceholder.translation : undefined,
            innerVoice: activeLease ? existingPlaceholder.innerVoice : undefined,
            status: "generating",
            generation: {
              ...existingPlaceholder.generation!,
              taskEventId: existing.eventId,
              phase: nextPayload.phase,
              error: undefined,
              apiError: undefined,
              lastProgressAt: t,
            },
            updatedAt: t,
          };
          await db.backgroundTasks.put(nextTask);
          await db.messages.put(nextPlaceholder);
          ensured = {
            task: nextTask,
            placeholder: nextPlaceholder,
            action: shouldRequeue ? "requeued" : "reused",
          };
          continue;
        }
        await retireBrokenTask(existing, existingPayload);
      }
      if (ensured) return;
      if (originalMessages?.length)
        await db.messages.bulkDelete(
          originalMessages.map((message) => message.id),
        );
      await db.messages.put(placeholder);
      await db.backgroundTasks.add(task);
      await db.conversations.update(conversation.id, {
        lastActivityAt: t,
        updatedAt: t,
      });
      ensured = {
        task,
        placeholder,
        action: existingRows.length ? "recovered" : "created",
      };
    },
  );
  if (!ensured) throw new Error("\u56de\u590d\u4efb\u52a1\u521b\u5efa\u5931\u8d25");
  emit();
  return ensured;
}
export async function enqueueChatReply(input: EnqueueChatReplyInput) {
  const messages = await db.messages.where("conversationId").equals(input.conversationId).sortBy("createdAt");
  const candidate = input.targetMessageId ? messages.find((message) => message.id === input.targetMessageId) : [...messages].reverse().find((message) => message.senderType === "user" && message.status === "complete");
  const attachment = candidate?.attachments?.find((item) => (item.type === "music-invitation" || item.type === "couple-island-invitation") && item.cardRole !== "response" && item.state === "pending");
  if (candidate && attachment && candidate.senderType === "user") {
    const task = await ensureInvitationResponseTaskForMessage(candidate.id, attachment.type === "music-invitation" ? "music" : "couple-island");
    if (task) return task;
  }
  return (await ensureRunnableChatReplyTask(input)).task;
}
async function updatePhase(
  task: BackgroundTask,
  phase: ChatReplyTaskPayload["phase"],
  messageId?: string,
) {
  const t = now();
  await db.transaction("rw", [db.backgroundTasks, db.messages], async () => {
    const stored = await db.backgroundTasks.get(task.id);
    if (!taskOwnsLease(stored, task)) throw new ChatReplyLeaseLostError();
    const payload = { ...taskPayload(stored!), phase };
    const leaseExpiresAt = t + CHAT_REPLY_LEASE_MS;
    await db.backgroundTasks.update(task.id, {
      payload,
      updatedAt: t,
      leaseExpiresAt,
    });
    task.payload = payload;
    task.updatedAt = t;
    task.leaseExpiresAt = leaseExpiresAt;
    const id = messageId ?? payload.outputMessageId;
    if (id) {
      const message = await db.messages.get(id);
      if (message)
        await db.messages.update(id, {
          generation: {
            ...message.generation!,
            phase,
            lastProgressAt: t,
            attempt: task.attempts,
          },
          updatedAt: t,
        });
    }
  });
  emit();
}
async function memoryRecall(
  memories: Memory[],
  characterId: string,
  conversationId: string,
  query: string,
  limit: number,
) {
  const lexical = selectMemories(
      memories,
      characterId,
      conversationId,
      limit,
      query,
      true,
    ),
    semantic = recallMemoriesWithEmbeddings(
      memories,
      characterId,
      conversationId,
      query,
      limit,
    ).catch(() => lexical);
  return Promise.race([
    semantic,
    new Promise<typeof lexical>((resolve) =>
      setTimeout(() => resolve(lexical), 800),
    ),
  ]);
}
async function loadTaskData(task: BackgroundTask) {
  const [conversation, globalProvider, settings, loreBooks] = await Promise.all(
    [
      db.conversations.get(task.conversationId!),
      getProvider(),
      getAppSettings(),
      db.loreBooks.toArray(),
    ],
  );
  if (!conversation) throw new Error("\u4f1a\u8bdd\u4e0d\u5b58\u5728");
  const payload = taskPayload(task),
    [characters, memories, messages, resolvedProvider, meetSessions] =
      await Promise.all([
      (async () =>
        (await db.characters.bulkGet(conversation.memberIds)).filter(
          (character): character is Character => Boolean(character),
        ))(),
      conversation.memberIds.length
        ? db.memories
            .where("characterId")
            .anyOf(conversation.memberIds)
            .toArray()
        : Promise.resolve([] as Memory[]),
      db.messages
        .where("conversationId")
        .equals(conversation.id)
        .sortBy("createdAt"),
      resolveConversationProvider(
        conversation,
        globalProvider,
        payload.providerPresetId,
      ),
      db.meetSessions
        .where("conversationId")
        .equals(conversation.id)
        .filter((session) => session.status === "active")
        .toArray(),
    ]),
    assetIds = new Set<string>();
  if (conversation.avatarAssetId) assetIds.add(conversation.avatarAssetId);
  for (const npc of conversation.groupNpcs ?? [])
    if (npc.avatarAssetId) assetIds.add(npc.avatarAssetId);
  for (const message of messages)
    for (const attachment of message.attachments ?? [])
      if ("assetId" in attachment && attachment.assetId)
        assetIds.add(attachment.assetId);
  const mediaAssets = (await db.mediaAssets.bulkGet([...assetIds])).filter(
      (asset): asset is MediaAsset => Boolean(asset),
    ),
    provider = resolvedProvider.provider;
  if (!provider.apiKey.trim())
    throw new ProviderError(
      "auth",
      "\u5c1a\u672a\u914d\u7f6e\u6a21\u578b API",
      "",
      createApiErrorInfo("auth", {
        providerCode: "config_missing",
        detail: "\u5c1a\u672a\u914d\u7f6e\u4e3b API",
      }),
    );
  return {
    conversation,
    provider,
    settings,
    characters,
    loreBooks,
    memories,
    mediaAssets,
    messages,
    meetSessions,
  };
}
async function postProcessPrivate(input: {
  task: BackgroundTask;
  character: Character;
  conversation: Conversation;
  provider: ProviderSettings;
  messages: Message[];
  source?: Message;
  reply: string;
  messageIds: string[];
  loreBooks: LoreBook[];
  memories: Memory[];
  recalled: Memory[];
  settings: AppSettings;
  characters: Character[];
  mediaAssets: MediaAsset[];
  presence: ChatPresenceContext;
}) {
  const {
    task,
    character,
    conversation,
    provider,
    messages,
    source,
    reply,
    messageIds,
    loreBooks,
    memories,
    recalled,
    settings,
    characters,
    mediaAssets,
    presence,
  } = input;
  const invokeProvider = providerInvokerForTask(task, true);
  let latest = character;
  let shouldConfess = false;
  const auxiliary = await resolveSecondaryProvider(provider).catch(() => provider);
  if (source && chatSettingsOf(latest).strategyMode.enabled)
    try {
      const evaluated = await evaluateStrategyInteraction({
        character: latest,
        sourceId: source.id,
        userText: source.content,
        messages,
        characters,
        provider: auxiliary,
        invokeProvider,
      });
      latest = evaluated.character;
      shouldConfess = evaluated.shouldConfess;
    } catch {}
  if (source)
    await recordMemoryAccess(
      recalled.map((memory) => memory.id),
      "chat:" + source.id + ":" + latest.id,
    ).catch(() => {});
  await Promise.allSettled([
    maybeAttachCharacterVoice({ character: latest, messageIds, provider, invokeProvider }),
    decidePendingTransfer({
      messages,
      character: latest,
      provider: auxiliary,
      replyText: reply,
      invokeProvider,
    }),
    source
      ? maybeCreateCharacterCommerce({
          character: latest,
          conversation,
          sourceMessageId: messageIds[0],
          userText: source.content,
          replyText: reply,
          provider: auxiliary,
          invokeProvider,
        })
      : Promise.resolve(null),
    source
      ? maybeCreateMeetInvitation({
          character: latest,
          conversationId: conversation.id,
          userText: source.content,
          replyText: reply,
        })
      : Promise.resolve(null),
  ]);
  if (shouldConfess)
    try {
      const currentMessages = (
          await db.messages
            .where("conversationId")
            .equals(conversation.id)
            .sortBy("createdAt")
        ).filter((message) => message.status === "complete"),
        ctx = buildContext({
          character: latest,
          conversation,
          messages: currentMessages,
          loreBooks,
          memories,
          userText: "Complete the first sincere confession naturally after the normal reply.",
          settings,
          provider,
          mediaAssets,
          characters,
          scene: "private-chat",
          presence,
        }),
        parts = await generateConfessionMessages({
          character: latest,
          context: ctx,
          provider,
          invokeProvider,
        }),
        review = await reviewCharacterReply({
          character: latest,
          conversation,
          scene: "private-chat",
          draftMessages: parts,
          messages: currentMessages,
          characters,
          loreBooks,
          memories,
          settings,
          provider,
          presence,
          invokeProvider,
        });
      const confessionValidation = validateLocalCharacterReply({
        messages: review.revisedMessages,
        characterName: latest.name,
        presence,
      });
      if (confessionValidation.issues.length)
        throw new ProviderError("format", "Confession reply failed local validation");
      await saveConfessionMessages({
        characterId: latest.id,
        conversationId: conversation.id,
        parts: review.revisedMessages,
        provider,
      });
    } catch {}
  const row = await db.messages.get(messageIds.at(-1) ?? messageIds[0]);
  if (row)
    await notifyChatReplyCompleted(latest, conversation, row).catch(() => {});
}
async function savePrivateParts(
  task: BackgroundTask,
  character: Character,
  parts: ReplyBubblePart[],
  provider: ProviderSettings,
  innerVoice?: GeneratedInnerVoice,
  sticker?: StickerItem,
) {
  const payload = taskPayload(task),
    base = now(),
    turnId = uid(),
    firstId = payload.outputMessageId!,
    first = await db.messages.get(firstId),
    turnVoice = innerVoice
      ? createMessageInnerVoice({
          draft: innerVoice,
          actorType: "character",
          actorId: character.id,
          speakerTurnId: turnId,
          contents: parts.map((part) => part.content),
          provider,
          createdAt: base,
        })
      : undefined,
    rows: Message[] = parts.map((part, index) => {
      const common: Message = {
        ...(index === 0 && first ? first : {}),
        id: index === 0 ? firstId : uid(),
        schemaVersion: SCHEMA_VERSION,
        createdAt: index === 0 ? (first?.createdAt ?? base) : base + index,
        updatedAt: base + index,
        conversationId: task.conversationId!,
        senderType: "character",
        senderId: character.id,
        content: part.content,
        translation: part.translation
          ? completedTranslation(part.content, part.translation, provider.model)
          : undefined,
        innerVoice: index === 0 ? turnVoice : undefined,
        status: "complete",
        generation: {
          model: provider.model,
          temperature: provider.temperature,
          stream: false,
          roundId: payload.roundId ?? turnId,
          speakerTurnId: turnId,
          segmentIndex: index,
          taskEventId: task.eventId,
          phase: "completed",
          attempt: task.attempts,
          startedAt: first?.generation?.startedAt,
          lastProgressAt: base + index,
          error: undefined,
          apiError: undefined,
        },
      };
      if (index > 0) {
        common.kind = "text";
        common.attachments = undefined;
        common.favoritedAt = undefined;
        common.reactions = undefined;
        common.quote = undefined;
      }
      return common;
    });
  if (sticker)
    rows.push(
      replyStickerMessage({
        conversationId: task.conversationId!,
        senderType: "character",
        senderId: character.id,
        sticker,
        createdAt: base + rows.length,
        provider,
        task,
        roundId: payload.roundId ?? turnId,
        speakerTurnId: turnId,
        segmentIndex: rows.length,
      }),
    );
  if (!parts.length || parts.some((part) => !part.content.trim()))
    throw new ProviderError("format", "角色回复正文不完整");
  if (!innerVoice)
    throw new ProviderError(
      "format",
      "角色心声缺失，整轮回复不会保存",
      "",
      createApiErrorInfo("format", {
        providerCode: "missing_inner_voice",
        failureStage: "inner-voice",
      }),
    );
  let completedPayload: ChatReplyTaskPayload | undefined;
  await db.transaction(
    "rw",
    [db.messages, db.conversations, db.backgroundTasks],
    async () => {
      const storedTask = await db.backgroundTasks.get(task.id);
      if (!taskOwnsLease(storedTask, task)) throw new ChatReplyLeaseLostError();
      await db.messages.bulkPut(rows);
      await db.conversations.update(task.conversationId!, {
        lastActivityAt: base + rows.length - 1,
        updatedAt: base + rows.length - 1,
      });
      const savedRows = await db.messages.bulkGet(rows.map((row) => row.id));
      const savedFirst = savedRows[0];
      if (savedRows.some((row) => !row || row.status !== "complete" || !row.content.trim()))
        throw new Error("角色回复写入本地数据库后校验失败");
      if (!savedFirst?.innerVoice)
        throw new Error("角心声写入本地数据库后校验失败");
      completedPayload = {
        ...taskPayload(storedTask!),
        phase: "completed",
        lastApiError: undefined,
        failureStage: undefined,
      };
      await db.backgroundTasks.put({
        ...storedTask!,
        payload: completedPayload,
        state: "completed",
        leaseExpiresAt: undefined,
        updatedAt: base + rows.length - 1,
      });
    },
  );
  task.payload = completedPayload ?? task.payload;
  task.state = "completed";
  task.leaseExpiresAt = undefined;
  emit();
  return rows;
}
async function processPrivate(
  task: BackgroundTask,
  controller: AbortController,
) {
  const generationTime = new Date();
  const payload = taskPayload(task),
    data = await loadTaskData(task),
    {
      conversation,
      provider,
      settings,
      characters,
      loreBooks,
      memories,
      mediaAssets,
      messages: storedMessages,
      meetSessions,
    } = data,
    character = characters.find((item) =>
      conversation.memberIds.includes(item.id),
    );
  if (!character || !canCharacterInteract(character))
    throw new Error("\u5f53\u524d\u89d2\u8272\u4e0d\u53ef\u56de\u590d");
  await updatePhase(task, "preparing");
  const all = storedMessages.filter(
      (message) =>
        message.id !== payload.outputMessageId && message.status === "complete",
    ),
    original = payload.originalMessages?.[0] ?? payload.originalMessage,
    history = original
      ? all.filter((message) => message.createdAt < original.createdAt)
      : all,
    source = payload.sourceMessageId
      ? history.find((message) => message.id === payload.sourceMessageId)
      : [...history].reverse().find((message) => message.senderType === "user"),
    userText = history.length
      ? "\u8bf7\u6839\u636e\u4ee5\u4e0a\u5b8c\u6574\u5bf9\u8bdd\uff0c\u4ee5\u5f53\u524d\u89d2\u8272\u8eab\u4efd\u81ea\u7136\u5730\u7ee7\u7eed\u56de\u590d\u3002"
      : "\u8bf7\u4f9d\u636e\u4f60\u7684\u89d2\u8272\u8bbe\u5b9a\u548c\u53ef\u7528\u65f6\u95f4\u4fe1\u606f\uff0c\u81ea\u7136\u4e3b\u52a8\u5730\u5f00\u542f\u4f60\u4eec\u7684\u7b2c\u4e00\u6bb5\u5bf9\u8bdd\u3002",
    query = source?.content ?? userText,
    memoryLimit = payload.regenerationReasons?.includes("memory-conflict")
      ? 20
      : 10,
    localMemories = selectMemories(
      memories,
      character.id,
      conversation.id,
      memoryLimit,
      query,
      true,
    ),
    recallPromise = history.length
      ? memoryRecall(
          memories,
          character.id,
          conversation.id,
          query,
          memoryLimit,
        )
      : Promise.resolve(localMemories),
    [forumContext, recalled] = await Promise.all([
      forumInteropContextForChat(character.id),
      recallPromise,
    ]),
    bilingual = autoTranslateCharacter(character, conversation),
    presence = inferChatPresenceContext({
      conversation,
      actorId: character.id,
      messages: history,
      meetSessions,
    }),
    crossModeContinuity = buildOnlineCrossModeContinuity({
      conversation,
      actorId: character.id,
      meetSessions,
      names: Object.fromEntries(characters.map((item) => [item.id, item.name])),
    }),
    ctx = buildContext({
      character,
      conversation,
      messages: history,
      loreBooks,
      memories: recalled,
      userText,
      settings,
      provider,
      mediaAssets,
      characters,
      forumContext,
      scene: "private-chat",
      regenerationReasons: payload.regenerationReasons,
      regenerationInstruction: payload.regenerationInstruction,
      forceAllLore: payload.regenerationReasons?.includes("lore-conflict"),
      presence,
      crossModeContinuity,
      timeAt: generationTime,
    });
  const continuityContext = innerVoiceContinuityContext(history, character.id);
  if (continuityContext) ctx.push({ role: "system", content: continuityContext });
  const bubbleCountPlan = await ensurePersistedBubbleCountPlan(task, character, ctx, "private");
  const listeningContext = await buildListeningContext(conversation.id);
  const listeningSession = listeningContext?.sessionId ? await db.listeningSessions.get(listeningContext.sessionId) : undefined;
  const listeningTask = listeningSession?.invitationMessageId ? await db.backgroundTasks.where("eventId").equals(`invitation-response:music:${listeningSession.invitationMessageId}`).first() : undefined;
  const listeningPrompt = listeningTask && listeningContext?.state === "invited" ? "" : listeningContextPrompt(listeningContext);
  if (listeningPrompt) ctx.push({ role: "system", content: listeningPrompt });
  const islandContext = await buildCoupleIslandContext(conversation.id, character.id);
  const islandTask = islandContext?.pendingInvitation ? await db.backgroundTasks.where("eventId").equals(`invitation-response:couple-island:${islandContext.pendingInvitation.id}`).first() : undefined;
  const islandPrompt = islandTask ? "" : coupleIslandContextPrompt(islandContext);
  if (islandPrompt) ctx.push({ role: "system", content: islandPrompt });
  const replyStickers = await availableReplyStickers(
    conversation,
    character.id,
    history,
  );
  await updatePhase(task, "generating");
  const generatedTurn = await generateCharacterReplyTurn(
    provider,
    ctx,
    character,
    bilingual,
    "private",
    true,
    controller.signal,
    Boolean(listeningContext),
    Boolean(islandContext),
    replyStickers.map(({ id, name, description }) => ({
      id,
      name,
      description,
    })),
    undefined,
    providerInvokerForTask(task),
    bubbleCountPlan,
    (attempt, diagnostics) => recordBubbleCountValidation(task, attempt, diagnostics).catch(() => {}),
  );
    let parts = generatedTurn.parts,
    innerVoice: GeneratedInnerVoice | undefined = generatedTurn.innerVoice;
  await updatePhase(task, "validating");
  const localValidation = validateLocalCharacterReply({
    messages: parts.map((part) => part.content),
    translations: parts.map((part) => part.translation),
    characterName: character.name,
    presence,
  }), timeConflict = character.proactive.timeAware ? findCurrentTimeReplyContradiction(userText, parts.map((part) => part.content).join("\n"), generationTime) : null;
  const providerBudgetAvailable = (taskPayload(task).providerCallCount ?? 0) < (taskPayload(task).providerCallLimit ?? CHAT_PROVIDER_CALL_LIMIT);
  const needsLocalReview = Boolean(payload.regenerationTargetId || localValidation.issues.length || timeConflict);
  if (needsLocalReview && providerBudgetAvailable) {
    await updatePhase(task, "reviewing");
    const review = await reviewCharacterReply({
        character,
        conversation,
        scene: "private-chat",
        draftMessages: parts.map((part) => part.content),
        messages: history,
        characters,
        groupNpcs: conversation.groupNpcs,
        loreBooks,
        memories: recalled,
        settings,
        provider,
        regenerationReasons: payload.regenerationReasons,
        regenerationInstruction: [payload.regenerationInstruction, timeConflict ? "当前设备时间校验失败：回复中的“" + timeConflict.expression + "”与当前时间不一致。必须按最新设备时间重写。" : ""].filter(Boolean).join("\n"),
        bilingual,
        draftInnerVoice: innerVoice,
        innerVoiceRequired: payload.innerVoiceRequired ?? true,
        presence,
        crossModeContinuity,
        targetCount: parts.length,
        signal: controller.signal,
        invokeProvider: providerInvokerForTask(task),
      }),
      revised = review.revisedMessages.map((content, index) => ({
        content,
        translation: bilingual
          ? review.revisedTranslations?.[index]
          : undefined,
      })),
      normalized = normalizeStrictReplyBubbles(
        revised,
        replyBubbleRangeOf(character),
        { mode: "exact", min: parts.length, max: parts.length, preferred: parts.length },
      );
    if (
      !normalized.compliant ||
      (bilingual && normalized.parts.some((part) => !part.translation?.trim()))
    )
      throw new ProviderError(
        "format",
        "\u5ba1\u67e5\u540e\u7684\u89d2\u8272\u56de\u590d\u4e0d\u7b26\u5408\u6c14\u6ce1\u6570\u91cf\u6216\u8bd1\u6587\u8981\u6c42",
      );
    parts = normalized.parts;
    innerVoice = review.revisedInnerVoice;
    if ((payload.innerVoiceRequired ?? true) && !innerVoice) throw new ProviderError("format", "\u89d2\u8272\u5fc3\u58f0\u7f3a\u5931\uff0c\u6574\u8f6e\u56de\u590d\u9700\u8981\u91cd\u65b0\u751f\u6210");
    const reviewedValidation = validateLocalCharacterReply({
      messages: parts.map((part) => part.content),
      translations: parts.map((part) => part.translation),
      characterName: character.name,
      presence,
    });
    const reviewedTimeConflict = character.proactive.timeAware ? findCurrentTimeReplyContradiction(userText, parts.map((part) => part.content).join("\n"), generationTime) : null;
    if (reviewedTimeConflict) {
      const factual = currentTimeFactReply(generationTime);
      parts = bilingual ? [{ content: factual, translation: factual }] : [{ content: factual }];
      if (!(payload.innerVoiceRequired ?? true)) innerVoice = undefined;
      else throw new ProviderError("format", "\u65f6\u95f4\u4fee\u6b63\u540e\u65e0\u6cd5\u4fdd\u7559\u5fc5\u8981\u5fc3\u58f0\uff0c\u8bf7\u91cd\u8bd5");
    }
    if (reviewedValidation.issues.length)
      throw new ProviderError(
        "format",
        reviewedValidation.issues.includes("remote-presence")
          ? "角色回复仍违反线上聊天距离约束"
          : "审查后的角色回复仍不符合本地格式要求",
      );
  } else if (needsLocalReview) {
    throw new ProviderError(
      "format",
      "\u672c\u8f6e\u6a21\u578b\u8c03\u7528\u989d\u5ea6\u5df2\u7528\u5b8c\uff0c\u89d2\u8272\u56de\u590d\u672a\u901a\u8fc7\u672c\u5730\u6821\u9a8c",
      "",
      createApiErrorInfo("format", { providerCode: "local_validation_after_budget", failureStage: "role-protocol" }),
    );
  }
  await updatePhase(task, "saving");
  const selectedSticker = generatedTurn.stickerId
      ? replyStickers.find((sticker) => sticker.id === generatedTurn.stickerId)
      : undefined,
    rows = await savePrivateParts(
      task,
      character,
      parts,
      provider,
      innerVoice,
      selectedSticker,
    ),
    textRows = rows.filter((row) => !isStickerMessage(row)),
    reply = textRows.map((row) => row.content).join("\n\n");
  void Promise.allSettled([
    generatedTurn.musicAction
      ? executeCharacterMusicAction({ conversationId: conversation.id, characterId: character.id, action: generatedTurn.musicAction })
      : Promise.resolve(),
    generatedTurn.islandAction
      ? executeCharacterIslandAction({ conversationId: conversation.id, characterId: character.id, action: generatedTurn.islandAction })
      : islandContext?.pendingInvitation
        ? respondCoupleIslandInvitation(islandContext.pendingInvitation.id, "accept")
        : Promise.resolve(),
    source?.senderType === "user"
      ? rewardIslandChat(conversation.id, character.id, source.id)
      : Promise.resolve(),
  ]);
  void postProcessPrivate({
    task,
    character,
    conversation,
    provider,
    messages: history,
    source,
    reply,
    messageIds: textRows.map((row) => row.id),
    loreBooks,
    memories,
    recalled,
    settings,
    characters,
    mediaAssets,
    presence,
  }).finally(emit);
}
async function saveGroupParts(
  task: BackgroundTask,
  speaker: GroupActor,
  parts: Array<{ content: string; translation?: string }>,
  provider: ProviderSettings,
  innerVoice?: GeneratedInnerVoice,
  sticker?: StickerItem,
  complete = false,
  nextSpeakerIndex?: number,
) {
  const payload = taskPayload(task),
    base = now(),
    turnId = uid(),
    firstId = payload.outputMessageId!,
    first = await db.messages.get(firstId),
    turnVoice = innerVoice
      ? createMessageInnerVoice({
          draft: innerVoice,
          actorType: speaker.type,
          actorId: speaker.id,
          speakerTurnId: turnId,
          contents: parts.map((part) => part.content),
          provider,
          createdAt: base,
        })
      : undefined,
    rows: Message[] = parts.map((part, index) => ({
      id: index === 0 ? firstId : uid(),
      schemaVersion: SCHEMA_VERSION,
      createdAt: index === 0 ? (first?.createdAt ?? base) : base + index,
      updatedAt: base + index,
      conversationId: task.conversationId!,
      senderType: speaker.type,
      senderId: speaker.id,
      content: part.content,
      translation: part.translation
        ? completedTranslation(part.content, part.translation, provider.model)
        : undefined,
      innerVoice: index === 0 ? turnVoice : undefined,
      status: "complete",
      generation: {
        model: provider.model,
        temperature: provider.temperature,
        stream: false,
        roundId: payload.roundId,
        speakerTurnId: turnId,
        segmentIndex: index,
        taskEventId: task.eventId,
        phase: "completed",
        attempt: task.attempts,
        startedAt: first?.generation?.startedAt,
        lastProgressAt: base + index,
      },
    }));
  if (sticker)
    rows.push(
      replyStickerMessage({
        conversationId: task.conversationId!,
        senderType: speaker.type,
        senderId: speaker.id,
        sticker,
        createdAt: base + rows.length,
        provider,
        task,
        roundId: payload.roundId,
        speakerTurnId: turnId,
        segmentIndex: rows.length,
      }),
    );
  if (!parts.length || parts.some((part) => !part.content.trim()))
    throw new ProviderError("format", "\u7fa4\u804a\u89d2\u8272\u8fd4\u56de\u7f3a\u5c11\u975e\u7a7a\u6b63\u6587");
  if ((payload.innerVoiceRequired ?? true) && !innerVoice)
    throw new ProviderError(
      "format",
      "群聊角色心声缺失，整轮回复需要重新生成",
      "",
      createApiErrorInfo("format", {
        providerCode: "missing_inner_voice",
        failureStage: "inner-voice",
      }),
    );
  let nextPayload: ChatReplyTaskPayload | undefined;
  await db.transaction(
    "rw",
    [db.messages, db.conversations, db.backgroundTasks],
    async () => {
      const storedTask = await db.backgroundTasks.get(task.id);
      if (!taskOwnsLease(storedTask, task)) throw new ChatReplyLeaseLostError();
      await db.messages.bulkPut(rows);
      await db.conversations.update(task.conversationId!, {
        lastActivityAt: base + rows.length - 1,
        updatedAt: base + rows.length - 1,
      });
      const savedRows = await db.messages.bulkGet(rows.map((row) => row.id));
      if (savedRows.some((row) => !row || row.status !== "complete" || !row.content.trim()))
        throw new Error("\u7fa4\u804a\u56de\u590d\u4e8b\u52a1\u6821\u9a8c\u5931\u8d25");
      const storedPayload = taskPayload(storedTask!);
      const speakerBudget = groupBudgetOf(storedPayload, speaker.id);
      nextPayload = {
        ...storedPayload,
        nextSpeakerIndex,
        phase: complete ? "completed" : "post-processing",
        lastApiError: undefined,
        failureStage: undefined,
        groupProviderCallBudgets: {
          ...(storedPayload.groupProviderCallBudgets ?? {}),
          [speaker.id]: {
            ...speakerBudget,
            leaseGeneration: storedTask!.leaseGeneration,
            state: "completed",
          },
        },
      };
      await db.backgroundTasks.put({
        ...storedTask!,
        payload: nextPayload,
        state: complete ? "completed" : "running",
        leaseExpiresAt: complete ? undefined : storedTask!.leaseExpiresAt,
        updatedAt: base + rows.length - 1,
      });
    },
  );
  task.payload = nextPayload ?? task.payload;
  if (complete) {
    task.state = "completed";
    task.leaseExpiresAt = undefined;
  }
  emit();
  return rows;
}
async function nextGroupPlaceholder(
  task: BackgroundTask,
  speaker: GroupActor,
  provider: ProviderSettings,
  index: number,
) {
  const t = now(),
    id = uid(),
    payload = {
      ...taskPayload(task),
      outputMessageId: id,
      nextSpeakerIndex: index,
      phase: "queued" as const,
    };
  task.payload = payload;
  await db.transaction("rw", [db.messages, db.backgroundTasks], async () => {
    const storedTask = await db.backgroundTasks.get(task.id);
    if (!taskOwnsLease(storedTask, task)) throw new ChatReplyLeaseLostError();
    await db.messages.add({
      id,
      schemaVersion: SCHEMA_VERSION,
      createdAt: t,
      updatedAt: t,
      conversationId: task.conversationId!,
      senderType: speaker.type,
      senderId: speaker.id,
      content: "",
      status: "generating",
      generation: {
        model: provider.model,
        temperature: provider.temperature,
        stream: false,
        taskEventId: task.eventId,
        phase: "queued",
        attempt: task.attempts,
        startedAt: t,
        lastProgressAt: t,
      },
    });
    await db.backgroundTasks.update(task.id, {
      entityId: id,
      payload,
      characterId: speaker.id,
      updatedAt: t,
    });
  });
  emit();
}
async function processGroup(task: BackgroundTask, controller: AbortController) {
  const generationTime = new Date();
  const data = await loadTaskData(task),
    {
      conversation,
      provider,
      settings,
      characters,
      loreBooks,
      memories,
      mediaAssets,
      messages: storedMessages,
      meetSessions,
    } = data,
    actors = groupActors(conversation, characters, mediaAssets),
    payload = taskPayload(task),
    order = payload.speakerOrder?.length
      ? payload.speakerOrder
      : actors.map((actor) => actor.id);
  payload.speakerOrder = order;
  const allHistory = storedMessages.filter(
      (message) =>
        message.status === "complete" &&
        message.generation?.taskEventId !== task.eventId,
    ),
    regenerationStart = payload.originalMessages?.[0]?.createdAt;
  let history = regenerationStart
    ? allHistory.filter((message) => message.createdAt < regenerationStart)
    : allHistory;
  for (
    let index = payload.nextSpeakerIndex ?? 0;
    index < order.length;
    index++
  ) {
    const speaker = actors.find((actor) => actor.id === order[index]);
    if (!speaker) continue;
    const currentPayload = taskPayload(task);
    if (
      index > (currentPayload.nextSpeakerIndex ?? 0) ||
      !currentPayload.outputMessageId
    )
      await nextGroupPlaceholder(task, speaker, provider, index);
    else {
      const current = await db.messages.get(currentPayload.outputMessageId);
      if (current)
        await db.messages.update(current.id, {
          senderType: speaker.type,
          senderId: speaker.id,
          status: "generating",
          translation: undefined,
          generation: {
            ...current.generation!,
            phase: "preparing",
            error: undefined,
            apiError: undefined,
            lastProgressAt: now(),
          },
        });
    }
    await updatePhase(task, "preparing");
    const query = history
        .slice(-8)
        .map((message) => message.content)
        .join("\n"),
      localMemories =
        speaker.type === "character"
          ? selectMemories(
              memories,
              speaker.id,
              conversation.id,
              4,
              query,
              true,
            )
          : [],
      recallPromise =
        speaker.type !== "character"
          ? Promise.resolve([] as Memory[])
          : history.length
            ? memoryRecall(memories, speaker.id, conversation.id, query, 4)
            : Promise.resolve(localMemories),
      [forumContext, recalled] = await Promise.all([
        speaker.type === "character"
          ? forumInteropContextForChat(speaker.id)
          : Promise.resolve(""),
        recallPromise,
      ]),
      presence = inferChatPresenceContext({
        conversation,
        actorId: speaker.id,
        messages: history,
        meetSessions,
      }),
      crossModeContinuity = buildOnlineCrossModeContinuity({
        conversation,
        actorId: speaker.id,
        meetSessions,
        names: Object.fromEntries(actors.map((actor) => [actor.id, actor.name])),
      }),
      ctx = buildContext({
        character: speaker.character,
        conversation,
        messages: history,
        loreBooks,
        memories: recalled,
        userText:
          "Please participate naturally in the current group chat as " +
          speaker.name +
          ".",
        settings,
        provider,
        mediaAssets,
        characters: actors.map((actor) => actor.character),
        groupNpcs: conversation.groupNpcs,
        forumContext,
        scene: "group-chat",
        regenerationReasons: payload.regenerationReasons,
        regenerationInstruction: payload.regenerationInstruction,
        presence,
        crossModeContinuity,
        timeAt: generationTime,
      });
    const bubbleCountPlan = await ensurePersistedBubbleCountPlan(
      task,
      speaker.character,
      ctx,
      "group",
      speaker.id,
    );
    const continuityContext = payload.innerVoiceRequired
      ? innerVoiceContinuityContext(history, speaker.id)
      : "";
    if (continuityContext) ctx.push({ role: "system", content: continuityContext });
    const replyStickers = await availableReplyStickers(
      conversation,
      speaker.id,
      history,
    );
    await updatePhase(task, "generating");
    const bilingual = autoTranslateCharacter(speaker.character, conversation);
    const generatedTurn = await generateCharacterReplyTurn(
      { ...provider, stream: false },
      ctx,
      speaker.character,
      bilingual,
      "group",
      payload.innerVoiceRequired ?? true,
      controller.signal,
      false,
      false,
      replyStickers.map(({ id, name, description }) => ({
        id,
        name,
        description,
      })),
      undefined,
      providerInvokerForTask(task, false, speaker.id),
      bubbleCountPlan,
      (attempt, diagnostics) => recordBubbleCountValidation(task, attempt, diagnostics, speaker.id).catch(() => {}),
    );
    let parts: Array<{ content: string; translation?: string }> =
        generatedTurn.parts,
      innerVoice = generatedTurn.innerVoice;
    await updatePhase(task, "validating");
    const drafts = parts.map((part) => part.content),
      localValidation = validateLocalCharacterReply({
        messages: drafts,
        translations: parts.map((part) => part.translation),
        characterName: speaker.name,
        presence,
      });
    const groupProviderBudget = groupBudgetOf(taskPayload(task), speaker.id);
    const groupReviewAvailable = groupProviderBudget.providerCallCount < groupProviderBudget.providerCallLimit;
    const needsGroupReview = Boolean(payload.regenerationTargetId || localValidation.issues.length);
    if (needsGroupReview && groupReviewAvailable) {
      await updatePhase(task, "reviewing");
      const review = await reviewCharacterReply({
        character: speaker.character,
        conversation,
        scene: "group-chat",
        draftMessages: drafts,
        messages: history,
        characters: actors.map((actor) => actor.character),
        groupNpcs: conversation.groupNpcs,
        loreBooks,
        memories: recalled,
        settings,
        provider,
        bilingual,
        regenerationReasons: payload.regenerationReasons,
        regenerationInstruction: payload.regenerationInstruction,
        draftInnerVoice: innerVoice,
        innerVoiceRequired: payload.innerVoiceRequired ?? true,
        presence,
        crossModeContinuity,
        targetCount: parts.length,
        signal: controller.signal,
        invokeProvider: providerInvokerForTask(task, false, speaker.id),
      });
      const revised = review.revisedMessages;
      if (bilingual) {
        const translated = (review.revisedTranslations ?? []).slice(
          0,
          revised.length,
        );
        if (
          translated.length !== revised.length ||
          translated.some((item) => !item?.trim())
        )
          throw new Error("Bilingual reviewed reply is missing translations");
        parts = revised.map((content, itemIndex) => ({
          content,
          translation: translated[itemIndex]!.trim(),
        }));
      } else parts = revised.map((content) => ({ content }));
      innerVoice = review.revisedInnerVoice;
      if (parts.length !== drafts.length)
        throw new ProviderError("format", "\u5ba1\u67e5\u540e\u7684\u7fa4\u804a\u56de\u590d\u672a\u4fdd\u6301\u5df2\u63a5\u53d7\u7684\u6c14\u6ce1\u6570\u91cf");
      if ((payload.innerVoiceRequired ?? true) && !innerVoice) {
        throw new ProviderError("format", "\u7fa4\u804a\u89d2\u8272\u5fc3\u58f0\u7f3a\u5931\uff0c\u6574\u8f6e\u56de\u590d\u9700\u8981\u91cd\u65b0\u751f\u6210");
      }
      const reviewedValidation = validateLocalCharacterReply({
        messages: parts.map((part) => part.content),
        translations: parts.map((part) => part.translation),
        characterName: speaker.name,
        presence,
      });
      if (reviewedValidation.issues.length)
        throw new ProviderError(
          "format",
          reviewedValidation.issues.includes("remote-presence")
            ? "群聊角色回复仍违反线上聊天距离约束"
            : "审查后的群聊回复仍不符合本地格式要求",
        );
    } else if (needsGroupReview) {
      throw new ProviderError(
        "format",
        "\u672c\u89d2\u8272\u672c\u8f6e\u6a21\u578b\u8c03\u7528\u989d\u5ea6\u5df2\u7528\u5b8c\uff0c\u56de\u590d\u672a\u901a\u8fc7\u672c\u5730\u6821\u9a8c",
        "",
        createApiErrorInfo("format", { providerCode: "local_validation_after_budget", failureStage: "role-protocol" }),
      );
    }
    await updatePhase(task, "saving");
    const selectedSticker = generatedTurn.stickerId
        ? replyStickers.find((sticker) => sticker.id === generatedTurn.stickerId)
        : undefined,
      nextSpeakerIndex = index + 1,
      finalSpeaker = nextSpeakerIndex >= order.length,
      rows = await saveGroupParts(
        task,
        speaker,
        parts,
        provider,
        innerVoice,
        selectedSticker,
        finalSpeaker,
        nextSpeakerIndex,
      );
    task.payload = { ...taskPayload(task), nextSpeakerIndex };
    history = [...history, ...rows];
    if (speaker.type === "character")
      void recordMemoryAccess(
        recalled.map((memory) => memory.id),
        "group:" + payload.roundId + ":" + speaker.id,
      ).catch(() => {});
    if (index + 1 < order.length) {
      const next = actors.find((actor) => actor.id === order[index + 1]);
      if (next) await nextGroupPlaceholder(task, next, provider, index + 1);
    }
  }
}
async function pauseOrFail(task: BackgroundTask, error: unknown) {
  const payload = taskPayload(task),
    messageId = payload.outputMessageId,
    t = now(),
    apiError = apiErrorInfoOf(error),
    failureStage = apiError?.failureStage ?? (apiError?.providerCode === "missing_inner_voice" ? "inner-voice" : apiError?.kind === "format" ? "role-protocol" : undefined);
  activeControllers.delete(task.id);
  if (payload.cancelled) return;
  const shouldRetry = retryable(error) && payload.autoResumeCount < 1;
  await db.transaction("rw", [db.backgroundTasks, db.messages], async () => {
    const storedTask = await db.backgroundTasks.get(task.id);
    if (!taskOwnsLease(storedTask, task)) throw new ChatReplyLeaseLostError();
    const storedPayload = taskPayload(storedTask!);
    const failedActorId = storedPayload.mode === "group" ? storedTask!.characterId : undefined;
    const failedBudget = failedActorId
      ? groupBudgetOf(storedPayload, failedActorId)
      : undefined;
    const next: ChatReplyTaskPayload = {
      ...storedPayload,
      phase: "failed",
      autoResumeCount: shouldRetry
        ? payload.autoResumeCount + 1
        : payload.autoResumeCount,
      lastApiError: apiError,
      failureStage,
      groupProviderCallBudgets:
        failedActorId && failedBudget
          ? {
              ...(storedPayload.groupProviderCallBudgets ?? {}),
              [failedActorId]: {
                ...failedBudget,
                leaseGeneration: storedTask!.leaseGeneration,
                state: "failed",
              },
            }
          : storedPayload.groupProviderCallBudgets,
    };
    await db.backgroundTasks.put({
      ...storedTask!,
      payload: next,
      state: "failed",
      leaseExpiresAt: undefined,
      leaseOwnerId: undefined,
      lastError: errorText(error),
      nextAttemptAt: shouldRetry ? t + AUTO_RESUME_DELAY_MS : Number.MAX_SAFE_INTEGER,
      updatedAt: t,
    });
    if (messageId) {
      const message = await db.messages.get(messageId);
      if (message)
        await db.messages.update(messageId, {
          status: shouldRetry ? "generating" : "error",
          generation: {
            ...message.generation!,
            phase: "failed",
            error: errorText(error),
            apiError,
            lastProgressAt: t,
          },
          updatedAt: t,
        });
    }
  });
  emit();
}
export async function claimNextChatReplyTask() {
  if (dataLifecycleMutationActive()) return;
  return db.transaction("rw", db.backgroundTasks, async () => {
    const t = now(),
      running = await db.backgroundTasks
        .where("type")
        .anyOf("chat-reply", "invitation-response")
        .filter(
          (task) => task.state === "running" && (task.leaseExpiresAt ?? 0) <= t,
        )
        .toArray();
    for (const task of running)
      await db.backgroundTasks.update(task.id, {
        state: "pending",
        nextAttemptAt: t,
        leaseExpiresAt: undefined,
        leaseOwnerId: undefined,
        updatedAt: t,
      });
    const rows = await db.backgroundTasks
        .where("type")
        .anyOf("chat-reply", "invitation-response")
        .filter(
          (item) =>
            (item.state === "pending" || item.state === "failed") &&
            item.nextAttemptAt <= t,
        )
        .sortBy("nextAttemptAt"),
      candidate = rows[0];
    if (!candidate) return;
    const task = await db.backgroundTasks.get(candidate.id);
    if (
      !task ||
      (task.state !== "pending" && task.state !== "failed") ||
      task.nextAttemptAt > t
    )
      return;
    const claimed = {
      ...task,
      state: "running" as const,
      attempts: task.attempts + 1,
      leaseExpiresAt: t + CHAT_REPLY_LEASE_MS,
      leaseOwnerId: CHAT_REPLY_OWNER_ID,
      leaseGeneration: (task.leaseGeneration ?? 0) + 1,
      updatedAt: t,
    };
    await db.backgroundTasks.put(claimed);
    return claimed;
  });
}
export async function processChatReplyTask(
  task: BackgroundTask,
): Promise<ChatReplyProcessOutcome> {
  if (task.type === "invitation-response") return processInvitationResponseTask(task);
  const controller = new AbortController();
  activeControllers.set(task.id, controller);
  let heartbeatRunning = false;
  let leaseLost = false;
  const renewLease = async () => {
    if (heartbeatRunning || leaseLost) return;
    heartbeatRunning = true;
    try {
      await db.transaction("rw", db.backgroundTasks, async () => {
        const stored = await db.backgroundTasks.get(task.id);
        if (!taskOwnsLease(stored, task)) throw new ChatReplyLeaseLostError();
        const t = now();
        await db.backgroundTasks.update(task.id, {
          leaseExpiresAt: t + CHAT_REPLY_LEASE_MS,
          updatedAt: t,
        });
        task.leaseExpiresAt = t + CHAT_REPLY_LEASE_MS;
      });
    } catch {
      leaseLost = true;
      controller.abort("lease-lost");
    } finally {
      heartbeatRunning = false;
    }
  };
  const heartbeat = setInterval(() => void renewLease(), 10_000);
  try {
    await assertTaskLease(task);
    if (taskPayload(task).mode === "group")
      await processGroup(task, controller);
    else await processPrivate(task, controller);
  } catch (error) {
    if (!leaseLost && !(error instanceof ChatReplyLeaseLostError))
      await pauseOrFail(task, error);
  } finally {
    clearInterval(heartbeat);
    activeControllers.delete(task.id);
  }
  const storedTask = await db.backgroundTasks.get(task.id);
  const outputMessageIds = (
    await db.messages
      .where("conversationId")
      .equals(task.conversationId ?? "")
      .filter((message) => message.generation?.taskEventId === task.eventId)
      .toArray()
  )
    .filter((message) => message.status === "complete")
    .map((message) => message.id);
  const state =
    storedTask?.state === "completed"
      ? "completed"
      : storedTask && storedTask.nextAttemptAt < Number.MAX_SAFE_INTEGER
        ? "retrying"
        : "failed";
  return {
    state,
    conversationId: task.conversationId ?? "",
    taskId: task.id,
    outputMessageIds,
    error: state === "failed" ? storedTask?.lastError : undefined,
  };
}
export async function stopChatReply(conversationId: string) {
  const task = await unfinishedTask(conversationId);
  if (!task) return;
  const payload = { ...taskPayload(task), cancelled: true };
  task.payload = payload;
  activeControllers.get(task.id)?.abort();
  const generated = await db.messages
    .where("conversationId")
    .equals(conversationId)
    .filter((message) => message.generation?.taskEventId === task.eventId)
    .toArray();
  await db.transaction("rw", [db.messages, db.backgroundTasks], async () => {
    if (payload.originalMessages?.length) {
      if (generated.length)
        await db.messages.bulkDelete(generated.map((message) => message.id));
      await db.messages.bulkPut(payload.originalMessages);
    } else if (payload.originalMessage)
      await db.messages.put(payload.originalMessage);
    else {
      const unfinished = generated.filter(
        (message) => message.status !== "complete",
      );
      if (unfinished.length)
        await db.messages.bulkDelete(unfinished.map((message) => message.id));
    }
    await db.backgroundTasks.put({
      ...task,
      payload,
      state: "completed",
      leaseExpiresAt: undefined,
      leaseOwnerId: undefined,
      updatedAt: now(),
    });
  });
  emit();
}
export async function retryChatReply(eventId: string) {
  const task = await db.backgroundTasks
    .where("eventId")
    .equals(eventId)
    .first();
  if (task?.type === "invitation-response") { await retryInvitationResponse(eventId); return; }
  if (!task || task.type !== "chat-reply") return;
  const payload = {
    ...taskPayload(task),
    phase: "queued" as const,
    cancelled: false,
    lastApiError: undefined,
    generationCycle: (taskPayload(task).generationCycle ?? 1) + 1,
    providerCallLimit: CHAT_PROVIDER_CALL_LIMIT,
    providerCallCount: 0,
    providerCallTrace: [],
    groupProviderCallBudgets: taskPayload(task).mode === "group" ? {} : undefined,
    failureStage: undefined,
  };
  if (payload.outputMessageId) {
    const message = await db.messages.get(payload.outputMessageId);
    if (message)
      await db.messages.update(message.id, {
        content: "",
        translation: undefined,
        status: "generating",
        generation: {
          ...message.generation!,
          phase: "queued",
          error: undefined,
          apiError: undefined,
          lastProgressAt: now(),
        },
        updatedAt: now(),
      });
  }
  await db.backgroundTasks.put({
    ...task,
    payload,
    state: "pending",
    nextAttemptAt: now(),
    leaseExpiresAt: undefined,
    leaseOwnerId: undefined,
    lastError: undefined,
    attempts: 0,
    updatedAt: now(),
  });
  emit();
}
export async function chatReplyDiagnostic(eventId: string) {
  const task = await db.backgroundTasks.where("eventId").equals(eventId).first();
  if (task?.type === "invitation-response") return invitationResponseDiagnostic(eventId);
  if (!task || task.type !== "chat-reply")
    return JSON.stringify({ feature: "chat-reply", stage: "task-not-found" }, null, 2);
  const payload = validReplyTaskPayload(task.payload) ? task.payload : undefined;
  const placeholder = payload?.outputMessageId
    ? await db.messages.get(payload.outputMessageId)
    : undefined;
  const groupProviderCallBudgets =
    payload?.mode === "group"
      ? Object.entries(payload.groupProviderCallBudgets ?? {}).map(
          ([actorId, budget]) => ({
            actorId,
            providerCallLimit: budget.providerCallLimit,
            providerCallCount: budget.providerCallCount,
            providerCallTrace: budget.providerCallTrace,
            leaseGeneration: budget.leaseGeneration,
            state: budget.state,
          }),
        )
      : undefined;
  const groupProviderCallCount = groupProviderCallBudgets?.reduce(
    (total, budget) => total + budget.providerCallCount,
    0,
  );
  const groupProviderCallLimit =
    payload?.mode === "group"
      ? (payload.speakerOrder?.length ?? groupProviderCallBudgets?.length ?? 0) *
        CHAT_PROVIDER_CALL_LIMIT
      : undefined;
  return JSON.stringify(
    {
      feature: "chat-reply",
      taskId: task.id,
      conversationId: task.conversationId,
      state: task.state,
      attempts: task.attempts,
      model: placeholder?.generation?.model,
      generationCycle: payload?.generationCycle ?? 1,
      providerCallLimit: payload?.providerCallLimit ?? CHAT_PROVIDER_CALL_LIMIT,
      providerCallCount: payload?.providerCallCount ?? 0,
      providerCallTrace: payload?.providerCallTrace ?? [],
      groupProviderCallLimit,
      groupProviderCallCount,
      groupProviderCallBudgets,
      failureStage: payload?.failureStage ?? payload?.lastApiError?.failureStage,
      nextAttemptReady: task.nextAttemptAt <= now(),
      leaseExpired: task.state === "running" ? (task.leaseExpiresAt ?? 0) <= now() : undefined,
      leaseOwnedByCurrentRuntime:
        task.state === "running" ? task.leaseOwnerId === CHAT_REPLY_OWNER_ID : undefined,
      leaseGeneration: task.leaseGeneration,
      payloadValid: Boolean(payload),
      placeholderPresent: Boolean(placeholder),
      placeholderStatus: placeholder?.status,
      persistenceVerified:
        task.state === "completed"
          ? Boolean(placeholder?.status === "complete" && placeholder.content.trim())
          : undefined,
      innerVoicePresent: placeholder?.innerVoice ? true : undefined,
      phase: payload?.phase ?? placeholder?.generation?.phase,
      apiErrorKind: payload?.lastApiError?.kind ?? placeholder?.generation?.apiError?.kind,
      httpStatus: payload?.lastApiError?.httpStatus ?? placeholder?.generation?.apiError?.httpStatus,
      providerCode: payload?.lastApiError?.providerCode ?? placeholder?.generation?.apiError?.providerCode,
      responseShape: payload?.lastApiError?.responseShape ?? placeholder?.generation?.apiError?.responseShape,
      rawLength: payload?.lastApiError?.rawLength ?? placeholder?.generation?.apiError?.rawLength,
      contentType: payload?.lastApiError?.contentType ?? placeholder?.generation?.apiError?.contentType,
      visibleCandidatePaths:
        payload?.lastApiError?.visibleCandidatePaths ?? placeholder?.generation?.apiError?.visibleCandidatePaths,
      parseStatus: payload?.lastApiError?.parseStatus ?? placeholder?.generation?.apiError?.parseStatus,
      strictParseSucceeded: payload?.lastApiError?.strictParseSucceeded ?? placeholder?.generation?.apiError?.strictParseSucceeded,
      repairAttempted: payload?.lastApiError?.repairAttempted ?? placeholder?.generation?.apiError?.repairAttempted,
      repairedParseSucceeded: payload?.lastApiError?.repairedParseSucceeded ?? placeholder?.generation?.apiError?.repairedParseSucceeded,
      outerContainerClosed: payload?.lastApiError?.outerContainerClosed ?? placeholder?.generation?.apiError?.outerContainerClosed,
      unterminatedString: payload?.lastApiError?.unterminatedString ?? placeholder?.generation?.apiError?.unterminatedString,
      hasMessages: payload?.lastApiError?.hasMessages ?? placeholder?.generation?.apiError?.hasMessages,
      hasInnerVoice: payload?.lastApiError?.hasInnerVoice ?? placeholder?.generation?.apiError?.hasInnerVoice,
      wireFormat: payload?.lastApiError?.wireFormat ?? placeholder?.generation?.apiError?.wireFormat,
      transportMarkedIncomplete: payload?.lastApiError?.transportMarkedIncomplete ?? placeholder?.generation?.apiError?.transportMarkedIncomplete,
      protocolValidationReached: payload?.lastApiError?.protocolValidationReached ?? placeholder?.generation?.apiError?.protocolValidationReached,
      transportMode: payload?.lastApiError?.transportMode ?? placeholder?.generation?.apiError?.transportMode,
      receivedChars: payload?.lastApiError?.receivedChars ?? placeholder?.generation?.apiError?.receivedChars,
      receivedBytes: payload?.lastApiError?.receivedBytes ?? placeholder?.generation?.apiError?.receivedBytes,
      declaredContentLength: payload?.lastApiError?.declaredContentLength ?? placeholder?.generation?.apiError?.declaredContentLength,
      contentLengthMatched: payload?.lastApiError?.contentLengthMatched ?? placeholder?.generation?.apiError?.contentLengthMatched,
      completeVisibleFieldRecovered: payload?.lastApiError?.completeVisibleFieldRecovered ?? placeholder?.generation?.apiError?.completeVisibleFieldRecovered,
      finishReason: payload?.lastApiError?.finishReason ?? placeholder?.generation?.apiError?.finishReason,
      tailKind: payload?.lastApiError?.tailKind ?? placeholder?.generation?.apiError?.tailKind,
      countMode: payload?.bubbleCountDiagnostics?.countMode ?? payload?.lastApiError?.countMode,
      allowedMin: payload?.bubbleCountDiagnostics?.allowedMin ?? payload?.lastApiError?.allowedMin,
      allowedMax: payload?.bubbleCountDiagnostics?.allowedMax ?? payload?.lastApiError?.allowedMax,
      preferredCount: payload?.bubbleCountDiagnostics?.preferredCount ?? payload?.lastApiError?.preferredCount,
      rawMessageCount: payload?.bubbleCountDiagnostics?.rawMessageCount ?? payload?.lastApiError?.rawMessageCount,
      finalMessageCount: payload?.bubbleCountDiagnostics?.finalMessageCount ?? payload?.lastApiError?.finalMessageCount,
      countResolution: payload?.bubbleCountDiagnostics?.countResolution ?? payload?.lastApiError?.countResolution,
      countCompliant: payload?.bubbleCountDiagnostics?.countCompliant ?? payload?.lastApiError?.countCompliant,
      bubbleCountPlan: payload?.bubbleCountPlan,
      bubbleCountDiagnostics: payload?.bubbleCountDiagnostics,
      bubbleCountDiagnosticsByActor: payload?.bubbleCountDiagnosticsByActor,
      lastError: task.lastError,
    },
    null,
    2,
  );
}

export function chatReplyPhaseText(phase?: ChatReplyTaskPayload["phase"]) {
  if (phase === "queued") return "\u6392\u961f\u4e2d";
  if (phase === "preparing") return "\u51c6\u5907\u4e2d";
  if (phase === "generating" || phase === "requesting") return "\u751f\u6210\u4e2d";
  if (phase === "parsing") return "\u89e3\u6790\u4e2d";
  if (phase === "validating" || phase === "reviewing") return "\u6821\u9a8c\u4e2d";
  if (phase === "saving") return "\u4fdd\u5b58\u4e2d";
  if (phase === "completed") return "\u5df2\u5b8c\u6210";
  if (phase === "failed" || phase === "paused") return "\u751f\u6210\u5931\u8d25";
  return "\u51c6\u5907\u4e2d";
}
