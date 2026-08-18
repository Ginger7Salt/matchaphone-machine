import { z } from "zod";
import { createApiErrorInfo, OpenAIProvider, ProviderError, isContextOverflowError, type ProviderChatInvoker } from "./provider";
import { coreSettingOf, personaOf } from "./character";
import type { Character, Message, ProviderSettings, ReplyBubbleCountDiagnostics, ReplyBubbleCountPlan } from "./types";
import type { ChatItem } from "./context";
import { compactChatItemsForRetry, fitChatItemsToInternalBudget } from "./tokenBudget";
import {
  parseStrictReplyTurn,
  replyBubbleCountPlanOf,
  replyBubbleInstruction,
  replyBubblePlanOf,
  type GeneratedReplyTurn,
  type ReplyBubblePart,
  type ReplyStickerCatalogItem,
} from "./replyBubbles";

const stripFence = (text: string) =>
  text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
export function validateReplyOrder(value: unknown, memberIds: string[]) {
  const parsed = z.object({ order: z.array(z.string()) }).safeParse(value);
  if (
    !parsed.success ||
    parsed.data.order.length !== memberIds.length ||
    new Set(parsed.data.order).size !== memberIds.length ||
    parsed.data.order.some((id) => !memberIds.includes(id))
  )
    return [...memberIds];
  return parsed.data.order;
}
export function validateMessageGroup(value: unknown) {
  const parsed = z.object({ messages: z.array(z.string()) }).safeParse(value);
  if (!parsed.success)
    throw new ProviderError("format", "角色回复格式无法识别");
  const messages = parsed.data.messages
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 6);
  if (!messages.length)
    throw new ProviderError("format", "角色没有返回有效消息");
  return messages;
}
function parse(text: string) {
  try {
    return JSON.parse(stripFence(text));
  } catch {
    throw new ProviderError("format", "模型没有返回有效 JSON");
  }
}
function transcript(messages: Message[], characters: Character[], limit = 30) {
  return (
    messages
      .slice(-limit)
      .map(
        (m) =>
          `${m.senderType === "user" ? "我" : (characters.find((c) => c.id === m.senderId)?.name ?? "角色")}：${m.content}`,
      )
      .join("\n") || "（群聊还没有消息）"
  );
}
export async function selectGroupReplyOrder(
  settings: ProviderSettings,
  characters: Character[],
  messages: Message[],
  signal?: AbortSignal,
) {
  const fallback = characters.map((c) => c.id),
    prompt = `请决定本轮群聊中所有角色的回复顺序。每个角色必须且只能出现一次。\n候选角色：\n${characters.map((c) => `- ${c.id} | ${c.name} | ${coreSettingOf(c).slice(0, 100)}`).join("\n")}\n最近对话：\n${transcript(messages, characters)}\n只返回 JSON：{"order":["角色ID"]}`;
  try {
    const raw = await new OpenAIProvider(settings).chat(
      [
        {
          role: "system",
          content: "你是群聊发言顺序调度器，只输出严格 JSON。",
        },
        { role: "user", content: prompt },
      ],
      { stream: false, signal, timeoutMs: null },
    );
    return validateReplyOrder(parse(raw), fallback);
  } catch (error) {
    if (error instanceof ProviderError && error.kind === "aborted") throw error;
    return fallback;
  }
}
function shouldUseCompactStreamingRetry(error: unknown) {
  if (!(error instanceof ProviderError)) return false;
  const code = error.apiError?.providerCode;
  return code === "truncated_json" || code === "transport_truncated" || code === "malformed_envelope";
}

export interface ReplyRegenerationContext {
  /** The previous visible turn is used only to avoid repeating it in a new generation. */
  previousMessages: string[];
  /** A task-scoped nonce prevents identical prompts from deterministically replaying the same turn. */
  variationNonce: string;
}

export interface ReplyGenerationOptions {
  regeneration?: ReplyRegenerationContext;
  onStrategy?: (update: {
    variationApplied?: boolean;
    retryContextCompacted?: boolean;
  }) => void | Promise<void>;
}

function regenerationInstructionOf(value?: ReplyRegenerationContext) {
  if (!value?.previousMessages.length) return "";
  const previous = value.previousMessages
    .map((message) => message.trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((message, index) => `${index + 1}. ${message.slice(0, 400)}`)
    .join("\n");
  if (!previous) return "";
  return [
    "这是一次用户主动要求的重新生成。上一版回复仅用于去重参考，不是新的对话事实。",
    "保留角色核心设定、关系状态、已知事实和说话习惯，但不要复用上一版的关键短语、句式顺序或相同情绪落点。至少改变回应角度、信息推进、情绪动作、语气节奏中的两项；不得为了不同而捏造事实或违背当前用户输入。",
    `本次变化标记：${value.variationNonce}`,
    `上一版可见回复（不要直接复述）：\n${previous}`,
  ].join("\n");
}

export async function generateCharacterReplyTurn(
  settings: ProviderSettings,
  context: ChatItem[],
  character: Character,
  bilingual: boolean,
  scene: "private" | "group" | "proactive",
  innerVoiceRequired: boolean,
  signal?: AbortSignal,
  musicActionEnabled = false,
  islandActionEnabled = false,
  stickerCatalog: ReplyStickerCatalogItem[] = [],
  onProviderAttempt?: (attempt: number) => void | Promise<void>,
  invokeProvider?: ProviderChatInvoker,
  countPlanOverride?: ReplyBubbleCountPlan | number,
  onCountValidation?: (attempt: 1 | 2, diagnostics: ReplyBubbleCountDiagnostics) => void | Promise<void>,
  generationOptions?: ReplyGenerationOptions,
): Promise<GeneratedReplyTurn> {
  const basePlan = replyBubblePlanOf(character, context, scene),
    countPlan = typeof countPlanOverride === "object"
      ? countPlanOverride
      : typeof countPlanOverride === "number"
        ? { mode: "exact" as const, min: countPlanOverride, max: countPlanOverride, preferred: countPlanOverride }
        : replyBubbleCountPlanOf(character, context, scene),
    plan = {
      ...basePlan,
      range: { min: countPlan.min, max: countPlan.max, adaptive: countPlan.mode === "adaptive" },
      adaptive: countPlan.mode === "adaptive",
      targetCount: countPlan.preferred,
    },
    range = plan.range;
  let lastFormatError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const compactStreamingRetry = attempt === 1 && shouldUseCompactStreamingRetry(lastFormatError);
    const regenerationInstruction = regenerationInstructionOf(generationOptions?.regeneration);
    await generationOptions?.onStrategy?.({
      variationApplied: Boolean(regenerationInstruction),
      retryContextCompacted: compactStreamingRetry,
    });
    const request: ChatItem = {
      role: "user",
      content:
        replyBubbleInstruction(
          character,
          bilingual,
          scene,
          innerVoiceRequired,
          musicActionEnabled,
          islandActionEnabled,
          plan,
          stickerCatalog,
          { compactComplete: compactStreamingRetry },
        ) +
          (attempt
            ? compactStreamingRetry
              ? " The previous provider response was cut or its API envelope was damaged. Generate the entire turn again from the beginning as compact complete JSON. Do not continue, quote, or merge any previous partial output."
              : " The previous response did not satisfy the complete JSON, message-count, translation, inner-voice, or conversational-rhythm requirements. Rewrite the entire turn and return every required field."
            : "") +
        (regenerationInstruction ? `\n\n${regenerationInstruction}` : ""),
    };
    try {
      // Preserve the full persona/history for content or count retries. Compact only
      // when the transport itself was incomplete, otherwise a retry can become a
      // shorter and more generic answer simply because the protocol failed.
      const sourceContext = compactStreamingRetry ? compactChatItemsForRetry(context) : context;
      const requestItems = [...sourceContext, request];
      let latestUserIndex = -1;
      for (let index = sourceContext.length - 1; index >= 0; index -= 1) {
        if (sourceContext[index]?.role === "user") {
          latestUserIndex = index;
          break;
        }
      }
      const requiredIndexes = [requestItems.length - 1];
      if (latestUserIndex >= 0) requiredIndexes.push(latestUserIndex);
      const fitted = fitChatItemsToInternalBudget(requestItems, { requiredIndexes });
      await onProviderAttempt?.(attempt + 1);
      const options = {
        stream: compactStreamingRetry,
        signal,
        temperature: generationOptions?.regeneration
          ? Math.min(1.2, Math.max(settings.temperature, 0.55))
          : settings.temperature,
        timeoutMs: null,
      } as const;
      const response = invokeProvider
        ? await invokeProvider(
            { ...settings, stream: compactStreamingRetry },
            fitted.items,
            options,
            attempt ? "regeneration" : "generation",
          )
        : await new OpenAIProvider({ ...settings, stream: compactStreamingRetry }).chatWithMeta(
            fitted.items,
            options,
          );
      // A provider may report a length finish reason after emitting a complete role protocol.
      // Validate the returned JSON first; only genuinely incomplete protocol data should fail.
      const normalized = parseStrictReplyTurn(
        response.text,
        bilingual,
        range,
        innerVoiceRequired,
        response,
        countPlan,
      );
      if (normalized.countDiagnostics)
        await onCountValidation?.((attempt + 1) as 1 | 2, normalized.countDiagnostics);
      if (normalized.compliant)
        return { ...normalized, targetCount: countPlan.preferred, countPlan };
      const diagnostics = normalized.countDiagnostics;
      lastFormatError = new ProviderError(
        "format",
        countPlan.mode === "exact"
          ? "\u89d2\u8272\u56de\u590d\u672a\u8fbe\u5230\u5df2\u8bbe\u7f6e\u7684\u7cbe\u786e\u6c14\u6ce1\u6570\u91cf"
          : `\u89d2\u8272\u56de\u590d\u8d85\u51fa\u5df2\u8bbe\u7f6e\u7684 ${countPlan.min}?${countPlan.max} \u6761\u8303\u56f4\uff0c\u4e14\u65e0\u6cd5\u5728\u4e0d\u6539\u53d8\u5185\u5bb9\u7684\u60c5\u51b5\u4e0b\u5b89\u5168\u8c03\u6574`,
        "",
        createApiErrorInfo("format", {
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
        }),
      );
    } catch (error) {
      if (error instanceof ProviderError && error.kind === "aborted") throw error;
      if (!(error instanceof ProviderError) || (error.kind !== "format" && !isContextOverflowError(error)))
        throw error;
      lastFormatError = error;
    }
  }
  throw (
    lastFormatError ??
    new ProviderError("format", "角色没有返回完整心声和消息")
  );
}
export async function generateCharacterReplyBubbles(
  settings: ProviderSettings,
  context: ChatItem[],
  character: Character,
  bilingual: boolean,
  scene: "private" | "group" | "proactive",
  signal?: AbortSignal,
): Promise<ReplyBubblePart[]> {
  return (
    await generateCharacterReplyTurn(
      settings,
      context,
      character,
      bilingual,
      scene,
      false,
      signal,
    )
  ).parts;
}
export async function generateCharacterMessageGroup(
  settings: ProviderSettings,
  context: ChatItem[],
  character: Character,
  signal?: AbortSignal,
) {
  return (
    await generateCharacterReplyBubbles(
      settings,
      context,
      character,
      false,
      "group",
      signal,
    )
  ).map((item) => item.content);
}
export async function generateCharacterMessageGroupBilingual(
  settings: ProviderSettings,
  context: ChatItem[],
  character: Character,
  signal?: AbortSignal,
) {
  return generateCharacterReplyBubbles(
    settings,
    context,
    character,
    true,
    "group",
    signal,
  );
}

