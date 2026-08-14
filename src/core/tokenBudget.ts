import type { ChatItem } from "./context";
import type { LoreDecision } from "./lore";

export const INTERNAL_CONTEXT_WINDOW_TOKENS = 128_000;
export const INTERNAL_SAFETY_RESERVE_TOKENS = 8_000;
export const INTERNAL_REPLY_RESERVE_TOKENS = 16_000;
export const INTERNAL_INPUT_BUDGET_TOKENS =
  INTERNAL_CONTEXT_WINDOW_TOKENS -
  INTERNAL_SAFETY_RESERVE_TOKENS -
  INTERNAL_REPLY_RESERVE_TOKENS;
export const INTERNAL_LORE_BUDGET_TOKENS = 48_000;

export interface GenerationTokenBudget {
  estimatedInputTokens: number;
  requestedOutputTokens: number;
  effectiveOutputTokens: number;
  contextWindowTokens: number;
  safetyReserveTokens: number;
  truncatedInputSections: string[];
  injectedLoreTokens: number;
  skippedLoreEntries: number;
}

export interface PrioritizedPromptSection {
  id: string;
  content?: string | false | null;
  required?: boolean;
  priority?: number;
}

export interface FittedPromptSections {
  text: string;
  estimatedTokens: number;
  removedSections: string[];
}

export function estimateTextTokens(value: string) {
  if (!value) return 0;
  let tokens = 0;
  let asciiRun = 0;
  const flushAscii = () => {
    if (!asciiRun) return;
    tokens += Math.ceil(asciiRun / 3.5);
    asciiRun = 0;
  };
  for (const char of value) {
    if (/^[\x00-\x7F]$/.test(char)) asciiRun += 1;
    else {
      flushAscii();
      if (!/\s/.test(char)) tokens += 1;
    }
  }
  flushAscii();
  return Math.max(1, tokens);
}

export function estimateChatItemTokens(item: ChatItem) {
  return (
    6 +
    estimateTextTokens(item.content) +
    ((item.imageUrls?.length ?? 0) + (item.imageUrl ? 1 : 0)) * 1_100
  );
}

export function estimateChatTokens(items: ChatItem[]) {
  return items.reduce((sum, item) => sum + estimateChatItemTokens(item), 3);
}

export function loreDecisionTokenCount(items: LoreDecision[]) {
  return items
    .filter((item) => item.injected)
    .reduce((sum, item) => sum + estimateTextTokens(item.content), 0);
}

export function compactChatItemsForRetry(items: ChatItem[], ratio = 0.55) {
  if (items.length <= 3) return items;
  const system = items.filter((item) => item.role === "system");
  const nonSystem = items.filter((item) => item.role !== "system");
  let latestUserIndex = -1;
  for (let index = nonSystem.length - 1; index >= 0; index -= 1) {
    if (nonSystem[index]?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  const latestUser = latestUserIndex >= 0 ? nonSystem[latestUserIndex] : undefined;
  const history = latestUser ? nonSystem.slice(0, latestUserIndex) : nonSystem;
  const keep = Math.max(0, Math.floor(history.length * ratio));
  return [...system, ...history.slice(-keep), ...(latestUser ? [latestUser] : [])];
}

export interface FitChatItemsOptions {
  /** Indexes that must survive fitting, in addition to every system message. */
  requiredIndexes?: number[];
}

export class RequiredChatContextTooLargeError extends Error {
  readonly code = "required_context_too_large";
  constructor(public readonly estimatedTokens: number) {
    super("必要的角色设定、最新用户消息和回复协议超过内部输入预算");
    this.name = "RequiredChatContextTooLargeError";
  }
}

export function fitChatItemsToInternalBudget(
  items: ChatItem[],
  options: FitChatItemsOptions = {},
) {
  if (estimateChatTokens(items) <= INTERNAL_INPUT_BUDGET_TOKENS)
    return { items, removed: 0 };
  const requiredIndexes = new Set(options.requiredIndexes ?? []);
  items.forEach((item, index) => {
    if (item.role === "system") requiredIndexes.add(index);
  });
  const required = items.filter((_, index) => requiredIndexes.has(index));
  const requiredTokens = estimateChatTokens(required);
  if (requiredTokens > INTERNAL_INPUT_BUDGET_TOKENS)
    throw new RequiredChatContextTooLargeError(requiredTokens);
  const optional = items
    .map((item, index) => ({ item, index }))
    .filter(({ index }) => !requiredIndexes.has(index));
  const keptIndexes = new Set(requiredIndexes);
  let used = requiredTokens;
  for (let index = optional.length - 1; index >= 0; index -= 1) {
    const row = optional[index]!;
    const size = estimateChatItemTokens(row.item);
    if (used + size > INTERNAL_INPUT_BUDGET_TOKENS) continue;
    keptIndexes.add(row.index);
    used += size;
  }
  return {
    items: items.filter((_, index) => keptIndexes.has(index)),
    removed: optional.length - (keptIndexes.size - requiredIndexes.size),
  };
}

export function fitPrioritizedPromptSections(
  sections: PrioritizedPromptSection[],
  tokenBudget = INTERNAL_INPUT_BUDGET_TOKENS,
): FittedPromptSections {
  const normalized = sections
    .map((section, index) => ({
      ...section,
      index,
      content: typeof section.content === "string" ? section.content.trim() : "",
      priority: Number.isFinite(section.priority) ? Number(section.priority) : 0,
    }))
    .filter((section) => section.content);
  const required = normalized.filter((section) => section.required);
  const optional = normalized.filter((section) => !section.required);
  const selected = new Set(required.map((section) => section.index));
  let used = required.reduce(
    (sum, section) => sum + estimateTextTokens(section.content) + 2,
    0,
  );
  for (const section of [...optional].sort(
    (a, b) => b.priority - a.priority || b.index - a.index,
  )) {
    const size = estimateTextTokens(section.content) + 2;
    if (used + size > tokenBudget) continue;
    selected.add(section.index);
    used += size;
  }
  const kept = normalized.filter((section) => selected.has(section.index));
  return {
    text: kept.map((section) => section.content).join("\n\n"),
    estimatedTokens: used,
    removedSections: optional
      .filter((section) => !selected.has(section.index))
      .map((section) => section.id),
  };
}
