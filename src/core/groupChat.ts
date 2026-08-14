import { z } from "zod";
import { createApiErrorInfo, OpenAIProvider, ProviderError, isContextOverflowError, type ProviderChatInvoker } from "./provider";
import { coreSettingOf, personaOf } from "./character";
import type { Character, Message, ProviderSettings } from "./types";
import type { ChatItem } from "./context";
import { compactChatItemsForRetry, fitChatItemsToInternalBudget } from "./tokenBudget";
import {
  adaptiveReplyRetryReason,
  parseStrictReplyTurn,
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
      { stream: false, signal },
    );
    return validateReplyOrder(parse(raw), fallback);
  } catch (error) {
    if (error instanceof ProviderError && error.kind === "aborted") throw error;
    return fallback;
  }
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
): Promise<GeneratedReplyTurn> {
  const plan = replyBubblePlanOf(character, context, scene),
    range = plan.range;
  let lastFormatError: unknown,
    adaptiveRetryReason = "";
  for (let attempt = 0; attempt < 2; attempt++) {
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
        ) +
        (attempt
          ? " The previous response did not satisfy the complete JSON, message-count, translation, inner-voice, or conversational-rhythm requirements. Rewrite the entire turn and return every required field." + (adaptiveRetryReason ? " " + adaptiveRetryReason : "")
          : ""),
    };
    try {
      const sourceContext = attempt ? compactChatItemsForRetry(context) : context;
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
        stream: false,
        signal,
        temperature: attempt ? 0.1 : settings.temperature,
        timeoutMs: null,
      } as const;
      const response = invokeProvider
        ? await invokeProvider(
            { ...settings, stream: false },
            fitted.items,
            options,
            attempt ? "regeneration" : "generation",
          )
        : await new OpenAIProvider({ ...settings, stream: false }).chatWithMeta(
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
      );
      if (normalized.compliant) {
        const retryReason = adaptiveReplyRetryReason(plan, normalized.parts);
        if (!retryReason || attempt === 1) return normalized;
        adaptiveRetryReason = retryReason;
        lastFormatError = new ProviderError("format", "\u89d2\u8272\u56de\u590d\u5728\u81ea\u9002\u5e94\u6a21\u5f0f\u4e0b\u8fc7\u5ea6\u5c55\u5f00\u6216\u8fde\u7eed\u91cd\u590d\u76f8\u540c\u6761\u6570");
        continue;
      }
      lastFormatError = new ProviderError(
        "format",
        "\u89d2\u8272\u56de\u590d\u6761\u6570\u4e0d\u5728\u8bbe\u7f6e\u8303\u56f4\u5185",
      );
    } catch (error) {
      if (error instanceof ProviderError && error.kind === "aborted")
        throw error;
      if (!(error instanceof ProviderError) || (error.kind !== "format" && !isContextOverflowError(error)))
        throw error;
      lastFormatError = error;
    }
  }
  throw (
    lastFormatError ??
    new ProviderError("format", "\u89d2\u8272\u6ca1\u6709\u8fd4\u56de\u5b8c\u6574\u5fc3\u58f0\u548c\u6d88\u606f")
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



