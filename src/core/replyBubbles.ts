import { createApiErrorInfo, ProviderError, type ProviderChatResult } from "./provider";
import { parseStructuredJson, parseStructuredJsonWithMeta, StructuredJsonError, type StructuredJsonDiagnostics } from "./structuredJson";
import { innerVoiceInstruction, parseGeneratedInnerVoice, parseGeneratedInnerVoiceFromRoot, type GeneratedInnerVoice } from "./innerVoice";
import type { Character, CharacterIslandAction, CharacterMusicAction } from "./types";

export interface ReplyBubblePart {
  content: string;
  translation?: string;
}
export interface ReplyBubbleRange {
  min: number;
  max: number;
  adaptive?: boolean;
}
export interface ReplyBubblePlan {
  range: ReplyBubbleRange;
  preferredMin: number;
  preferredMax: number;
  recentCounts: number[];
  latestUserLength: number;
  adaptive: boolean;
}
type ReplyContextItem = { role: "system" | "user" | "assistant"; content: string };
export interface NormalizedReplyBubbles {
  parts: ReplyBubblePart[];
  compliant: boolean;
}
export interface GeneratedReplyTurn extends NormalizedReplyBubbles {
  innerVoice?: GeneratedInnerVoice;
  innerVoiceFormatError?: boolean;
  musicAction?: CharacterMusicAction;
  islandAction?: CharacterIslandAction;
  stickerId?: string;
}
export interface ReplyStickerCatalogItem {
  id: string;
  name: string;
  description: string;
}

const clamp = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(1, Math.min(8, Math.trunc(parsed)))
    : fallback;
};
export function replyBubbleRangeOf(character: Character): ReplyBubbleRange {
  const configuredMin = character.chatSettings?.minReplyMessages,
    configuredMax = character.chatSettings?.maxReplyMessages,
    legacyDefaultRange =
      character.chatSettings?.replyMessageRangeMode === undefined &&
      configuredMin === 2 &&
      configuredMax === 4;
  if (
    character.chatSettings?.replyMessageRangeMode === "adaptive" ||
    legacyDefaultRange ||
    !Number.isFinite(configuredMin) ||
    !Number.isFinite(configuredMax)
  )
    return { min: 1, max: 8, adaptive: true };
  const min = clamp(configuredMin, 1),
    rawMax = clamp(configuredMax, 8);
  return { min, max: Math.max(min, rawMax), adaptive: false };
}
function recentAssistantTurnCounts(context: ReplyContextItem[], limit = 3) {
  const counts: number[] = [];
  let current = 0;
  for (let index = context.length - 1; index >= 0; index--) {
    if (context[index].role === "assistant") {
      current += 1;
      continue;
    }
    if (current) {
      counts.push(current);
      current = 0;
      if (counts.length >= limit) break;
    }
  }
  if (current && counts.length < limit) counts.push(current);
  return counts;
}
function punctuationCount(value: string, pattern: RegExp) {
  return value.match(pattern)?.length ?? 0;
}
export function replyBubblePlanOf(
  character: Character,
  context: ReplyContextItem[],
  scene: "private" | "group" | "proactive",
): ReplyBubblePlan {
  const range = replyBubbleRangeOf(character);
  if (!range.adaptive)
    return {
      range,
      preferredMin: range.min,
      preferredMax: range.max,
      recentCounts: recentAssistantTurnCounts(context),
      latestUserLength: 0,
      adaptive: false,
    };
  const latestUser = [...context].reverse().find((item) => item.role === "user")?.content.trim() ?? "",
    latestUserLength = visibleCharacterCount(latestUser),
    questionCount = punctuationCount(latestUser, /[?!\uFF1F]/gu),
    sentenceCount = punctuationCount(latestUser, /[\u3002\uFF01\uFF1F!?]/gu),
    clauseCount = punctuationCount(latestUser, /[\uFF0C\u3001\uFF1B\uFF1A,;:]/gu);
  let preferredMin = 2,
    preferredMax = 4;
  if (scene === "proactive") {
    preferredMin = 1;
    preferredMax = 3;
  } else if (!latestUser) {
    preferredMin = 1;
    preferredMax = 4;
  } else if (latestUserLength <= 18 && questionCount <= 1 && !latestUser.includes("\n")) {
    preferredMin = 1;
    preferredMax = 2;
  } else if (
    latestUserLength >= 60 ||
    questionCount >= 2 ||
    sentenceCount >= 3 ||
    clauseCount >= 4 ||
    latestUser.includes("\n")
  ) {
    preferredMin = 3;
    preferredMax = 6;
  }
  return {
    range,
    preferredMin,
    preferredMax,
    recentCounts: recentAssistantTurnCounts(context),
    latestUserLength,
    adaptive: true,
  };
}
export function adaptiveReplyRetryReason(
  plan: ReplyBubblePlan,
  parts: ReplyBubblePart[],
) {
  if (!plan.adaptive) return "";
  if (parts.length > plan.preferredMax)
    return `The reply over-expanded into ${parts.length} bubbles for a turn that should usually need ${plan.preferredMin}-${plan.preferredMax}. Rewrite more concisely without filler or repeated concern.`;
  const recent = plan.recentCounts.slice(0, 2);
  if (
    parts.length > 1 &&
    recent.length === 2 &&
    recent.every((count) => count === parts.length)
  )
    return `The last turns already used ${parts.length} bubbles repeatedly. Keep the meaning natural but choose a different concise rhythm instead of repeating the same count.`;
  return "";
}
function stripFence(text: string) {
  return text
    .trim()
    .replace(/^\x60\x60\x60(?:json)?\s*/i, "")
    .replace(/\s*\x60\x60\x60$/i, "");
}
function stripSequencePrefix(value: string) {
  return value.replace(/^\s*(?:(?:\d{1,2}|[\u2460-\u2473])[.\u3001\uFF0E)\uFF09:\uFF1A]\s+|[\uFF08(]\d{1,2}[\uFF09)]\s*)/, "");
}
const TARGET_BUBBLE_GRAPHEMES = 20;
const SOFT_MAX_BUBBLE_GRAPHEMES = 28;
type SegmenterLike = { segment(value:string):Iterable<{segment:string}> };

function graphemes(value:string){
 const Segmenter=(Intl as unknown as {Segmenter?:new(locale?:string,options?:{granularity:"grapheme"})=>SegmenterLike}).Segmenter;
 if(Segmenter)return [...new Segmenter("zh-CN",{granularity:"grapheme"}).segment(value)].map(item=>item.segment);
 return Array.from(value);
}
export function visibleCharacterCount(value:string){return graphemes(value).length}
function paragraphParts(value:string){
 return value.split(/(?:\r?\n){2,}/).map(item=>item.trim()).filter(Boolean);
}
function sentenceParts(value:string){
 return (value.trim().match(/[^。！？!?]+[。！？!?]+[”’"')）】》」』]*|[^。！？!?]+$/gu)??[]).map(item=>item.trim()).filter(Boolean);
}
function clauseParts(value:string){
 return (value.trim().match(/[^，、；：,;:]+[，、；：,;:]+|[^，、；：,;:]+$/gu)??[]).map(item=>item.trim()).filter(Boolean);
}
function joinText(left:string,right:string){return /[A-Za-z0-9]$/.test(left)&&/^[A-Za-z0-9]/.test(right)?`${left} ${right}`:`${left}${right}`}
function packPieces(parts:string[],maximum=TARGET_BUBBLE_GRAPHEMES){
 const rows:string[]=[];
 for(const part of parts){
  const previous=rows.at(-1);
  if(previous&&visibleCharacterCount(joinText(previous,part))<=maximum)rows[rows.length-1]=joinText(previous,part);
  else rows.push(part);
 }
 return rows;
}
function englishPhraseParts(value:string){
 if(!/\s/u.test(value)||visibleCharacterCount(value)<=SOFT_MAX_BUBBLE_GRAPHEMES)return [value];
 const words=value.trim().split(/\s+/u),rows:string[]=[];
 for(const word of words){
  const previous=rows.at(-1),next=previous?`${previous} ${word}`:word;
  if(previous&&visibleCharacterCount(next)>SOFT_MAX_BUBBLE_GRAPHEMES)rows.push(word);
  else if(previous)rows[rows.length-1]=next;
  else rows.push(word);
 }
 return rows;
}
function semanticParts(value:string){
 const sentences=sentenceParts(value),rows:string[]=[];
 for(const sentence of sentences.length?sentences:[value.trim()]){
  if(visibleCharacterCount(sentence)<=SOFT_MAX_BUBBLE_GRAPHEMES){rows.push(sentence);continue}
  const clauses=clauseParts(sentence);
  if(clauses.length>1){rows.push(...packPieces(clauses.flatMap(englishPhraseParts)));continue}
  rows.push(...englishPhraseParts(sentence));
 }
 return rows.filter(Boolean);
}
function splitPair(part:ReplyBubblePart,mode:"paragraph"|"semantic"="paragraph"):ReplyBubblePart[]{
 const split=mode==="semantic"?semanticParts:paragraphParts,content=split(part.content);
 if(content.length<=1)return [part];
 if(!part.translation)return content.map(value=>({content:value}));
 const translations=split(part.translation);
 if(translations.length!==content.length)return [part];
 return content.map((value,index)=>({content:value,translation:translations[index]}));
}
function mergePair(left:ReplyBubblePart,right:ReplyBubblePart):ReplyBubblePart|undefined{
 if(Boolean(left.translation)!==Boolean(right.translation))return;
 const content=joinText(left.content,right.content);
 if(visibleCharacterCount(content)>SOFT_MAX_BUBBLE_GRAPHEMES)return;
 const translation=left.translation&&right.translation?joinText(left.translation,right.translation):undefined;
 if(translation&&visibleCharacterCount(translation)>SOFT_MAX_BUBBLE_GRAPHEMES)return;
 return {content,translation};
}
function mergeToMaximum(parts:ReplyBubblePart[],maximum:number){
 const rows=[...parts];
 while(rows.length>maximum){
  let candidate:{index:number;merged:ReplyBubblePart;length:number}|undefined;
  for(let index=0;index<rows.length-1;index++){
   const merged=mergePair(rows[index],rows[index+1]);
   if(!merged)continue;
   const length=visibleCharacterCount(merged.content);
   if(!candidate||length<candidate.length)candidate={index,merged,length};
  }
  if(!candidate)break;
  rows.splice(candidate.index,2,candidate.merged);
 }
 return rows;
}

export function normalizeReplyBubbles(
  input: ReplyBubblePart[],
  range: ReplyBubbleRange,
): NormalizedReplyBubbles {
  let parts: ReplyBubblePart[] = input
    .map((item) => ({
      content: stripSequencePrefix(item.content.trim()),
      translation: item.translation
        ? stripSequencePrefix(item.translation.trim()) || undefined
        : undefined,
    }))
    .filter((item) => item.content)
    .flatMap((item) => splitPair(item, "paragraph"))
    .flatMap((item) => splitPair(item, "semantic"))
    .map((item) => ({
      content: stripSequencePrefix(item.content),
      translation: item.translation
        ? stripSequencePrefix(item.translation) || undefined
        : undefined,
    }))
    .filter((item) => item.content);
  while (parts.length < range.min) {
    const candidates = parts
        .map((part, index) => ({ index, split: splitPair(part, "semantic") }))
        .filter((item) => item.split.length > 1)
        .sort((a, b) => b.split.length - a.split.length),
      candidate = candidates[0];
    if (!candidate) break;
    parts.splice(candidate.index, 1, ...candidate.split);
  }
  parts = mergeToMaximum(parts, range.max);
  return {
    parts,
    compliant: parts.length >= range.min && parts.length <= range.max,
  };
}
function parsedReplyRoot(raw: string): unknown {
  return parseStructuredJson(raw);
}
function messageRowsOf(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return;
  const row = value as Record<string, unknown>;
  if (Array.isArray(row.messages)) return row.messages;
  for (const key of ["content", "message", "reply"] as const) {
    const candidate = row[key];
    if (typeof candidate === "string") return [candidate];
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === "object") return [candidate];
  }
}
export function parseReplyBubbles(
  raw: string,
  bilingual: boolean,
  range: ReplyBubbleRange,
): NormalizedReplyBubbles {
  let value: unknown;
  try {
    value = parsedReplyRoot(raw);
  } catch {
    if (!bilingual && raw.trim())
      return normalizeReplyBubbles([{ content: raw.trim() }], range);
    throw new ProviderError("format", "角色回复格式不正确，请重试");
  }
  const messages = messageRowsOf(value);
  if (!messages)
    throw new ProviderError("format", "角色回复缺少 messages 数组，请重试");
  const parts: ReplyBubblePart[] = [];
  for (const item of messages) {
    if (typeof item === "string") {
      if (bilingual)
        throw new ProviderError("format", "角色回复缺少 messages 数组，请重试????");
      if (item.trim()) parts.push({ content: item.trim() });
      continue;
    }
    if (!item || typeof item !== "object")
      throw new ProviderError("format", "角色回复气泡格式无法识别");
    const row = item as Record<string, unknown>,
      content = row.content ?? row.message ?? row.reply,
      translation = row.translation;
    if (typeof content !== "string" || !content.trim())
      throw new ProviderError("format", "角色回复包含空气泡");
    if (bilingual && (typeof translation !== "string" || !translation.trim()))
      throw new ProviderError("format", "角色回复缺少 messages 数组，请重试????");
    parts.push({
      content: content.trim(),
      translation: typeof translation === "string" ? translation.trim() : undefined,
    });
  }
  if (!parts.length) throw new ProviderError("format", "角色回复包含空气泡");
  return normalizeReplyBubbles(parts, range);
}
function parseMusicActionFromRoot(root: unknown): CharacterMusicAction | undefined {
  const action = (root as { musicAction?: unknown })?.musicAction;
  if (!action || typeof action !== "object") return;
  const type = (action as { type?: unknown }).type;
  if (type === "accept-invite" || type === "decline-invite" || type === "pause" || type === "next" || type === "leave") return { type };
  if (type === "invite") { const trackId = (action as { trackId?: unknown }).trackId; return typeof trackId === "string" && trackId ? { type, trackId } : { type }; }
  if (type === "play") { const trackId = (action as { trackId?: unknown }).trackId; if (typeof trackId === "string" && trackId) return { type, trackId }; }
  if (type === "queue-track") {
    const value = action as { trackId?: unknown; placement?: unknown; reason?: unknown };
    if (typeof value.trackId === "string" && value.trackId && (value.placement === "next" || value.placement === "end")) return { type, trackId: value.trackId, placement: value.placement, ...(typeof value.reason === "string" && value.reason.trim() ? { reason: value.reason.trim().slice(0, 240) } : {}) };
  }
  if (type === "search-track") {
    const value = action as { query?: unknown; placement?: unknown; reason?: unknown };
    if (typeof value.query === "string" && value.query.trim() && (value.placement === "next" || value.placement === "end")) return { type, query: value.query.trim().slice(0, 120), placement: value.placement, ...(typeof value.reason === "string" && value.reason.trim() ? { reason: value.reason.trim().slice(0, 240) } : {}) };
  }
  if (type === "propose-control") {
    const value = action as { control?: unknown; reason?: unknown };
    if ((value.control === "pause" || value.control === "next" || value.control === "clear-queue") && typeof value.reason === "string" && value.reason.trim()) return { type, control: value.control, reason: value.reason.trim().slice(0, 240) };
  }
  return;
}

function parseStickerIdFromRoot(root: unknown): string | undefined {
  const value = (root as { stickerId?: unknown })?.stickerId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseIslandActionFromRoot(root: unknown): CharacterIslandAction | undefined {
  const action = (root as { islandAction?: unknown })?.islandAction;
  if (!action || typeof action !== "object") return;
  const value = action as Record<string, unknown>, type = value.type;
  if (type === "accept-invite") return { type };
  if (type === "decline-invite" && typeof value.reason === "string" && value.reason.trim()) return { type, reason: value.reason.trim().slice(0, 240) };
  if (type === "leave-letter" && typeof value.text === "string" && value.text.trim()) return { type, text: value.text.trim().slice(0, 1200), ...(typeof value.title === "string" && value.title.trim() ? { title: value.title.trim().slice(0, 80) } : {}) };
  if (type === "write-diary" && typeof value.text === "string" && value.text.trim()) return { type, text: value.text.trim().slice(0, 1200) };
  if (type === "water-plant" && typeof value.objectId === "string" && value.objectId) return { type, objectId: value.objectId };
  if (type === "interact-pet" && typeof value.objectId === "string" && value.objectId && typeof value.action === "string" && value.action.trim()) return { type, objectId: value.objectId, action: value.action.trim().slice(0, 80) };
  if (type === "move-decoration" && typeof value.objectId === "string" && value.objectId && Number.isFinite(Number(value.x)) && Number.isFinite(Number(value.y))) return { type, objectId: value.objectId, x: Number(value.x), y: Number(value.y) };
  if (type === "suggest-purchase" && typeof value.catalogId === "string" && value.catalogId && typeof value.reason === "string" && value.reason.trim()) return { type, catalogId: value.catalogId, reason: value.reason.trim().slice(0, 240) };
  if (type === "progress-wish" && typeof value.entryId === "string" && value.entryId && typeof value.note === "string" && value.note.trim()) return { type, entryId: value.entryId, note: value.note.trim().slice(0, 240) };
  return;
}

function normalizedBubblesFromRows(
  messages: unknown[],
  bilingual: boolean,
  range: ReplyBubbleRange,
): NormalizedReplyBubbles {
  const parts: ReplyBubblePart[] = [];
  for (const item of messages) {
    if (typeof item === "string") {
      if (bilingual)
        throw new ProviderError("format", "双语角色回复缺少逐条译文");
      if (!item.trim()) throw new ProviderError("format", "角色回复包含空气泡");
      parts.push({ content: item.trim() });
      continue;
    }
    if (!item || typeof item !== "object")
      throw new ProviderError("format", "角色回复气泡格式无法识别");
    const row = item as Record<string, unknown>;
    const content = row.content ?? row.message ?? row.reply;
    const translation = row.translation;
    if (typeof content !== "string" || !content.trim())
      throw new ProviderError("format", "角色回复包含空气泡");
    if (bilingual && (typeof translation !== "string" || !translation.trim()))
      throw new ProviderError("format", "双语角色回复缺少逐条译文");
    parts.push({
      content: content.trim(),
      translation: typeof translation === "string" ? translation.trim() : undefined,
    });
  }
  if (!parts.length) throw new ProviderError("format", "角色没有返回非空消息");
  return normalizeReplyBubbles(parts, range);
}

function turnFromRoot(
  root: unknown,
  bilingual: boolean,
  range: ReplyBubbleRange,
  innerVoiceRequired: boolean,
  strict: boolean,
): GeneratedReplyTurn {
  const row = root && typeof root === "object" && !Array.isArray(root)
    ? root as Record<string, unknown>
    : undefined;
  const messages = strict ? (row && Array.isArray(row.messages) ? row.messages : undefined) : messageRowsOf(root);
  if (!messages) throw new ProviderError("format", "角色回复缺少 messages 数组");
  const normalized = normalizedBubblesFromRows(messages, bilingual, range);
  let innerVoice: GeneratedInnerVoice | undefined;
  let innerVoiceFormatError = false;
  try {
    innerVoice = parseGeneratedInnerVoiceFromRoot(root, innerVoiceRequired);
  } catch (error) {
    if (!innerVoiceRequired || !(error instanceof ProviderError) || error.kind !== "format") throw error;
    if (strict) throw error;
    innerVoiceFormatError = true;
  }
  return {
    ...normalized,
    innerVoice,
    innerVoiceFormatError,
    musicAction: parseMusicActionFromRoot(root),
    islandAction: parseIslandActionFromRoot(root),
    stickerId: parseStickerIdFromRoot(root),
  };
}

export function parseReplyTurn(
  raw: string,
  bilingual: boolean,
  range: ReplyBubbleRange,
  innerVoiceRequired: boolean,
): GeneratedReplyTurn {
  const root = parsedReplyRoot(raw);
  return turnFromRoot(root, bilingual, range, innerVoiceRequired, false);
}

function strictTurnError(
  code: "missing_messages" | "missing_inner_voice" | "invalid_role_protocol" | "truncated_json",
  message: string,
  response?: ProviderChatResult,
  failureStage: "provider-parse" | "role-protocol" | "inner-voice" = "role-protocol",
  diagnostics?: StructuredJsonDiagnostics,
) {
  return new ProviderError(
    "format",
    message,
    "",
    createApiErrorInfo("format", {
      providerCode: code,
      detail: message,
      responseShape: response?.responseShape,
      rawLength: response?.rawLength,
      parseStatus: diagnostics?.parseStatus ?? response?.parseStatus,
      strictParseSucceeded: diagnostics?.strictParseSucceeded ?? response?.strictParseSucceeded,
      repairAttempted: diagnostics?.repairAttempted ?? response?.repairAttempted,
      repairedParseSucceeded: diagnostics?.repairedParseSucceeded ?? response?.repairedParseSucceeded,
      outerContainerClosed: diagnostics?.outerContainerClosed ?? response?.outerContainerClosed,
      unterminatedString: diagnostics?.unterminatedString ?? response?.unterminatedString,
      hasMessages: diagnostics?.hasMessages ?? response?.hasMessages,
      hasInnerVoice: diagnostics?.hasInnerVoice ?? response?.hasInnerVoice,
      transportMarkedIncomplete: response?.transportMarkedIncomplete,
      protocolValidationReached: true,
      transportMode: response?.transportMode,
      receivedChars: response?.receivedChars,
      receivedBytes: response?.receivedBytes,
      declaredContentLength: response?.declaredContentLength,
      contentLengthMatched: response?.contentLengthMatched,
      completeVisibleFieldRecovered: response?.completeVisibleFieldRecovered,
      tailKind: response?.tailKind,
      finishReason: response?.finishReason,
      failureStage,
    }),
  );
}

export function parseStrictReplyTurn(
  raw: string,
  bilingual: boolean,
  range: ReplyBubbleRange,
  innerVoiceRequired: boolean,
  response?: ProviderChatResult,
): GeneratedReplyTurn {
  let root: unknown;
  let diagnostics: StructuredJsonDiagnostics | undefined;
  try {
    const parsed = parseStructuredJsonWithMeta(raw, {
      transportMarkedIncomplete: response?.truncated,
    });
    root = parsed.value;
    diagnostics = parsed.diagnostics;
  } catch (error) {
    const structuredError = error instanceof StructuredJsonError ? error : undefined;
    const truncated =
      response?.truncated ||
      response?.parseStatus === "truncated-json" ||
      structuredError?.reason === "incomplete";
    throw strictTurnError(
      truncated ? "truncated_json" : "invalid_role_protocol",
      truncated
        ? "服务返回内容被截断或结构不完整"
        : "服务返回的 JSON 无法满足角色回复协议",
      response,
      "provider-parse",
      structuredError?.diagnostics,
    );
  }
  if (!root || typeof root !== "object" || Array.isArray(root))
    throw strictTurnError("invalid_role_protocol", "服务返回的 JSON 不是完整角色回复对象", response, "role-protocol", diagnostics);
  const row = root as Record<string, unknown>;
  if (!Array.isArray(row.messages) || !row.messages.length)
    throw strictTurnError("missing_messages", "服务返回的 JSON 缺少非空 messages 数组", response, "role-protocol", diagnostics);
  try {
    const turn = turnFromRoot(root, bilingual, range, innerVoiceRequired, true);
    if (innerVoiceRequired && !turn.innerVoice)
      throw strictTurnError("missing_inner_voice", "服务返回的 JSON 缺少完整心声结构", response, "inner-voice", diagnostics);
    return turn;
  } catch (error) {
    if (error instanceof ProviderError && error.apiError) throw error;
    const message = error instanceof Error ? error.message : "服务返回的 JSON 未通过角色回复协议校验";
    const isInnerVoice = innerVoiceRequired && /心声|章节|情绪摘要/.test(message);
    throw strictTurnError(
      isInnerVoice ? "missing_inner_voice" : "invalid_role_protocol",
      message,
      response,
      isInnerVoice ? "inner-voice" : "role-protocol",
      diagnostics,
    );
  }
}
export interface ReplyProtocolOptions {
  compactComplete?: boolean;
}
export function replyBubbleInstruction(
  character: Character,
  bilingual: boolean,
  scene: "private" | "group" | "proactive",
  innerVoiceRequired = false,
  musicActionEnabled = false,
  islandActionEnabled = false,
  plan?: ReplyBubblePlan,
  stickerCatalog: ReplyStickerCatalogItem[] = [],
  options: ReplyProtocolOptions = {},
) {
  const resolvedPlan = plan ?? replyBubblePlanOf(character, [], scene),
    range = resolvedPlan.range,
    setting = scene === "group" ? "current group chat" : scene === "proactive" ? "proactive private message" : "private chat",
    messageShape = bilingual
      ? '{"messages":[{"content":"original character message","translation":"faithful Simplified Chinese translation"}]'
      : '{"messages":[{"content":"character message"}]';
  let shape = messageShape;
  if (innerVoiceRequired) shape += ',"innerVoice":{"sections":{"physicalState":"简体中文","emotionAndMind":"简体中文","unspokenWords":"简体中文","selfDeception":"简体中文","triggeredMemory":"简体中文","angelThought":"简体中文","devilThought":"简体中文"},"continuity":{"emotion":"简短情绪","concern":"可选","pendingIntent":"可选","physicalState":"可选"}}';
  if (musicActionEnabled) shape += ',"musicAction":null';
  if (islandActionEnabled) shape += ',"islandAction":null';
  if (stickerCatalog.length) shape += ',"stickerId":null';
  shape += '}';
  return [
    "Reply as " + character.name + " in the " + setting + ".",
    range.adaptive
      ? "There is no preset reply count. Decide the number of separate message bubbles naturally from the immediate context, the character persona, emotion, and conversational rhythm. For this turn, usually prefer " + resolvedPlan.preferredMin + "-" + resolvedPlan.preferredMax + " bubbles, but semantic necessity matters more than hitting that soft range."
      : "Return between " + range.min + " and " + range.max + " separate message bubbles.",
    range.adaptive && resolvedPlan.recentCounts.length
      ? "Recent character turns used these bubble counts, newest first: " + resolvedPlan.recentCounts.join(", ") + ". Vary the rhythm when natural instead of mechanically repeating the same count."
      : "",
    range.adaptive ? "Never default to five bubbles. Use one or two for a simple reply, and add another bubble only when it contributes a new complete meaning." : "",
    "Each item is one message the character actually sends. Do not put multiple intended bubbles into one item with blank lines.",
    "Keep each bubble around 20 visible characters including punctuation and emoji. Finish one semantically complete sentence or phrase, then continue the remaining thought in a new bubble. Semantic completeness matters more than an exact character or bubble count.",
    "Never prefix bubble content with a number, ordered-list marker, or bullet such as 1., 2), or ①.",
    "Choose the exact count naturally. Do not repeat content, add filler, restate the same concern, or mechanically cut one sentence merely to reach the count.",
    innerVoiceRequired ? innerVoiceInstruction(bilingual) : "",
    musicActionEnabled ? "When listening context is present, use at most one musicAction and only when naturally relevant. Track actions may only use candidate IDs explicitly supplied by the listening context. Balanced mode requires propose-control for pause, next, or clear-queue." : "",
    islandActionEnabled ? "When the island context explicitly requires an invitation decision, islandAction must not be null. Otherwise use at most one islandAction and only when naturally relevant." : "",
    stickerCatalog.length ? `Available stickers (use only an exact id from this list): ${JSON.stringify(stickerCatalog)}. Set stickerId only when one sticker naturally adds an in-character emotion or attitude to this exact turn. Use at most one, use stickers sparingly, never send one merely because it is available, and do not explain or repeat the sticker meaning in visible text. Otherwise return stickerId as null.` : "",
    options.compactComplete
      ? "This is the one complete compact rewrite. Return exactly one single-line minified JSON object with no Markdown, code fence, explanation, or surrounding text. Keep every visible bubble short but semantically complete. Keep all seven innerVoice section values concise, specific, non-empty Simplified Chinese. In continuity, emotion is mandatory; omit concern, pendingIntent, and physicalState unless essential. Never omit messages, required translations, or any of the seven innerVoice sections."
      : "",
    "Return strict JSON only: " + shape,
  ].filter(Boolean).join(" ");
}


