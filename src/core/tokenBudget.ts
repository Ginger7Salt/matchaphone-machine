import type { ChatItem } from "./context";
import type { LoreDecision } from "./lore";

export const INTERNAL_CONTEXT_WINDOW_TOKENS = 128_000;
export const INTERNAL_SAFETY_RESERVE_TOKENS = 8_000;
export const INTERNAL_REPLY_RESERVE_TOKENS = 16_000;
export const INTERNAL_INPUT_BUDGET_TOKENS =
  INTERNAL_CONTEXT_WINDOW_TOKENS -
  INTERNAL_SAFETY_RESERVE_TOKENS -
  INTERNAL_REPLY_RESERVE_TOKENS;
/** Runtime lore budgets use characters because lore matching counts source characters. */
export const CHAT_PRIVATE_LORE_BUDGET_CHARS = 12_000;
export const CHAT_GROUP_LORE_BUDGET_CHARS = 16_000;
export const MEET_LORE_BUDGET_CHARS = 20_000;
/** Legacy export retained for callers outside the context compiler. */
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
  /** Required sections cannot be omitted; core sections are retained before optional context. */
  core?: boolean;
}

export interface FittedPromptSections {
  text: string;
  estimatedTokens: number;
  removedSections: string[];
  requiredTokens: number;
  coreTokens: number;
  optionalTokens: number;
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

function compactRetrySystemContent(content: string) {
  const limit = 14_000;
  if (content.length <= limit) return content;
  // buildContext places role rules and the core persona near the front, while optional
  // memories/lore and one-shot notes are later. Keep both ends without rewriting facts.
  const head = content.slice(0, 9_000).trimEnd();
  const tail = content.slice(-3_500).trimStart();
  return `${head}\n\n[低优先级上下文已为完整重生成压缩]\n\n${tail}`;
}

export function compactChatItemsForRetry(items: ChatItem[], ratio = 0.4) {
  if (items.length <= 3 && items.every((item) => item.role !== "system" || item.content.length <= 14_000)) return items;
  const system = items
    .filter((item) => item.role === "system")
    .map((item) => ({ ...item, content: compactRetrySystemContent(item.content) }));
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
  const core = normalized.filter((section) => !section.required && section.core);
  const optional = normalized.filter((section) => !section.required && !section.core);
  const selected = new Set(required.map((section) => section.index));
  const sizeOf = (section: { content: string }) => estimateTextTokens(section.content) + 2;
  let used = required.reduce((sum, section) => sum + sizeOf(section), 0);
  const requiredTokens = used;
  if (used > tokenBudget) throw new RequiredChatContextTooLargeError(used);
  for (const pool of [core, optional]) {
    for (const section of [...pool].sort(
      (a, b) => b.priority - a.priority || b.index - a.index,
    )) {
      const size = sizeOf(section);
      if (used + size > tokenBudget) continue;
      selected.add(section.index);
      used += size;
    }
  }
  const kept = normalized.filter((section) => selected.has(section.index));
  const coreTokens = kept.filter((section) => section.core).reduce((sum, section) => sum + sizeOf(section), 0);
  const optionalTokens = kept.filter((section) => !section.required && !section.core).reduce((sum, section) => sum + sizeOf(section), 0);
  return {
    text: kept.map((section) => section.content).join("\n\n"),
    estimatedTokens: used,
    removedSections: normalized.filter((section) => !selected.has(section.index)).map((section) => section.id),
    requiredTokens,
    coreTokens,
    optionalTokens,
  };
}
