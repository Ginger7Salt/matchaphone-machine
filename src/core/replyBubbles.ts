import { createApiErrorInfo, ProviderError, type ProviderChatResult } from "./provider";
import { parseStructuredJson, parseStructuredJsonWithMeta, StructuredJsonError, type StructuredJsonDiagnostics } from "./structuredJson";
import { innerVoiceInstruction, parseGeneratedInnerVoice, parseGeneratedInnerVoiceFromRoot, type GeneratedInnerVoice } from "./innerVoice";
import type { Character, CharacterIslandAction, CharacterMusicAction, ReplyBubbleCountDiagnostics, ReplyBubbleCountPlan } from "./types";

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
  targetCount: number;
}
type ReplyContextItem = { role: "system" | "user" | "assistant"; content: string };
export interface NormalizedReplyBubbles {
  parts: ReplyBubblePart[];
  compliant: boolean;
}
export interface GeneratedReplyTurn extends NormalizedReplyBubbles {
  innerVoice?: GeneratedInnerVoice;
  innerVoiceFormatError?: boolean;
  /** The local preference chosen before the provider call. */
  targetCount?: number;
  countPlan?: ReplyBubbleCountPlan;
  countDiagnostics?: ReplyBubbleCountDiagnostics;
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
function targetBubbleCount(range: ReplyBubbleRange, preferredMin: number, preferredMax: number) {
  if (!range.adaptive && range.min === range.max) return range.min;
  return Math.max(range.min, Math.min(range.max, Math.floor((preferredMin + preferredMax) / 2)));
}
function isSyntheticTurnPrompt(value: string) {
  const normalized = value.trim();
  return normalized.startsWith("\u8bf7\u6839\u636e\u4ee5\u4e0a\u5b8c\u6574\u5bf9\u8bdd") ||
    normalized.startsWith("\u8bf7\u4f9d\u636e\u4f60\u7684\u89d2\u8272\u8bbe\u5b9a") ||
    normalized.startsWith("Please participate naturally in the current group chat as ");
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
      targetCount: targetBubbleCount(range, range.min, range.max),
    };
  const latestUser = [...context].reverse().find((item) => item.role === "user" && !isSyntheticTurnPrompt(item.content))?.content.trim() ?? "",
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
    targetCount: targetBubbleCount(range, preferredMin, preferredMax),
  };
}
export function replyBubbleCountPlanOf(
  character: Character,
  context: ReplyContextItem[],
  scene: "private" | "group" | "proactive",
  preferredOverride?: number,
): ReplyBubbleCountPlan {
  const plan = replyBubblePlanOf(character, context, scene);
  const preferred = Number.isInteger(preferredOverride)
    ? Math.max(plan.range.min, Math.min(plan.range.max, Number(preferredOverride)))
    : plan.targetCount;
  return {
    mode: plan.range.adaptive
      ? "adaptive"
      : plan.range.min === plan.range.max
        ? "exact"
        : "range",
    min: plan.range.min,
    max: plan.range.max,
    preferred,
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
  expectedCount?: number,
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
  const target = Number.isInteger(expectedCount)
    ? Math.max(range.min, Math.min(range.max, Number(expectedCount)))
    : undefined;
  return {
    parts,
    compliant: target === undefined
      ? parts.length >= range.min && parts.length <= range.max
      : parts.length === target,
  };
}
function resolveReplyBubbleCountPlan(
  range: ReplyBubbleRange,
  value?: ReplyBubbleCountPlan | number,
): ReplyBubbleCountPlan {
  if (typeof value === "number" && Number.isInteger(value)) {
    const exact = Math.max(range.min, Math.min(range.max, value));
    return { mode: "exact", min: exact, max: exact, preferred: exact };
  }
  if (value && typeof value === "object") {
    const min = Math.max(1, Math.min(8, Math.trunc(value.min)));
    const max = Math.max(min, Math.min(8, Math.trunc(value.max)));
    const mode = value.mode === "adaptive" || value.mode === "range" || value.mode === "exact"
      ? value.mode
      : range.adaptive
        ? "adaptive"
        : min === max
          ? "exact"
          : "range";
    const exact = mode === "exact" ? Math.max(min, Math.min(max, Math.trunc(value.preferred))) : undefined;
    const allowedMin = exact ?? min;
    const allowedMax = exact ?? max;
    return {
      mode,
      min: allowedMin,
      max: allowedMax,
      preferred: Math.max(allowedMin, Math.min(allowedMax, Math.trunc(value.preferred))),
    };
  }
  const min = range.min;
  const max = range.max;
  return {
    mode: range.adaptive ? "adaptive" : min === max ? "exact" : "range",
    min,
    max,
    preferred: targetBubbleCount(range, min, max),
  };
}

function mergePairWithinHardLimits(
  left: ReplyBubblePart,
  right: ReplyBubblePart,
): ReplyBubblePart | undefined {
  if (Boolean(left.translation) !== Boolean(right.translation)) return;
  const content = joinText(left.content, right.content);
  if (visibleCharacterCount(content) > 80) return;
  const translation = left.translation && right.translation
    ? joinText(left.translation, right.translation)
    : undefined;
  if (translation && visibleCharacterCount(translation) > 100) return;
  return { content, translation };
}

function mergeStrictToMaximum(parts: ReplyBubblePart[], maximum: number) {
  const rows = [...parts];
  while (rows.length > maximum) {
    let candidate: { index: number; merged: ReplyBubblePart; length: number } | undefined;
    for (let index = 0; index < rows.length - 1; index += 1) {
      const merged = mergePairWithinHardLimits(rows[index], rows[index + 1]);
      if (!merged) continue;
      const length = visibleCharacterCount(merged.content);
      if (!candidate || length < candidate.length) candidate = { index, merged, length };
    }
    if (!candidate) break;
    rows.splice(candidate.index, 2, candidate.merged);
  }
  return rows;
}

function splitStrictToMinimum(
  parts: ReplyBubblePart[],
  minimum: number,
  maximum: number,
) {
  let rows = [...parts];
  while (rows.length < minimum) {
    const candidates = rows
      .map((part, index) => ({ index, split: splitPair(part, "semantic") }))
      .filter((item) => item.split.length > 1)
      .sort((left, right) => right.split.length - left.split.length);
    const candidate = candidates[0];
    if (!candidate) break;
    rows.splice(candidate.index, 1, ...candidate.split);
    if (rows.length > maximum) rows = mergeStrictToMaximum(rows, maximum);
  }
  return rows;
}

export function normalizeStrictReplyBubbles(
  input: ReplyBubblePart[],
  range: ReplyBubbleRange,
  countPlan?: ReplyBubbleCountPlan | number,
): NormalizedReplyBubbles & { countPlan: ReplyBubbleCountPlan; countDiagnostics: ReplyBubbleCountDiagnostics } {
  const plan = resolveReplyBubbleCountPlan(range, countPlan);
  let parts: ReplyBubblePart[] = input.map((item) => ({
    content: stripSequencePrefix(item.content.trim()),
    translation: item.translation ? stripSequencePrefix(item.translation.trim()) || undefined : undefined,
  }));
  if (!parts.length || parts.some((item) => !item.content))
    throw new ProviderError("format", "角色回复必须包含非空消息");
  if (parts.some((item) => visibleCharacterCount(item.content) > 80))
    throw new ProviderError("format", "角色回复单条内容不能超过 80 字");
  if (parts.some((item) => item.translation && visibleCharacterCount(item.translation) > 100))
    throw new ProviderError("format", "角色回复翻译不能超过 100 字");
  const rawMessageCount = parts.length;
  let countResolution: ReplyBubbleCountDiagnostics["countResolution"] = "unchanged";
  if (parts.length > plan.max) {
    parts = mergeStrictToMaximum(parts, plan.max);
    if (parts.length < rawMessageCount) countResolution = "merged";
  }
  if (parts.length < plan.min) {
    const before = parts.length;
    parts = splitStrictToMinimum(parts, plan.min, plan.max);
    if (parts.length > before) countResolution = "split";
  }
  const countCompliant = parts.length >= plan.min && parts.length <= plan.max;
  if (!countCompliant) countResolution = "retry-required";
  return {
    parts,
    compliant: countCompliant,
    countPlan: plan,
    countDiagnostics: {
      countMode: plan.mode,
      allowedMin: plan.min,
      allowedMax: plan.max,
      preferredCount: plan.preferred,
      rawMessageCount,
      finalMessageCount: parts.length,
      countResolution,
      countCompliant,
    },
  };
}

function parsedReplyRoot(raw: string): unknown {
  return parseStructuredJson(raw);
}
function canonicalReplyRoot(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const row = value as Record<string, unknown>;
  const canonical: Record<string, unknown> = { ...row };
  if (!Array.isArray(canonical.messages) && Array.isArray(row.m)) {
    canonical.messages = row.m.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const source = item as Record<string, unknown>;
      return {
        ...source,
        content: source.content ?? source.c,
        ...(source.translation !== undefined || source.t !== undefined
          ? { translation: source.translation ?? source.t }
          : {}),
      };
    });
  }
  if (!canonical.innerVoice && row.v && typeof row.v === "object" && !Array.isArray(row.v)) {
    const voice = row.v as Record<string, unknown>;
    const sections = voice.s && typeof voice.s === "object" && !Array.isArray(voice.s)
      ? voice.s as Record<string, unknown>
      : {};
    const continuity = voice.q && typeof voice.q === "object" && !Array.isArray(voice.q)
      ? voice.q as Record<string, unknown>
      : {};
    canonical.innerVoice = {
      sections: {
        physicalState: sections.physicalState ?? sections.p,
        emotionAndMind: sections.emotionAndMind ?? sections.e,
        unspokenWords: sections.unspokenWords ?? sections.u,
        selfDeception: sections.selfDeception ?? sections.d,
        triggeredMemory: sections.triggeredMemory ?? sections.r,
        angelThought: sections.angelThought ?? sections.a,
        devilThought: sections.devilThought ?? sections.x,
      },
      continuity: {
        emotion: continuity.emotion ?? continuity.e,
        physicalState: continuity.physicalState ?? continuity.p,
        concern: continuity.concern ?? continuity.c,
        pendingIntent: continuity.pendingIntent ?? continuity.i,
      },
    };
  }
  return canonical;
}
function isCompactReplyRoot(value: unknown) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    ("m" in (value as Record<string, unknown>) || "v" in (value as Record<string, unknown>)));
}
function validateCompactReplyWire(value: unknown) {
  if (!isCompactReplyRoot(value)) return;
  const row = value as Record<string, unknown>;
  const messages = Array.isArray(row.m) ? row.m : [];
  for (const item of messages) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const itemRow = item as Record<string, unknown>;
    const content = typeof itemRow.c === "string" ? itemRow.c : "";
    const translation = typeof itemRow.t === "string" ? itemRow.t : "";
    if (visibleCharacterCount(content) > 80 || visibleCharacterCount(translation) > 100)
      throw new ProviderError("format", "\u7d27\u51d1\u89d2\u8272\u56de\u590d\u7684\u6d88\u606f\u5b57\u6bb5\u8d85\u8fc7\u4f20\u8f93\u957f\u5ea6\u9650\u5236");
  }
  const voice = row.v && typeof row.v === "object" && !Array.isArray(row.v)
    ? row.v as Record<string, unknown>
    : {};
  const sections = voice.s && typeof voice.s === "object" && !Array.isArray(voice.s)
    ? voice.s as Record<string, unknown>
    : {};
  for (const key of ["p", "e", "u", "d", "a", "x"]) {
    if (typeof sections[key] === "string" && visibleCharacterCount(sections[key]) > 28)
      throw new ProviderError("format", "\u7d27\u51d1\u89d2\u8272\u56de\u590d\u5b57\u6bb5\u8d85\u8fc7\u4f20\u8f93\u957f\u5ea6\u9650\u5236");
  }
  if (typeof sections.r === "string" && visibleCharacterCount(sections.r) > 40)
    throw new ProviderError("format", "\u7d27\u51d1\u89d2\u8272\u56de\u590d\u5b57\u6bb5\u8d85\u8fc7\u4f20\u8f93\u957f\u5ea6\u9650\u5236");
  const continuity = voice.q && typeof voice.q === "object" && !Array.isArray(voice.q)
    ? voice.q as Record<string, unknown>
    : {};
  for (const key of ["e", "p", "c", "i"]) {
    if (typeof continuity[key] === "string" && visibleCharacterCount(continuity[key]) > (key === "e" ? 16 : 24))
      throw new ProviderError("format", "\u7d27\u51d1\u89d2\u8272\u56de\u590d\u7684\u8fde\u7eed\u6027\u5b57\u6bb5\u8d85\u8fc7\u4f20\u8f93\u957f\u5ea6\u9650\u5236");
  }
}
function messageRowsOf(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return;
  const row = value as Record<string, unknown>;
  if (Array.isArray(row.messages)) return row.messages;
  if (Array.isArray(row.m)) return row.m;
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
        throw new ProviderError("format", "角色回复缺少 messages 数组，请重试。");
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
      throw new ProviderError("format", "角色回复缺少 messages 数组，请重试。");
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
  if (type === "invite-user") return { type };
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
  countPlan?: ReplyBubbleCountPlan | number,
  preserveExplicitBoundaries = false,
): NormalizedReplyBubbles & Partial<{ countPlan: ReplyBubbleCountPlan; countDiagnostics: ReplyBubbleCountDiagnostics }> {
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
    const content = row.content ?? row.c ?? row.message ?? row.reply;
    const translation = row.translation ?? row.t;
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
  return preserveExplicitBoundaries
    ? normalizeStrictReplyBubbles(parts, range, countPlan)
    : normalizeReplyBubbles(parts, range, typeof countPlan === "number" ? countPlan : undefined);
}

function turnFromRoot(
  root: unknown,
  bilingual: boolean,
  range: ReplyBubbleRange,
  innerVoiceRequired: boolean,
  strict: boolean,
  countPlan?: ReplyBubbleCountPlan | number,
): GeneratedReplyTurn {
  const canonicalRoot = canonicalReplyRoot(root);
  const row = canonicalRoot && typeof canonicalRoot === "object" && !Array.isArray(canonicalRoot)
    ? canonicalRoot as Record<string, unknown>
    : undefined;
  const messages = strict ? (row && Array.isArray(row.messages) ? row.messages : undefined) : messageRowsOf(root);
  if (!messages) throw new ProviderError("format", "角色回复缺少 messages 数组");
  const normalized = normalizedBubblesFromRows(messages, bilingual, range, countPlan, strict);
  validateCompactReplyWire(root);
  let innerVoice: GeneratedInnerVoice | undefined;
  let innerVoiceFormatError = false;
  try {
    innerVoice = parseGeneratedInnerVoiceFromRoot(canonicalRoot, innerVoiceRequired);
  } catch (error) {
    if (!innerVoiceRequired || !(error instanceof ProviderError) || error.kind !== "format") throw error;
    if (strict) throw error;
    innerVoiceFormatError = true;
  }
  return {
    ...normalized,
    innerVoice,
    innerVoiceFormatError,
    musicAction: parseMusicActionFromRoot(canonicalRoot),
    islandAction: parseIslandActionFromRoot(canonicalRoot),
    stickerId: parseStickerIdFromRoot(canonicalRoot),
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
      wireFormat: diagnostics?.wireFormat ?? response?.wireFormat,
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
  countPlan?: ReplyBubbleCountPlan | number,
): GeneratedReplyTurn {
  let root: unknown;
  let diagnostics: StructuredJsonDiagnostics | undefined;
  try {
    const parsed = parseStructuredJsonWithMeta(raw, {
      transportMarkedIncomplete: response?.truncated,
    });
    root = canonicalReplyRoot(parsed.value);
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
    const turn = turnFromRoot(root, bilingual, range, innerVoiceRequired, true, countPlan);
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
      ? '{"m":[{"c":"\\u89d2\\u8272\\u6b63\\u6587","t":"\\u7b80\\u4f53\\u4e2d\\u6587\\u8bd1\\u6587"}]'
      : '{"m":[{"c":"\\u89d2\\u8272\\u6b63\\u6587"}]';
  let shape = messageShape;
  if (innerVoiceRequired)
    shape += ',"v":{"s":{"p":"\\u8eab\\u4f53","e":"\\u60c5\\u7eea","u":"\\u672a\\u8bf4","d":"\\u9632\\u5fa1","r":"\\u56de\\u5fc6","a":"\\u514b\\u5236","x":"\\u51b2\\u52a8"},"q":{"e":"\\u60c5\\u7eea","p":"\\u53ef\\u9009","c":"\\u53ef\\u9009","i":"\\u53ef\\u9009"}}';
  if (musicActionEnabled) shape += ',"musicAction":null';
  if (islandActionEnabled) shape += ',"islandAction":null';
  if (stickerCatalog.length) shape += ',"stickerId":null';
  shape += '}';
  return [
    "Reply as " + character.name + " in the " + setting + ".",
    range.adaptive
      ? "There is no preset reply count. Prefer around " + resolvedPlan.targetCount + " bubbles for this turn, but return any natural count from 1 to 8. Do not add filler merely to match the preference."
      : range.min === range.max
        ? "The client selected exactly " + range.min + " bubbles for this turn. Return exactly that many separate message bubbles."
        : "Return between " + range.min + " and " + range.max + " separate message bubbles. Prefer around " + resolvedPlan.targetCount + " when natural, but do not add filler merely to match the preference.",
    "Each item is one complete message bubble the character actually sends. Preserve natural spoken length: one bubble may contain several complete clauses or sentences when that is how this character would naturally speak. Do not split at punctuation merely to satisfy a preferred count, and do not combine unrelated thoughts. Never default to a fixed number of bubbles.",
    "Keep each visible bubble at or below 80 characters and each translation at or below 100 characters. Do not add filler, repetition, numbering or explanation.",
    innerVoiceRequired ? innerVoiceInstruction(bilingual) : "",
    musicActionEnabled ? "When listening context is present, use at most one musicAction and only when naturally relevant. Track actions may only use candidate IDs explicitly supplied by the listening context." : "",
    islandActionEnabled ? "When the island context explicitly requires an invitation decision, islandAction must not be null. Otherwise use at most one islandAction and only when naturally relevant." : "",
    stickerCatalog.length ? "Available stickers (use only an exact id from this list): " + JSON.stringify(stickerCatalog) + ". Use at most one, use sparingly, do not explain, and otherwise return stickerId as null." : "",
    "Return exactly one single-line minified JSON object with no Markdown, code fence, explanation, reasoning, analysis or surrounding text. Use the compact wire fields m and v. Do not return innerVoice.content; the client derives it locally.",
    options.compactComplete ? "This is the complete retry. Regenerate the entire turn from the beginning; do not continue, quote or merge any previous output." : "",
    "Return strict JSON only: " + shape,
  ].filter(Boolean).join(" ");
}
