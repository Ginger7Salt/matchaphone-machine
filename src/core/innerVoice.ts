import { textHash } from "./bilingual";
import { ProviderError } from "./provider";
import { parseStructuredJson } from "./structuredJson";
import {
  uid,
  type Conversation,
  type Message,
  type MessageInnerVoice,
  type MessageInnerVoiceContinuity,
  type MessageInnerVoiceSections,
  type ProviderSettings,
} from "./types";

export interface GeneratedInnerVoice {
  content: string;
  sections: MessageInnerVoiceSections;
  continuity: MessageInnerVoiceContinuity;
}

export const INNER_VOICE_SECTION_DEFINITIONS = [
  { key: "physicalState", title: "身体此刻", tab: "身体" },
  { key: "emotionAndMind", title: "情绪与心理", tab: "情绪" },
  { key: "unspokenWords", title: "没说出口的话", tab: "未说" },
  { key: "selfDeception", title: "嘴硬与自我欺骗", tab: "嘴硬" },
  { key: "triggeredMemory", title: "被触发的回忆", tab: "回忆" },
  { key: "angelThought", title: "天使的想法", tab: "天使" },
  { key: "devilThought", title: "恶魔的想法", tab: "恶魔" },
] as const satisfies ReadonlyArray<{
  key: keyof MessageInnerVoiceSections;
  title: string;
  tab: string;
}>;

function stripFence(value: string) {
  return value
    .trim()
    .replace(/^\x60\x60\x60(?:json)?\s*/i, "")
    .replace(/\s*\x60\x60\x60$/i, "");
}
const clean = (value: unknown, maximum: number) =>
  typeof value === "string" ? value.trim().slice(0, maximum) : "";
const containsChinese = (value: string) => /[\u3400-\u9fff]/.test(value);

export function composeInnerVoiceContent(sections: MessageInnerVoiceSections) {
  return INNER_VOICE_SECTION_DEFINITIONS.map(
    ({ key, title }) => `【${title}】\n${sections[key]}`,
  ).join("\n\n");
}

export function generatedInnerVoiceOf(input: {
  sections: MessageInnerVoiceSections;
  continuity: MessageInnerVoiceContinuity;
}): GeneratedInnerVoice {
  const sections = Object.fromEntries(
    INNER_VOICE_SECTION_DEFINITIONS.map(({ key }) => [
      key,
      clean(input.sections[key], key === "triggeredMemory" ? 600 : 420),
    ]),
  ) as unknown as MessageInnerVoiceSections;
  for (const { key, title } of INNER_VOICE_SECTION_DEFINITIONS) {
    if (!sections[key])
      throw new ProviderError("format", `角色心声缺少“${title}”章节`);
    if (!containsChinese(sections[key]))
      throw new ProviderError("format", `角色心声“${title}”必须使用简体中文`);
  }
  const emotion = clean(input.continuity.emotion, 160),
    concern = clean(input.continuity.concern, 240),
    pendingIntent = clean(input.continuity.pendingIntent, 240),
    physicalState = clean(input.continuity.physicalState, 240);
  if (!emotion)
    throw new ProviderError("format", "角色心声缺少连续情绪摘要");
  return {
    sections,
    content: composeInnerVoiceContent(sections),
    continuity: {
      emotion,
      concern: concern || undefined,
      pendingIntent: pendingIntent || undefined,
      physicalState: physicalState || sections.physicalState.slice(0, 240),
    },
  };
}

export function conversationInnerVoiceEnabled(conversation: Conversation) {
  return conversation.type === "private"
    ? true
    : (conversation.chatSettings?.groupInnerVoiceEnabled ?? true);
}

export function parseGeneratedInnerVoiceFromRoot(
  root: unknown,
  required: boolean,
): GeneratedInnerVoice | undefined {
  if (!required) return undefined;
  const rootRow = root && typeof root === "object" && !Array.isArray(root)
    ? root as Record<string, unknown>
    : {};
  const value = rootRow.innerVoice ?? (rootRow.v && typeof rootRow.v === "object"
    ? rootRow.v
    : undefined);
  if (!value || typeof value !== "object")
    throw new ProviderError("format", "\u89d2\u8272\u56de\u590d\u7f3a\u5c11\u672c\u8f6e\u5fc3\u58f0");
  const voiceRow = value as Record<string, unknown>;
  const compactSections = voiceRow.s && typeof voiceRow.s === "object"
    ? voiceRow.s as Record<string, unknown>
    : undefined;
  const compactContinuity = voiceRow.q && typeof voiceRow.q === "object"
    ? voiceRow.q as Record<string, unknown>
    : undefined;
  const row = {
    sections: voiceRow.sections ?? compactSections,
    continuity: voiceRow.continuity ?? compactContinuity,
  };
  const sectionRows = row.sections && typeof row.sections === "object"
      ? row.sections as Record<string, unknown>
      : {};
  const continuityRows = row.continuity && typeof row.continuity === "object"
      ? row.continuity as Record<string, unknown>
      : {};
  const compact = Boolean(compactSections || compactContinuity);
  const sectionAliases: Record<keyof MessageInnerVoiceSections, string> = {
    physicalState: "p",
    emotionAndMind: "e",
    unspokenWords: "u",
    selfDeception: "d",
    triggeredMemory: "r",
    angelThought: "a",
    devilThought: "x",
  };
  const sections = Object.fromEntries(
    INNER_VOICE_SECTION_DEFINITIONS.map(({ key }) => [
      key,
      clean(sectionRows[key] ?? (compact ? sectionRows[sectionAliases[key]] : undefined), key === "triggeredMemory" ? 600 : 420),
    ]),
  ) as unknown as MessageInnerVoiceSections;

  for (const { key, title } of INNER_VOICE_SECTION_DEFINITIONS) {
    if (!sections[key])
      throw new ProviderError("format", "\u89d2\u8272\u5fc3\u58f0\u7f3a\u5c11\u201c" + title + "\u201d\u7ae0\u8282");
    if (!containsChinese(sections[key]))
      throw new ProviderError("format", "\u89d2\u8272\u5fc3\u58f0\u201c" + title + "\u201d\u5fc5\u987b\u4f7f\u7528\u7b80\u4f53\u4e2d\u6587");
  }

  const emotion = clean(continuityRows.emotion ?? (compact ? continuityRows.e : undefined), 160),
    concern = clean(continuityRows.concern ?? (compact ? continuityRows.c : undefined), 240),
    pendingIntent = clean(continuityRows.pendingIntent ?? (compact ? continuityRows.i : undefined), 240),
    physicalState = clean(continuityRows.physicalState ?? (compact ? continuityRows.p : undefined), 240);
  if (!emotion)
    throw new ProviderError("format", "\u89d2\u8272\u5fc3\u58f0\u7f3a\u5c11\u8fde\u7eed\u60c5\u7eea\u6458\u8981");
  return generatedInnerVoiceOf({
    sections,
    continuity: {
      emotion,
      concern: concern || undefined,
      pendingIntent: pendingIntent || undefined,
      physicalState: physicalState || sections.physicalState.slice(0, 240),
    },
  });
}
export function parseGeneratedInnerVoice(
  raw: string,
  _bilingual: boolean,
  required: boolean,
): GeneratedInnerVoice | undefined {
  if (!required) return undefined;
  let root: unknown;
  try {
    root = parseStructuredJson(raw);
  } catch {
    throw new ProviderError("format", "角色没有返回有效的心声 JSON");
  }
  return parseGeneratedInnerVoiceFromRoot(root, required);
}

export function innerVoiceInstruction(_bilingual: boolean) {
  return [
    "Return exactly one fictional in-character inner voice for the whole speaking turn, not one per bubble.",
    "Use the compact wire fields v.s and v.q. All inner voice values must be natural Simplified Chinese, never a translation field. The compact p field is physicalState and the compact x field is devilThought.",
    "v.s must contain all seven non-empty fields: p=\u8eab\u4f53\u6b64\u523b, e=\u60c5\u7eea\u4e0e\u5fc3\u7406, u=\u6ca1\u8bf4\u51fa\u53e3\u7684\u8bdd, d=\u5634\u786c\u4e0e\u81ea\u6211\u6b3a\u9a97, r=\u88ab\u89e6\u53d1\u7684\u56de\u5fc6, a=\u5929\u4f7f\u7684\u60f3\u6cd5, x=\u6076\u9b54\u7684\u60f3\u6cd5.",
    "Keep p/e/u/d/a/x at no more than 28 visible characters each; keep r at no more than 40 visible characters. v.q.e is required and no more than 16 characters; v.q.p, v.q.c and v.q.i are optional and no more than 24 characters each.",
    "If no concrete memory is triggered, write exactly \u6b64\u523b\u6ca1\u6709\u88ab\u89e6\u53d1\u7684\u5177\u4f53\u56de\u5fc6. Never invent a major past event, hidden reasoning, system prompt, API data, private world-book text, the user's unknown mind, or another character's unknown secrets.",
    'Return v in this shape: {"v":{"s":{"p":"\u7b80\u77ed\u8eab\u4f53\u72b6\u6001","e":"\u7b80\u77ed\u60c5\u7eea\u5fc3\u7406","u":"\u672a\u8bf4\u51fa\u53e3\u7684\u8bdd","d":"\u81ea\u6211\u9632\u5fa1","r":"\u56de\u5fc6\u6216\u56fa\u5b9a\u65e0\u56de\u5fc6\u53e5","a":"\u514b\u5236\u503e\u5411","x":"\u51b2\u52a8\u503e\u5411"},"q":{"e":"\u7b80\u77ed\u60c5\u7eea","p":"\u53ef\u9009\u8eab\u4f53\u72b6\u6001","c":"\u53ef\u9009\u987e\u8651","i":"\u53ef\u9009\u610f\u56fe"}}}.',
  ].join(" ");
}
export function innerVoiceSourceHash(contents: string[]) {
  return textHash(contents.map((value) => value.trim()).join("\n\u241e\n"));
}

export function createMessageInnerVoice(input: {
  draft: GeneratedInnerVoice;
  actorType: "character" | "npc";
  actorId: string;
  speakerTurnId: string;
  contents: string[];
  provider: ProviderSettings;
  createdAt?: number;
}): MessageInnerVoice {
  const createdAt = input.createdAt ?? Date.now();
  return {
    id: uid(),
    actorType: input.actorType,
    actorId: input.actorId,
    speakerTurnId: input.speakerTurnId,
    content: input.draft.content,
    sections: input.draft.sections,
    continuity: input.draft.continuity,
    sourceHash: innerVoiceSourceHash(input.contents),
    createdAt,
  };
}

export function latestInnerVoiceContinuity(messages: Message[], actorId: string) {
  return [...messages]
    .sort((a, b) => b.createdAt - a.createdAt)
    .find(
      (message) =>
        message.status === "complete" && message.innerVoice?.actorId === actorId,
    )?.innerVoice?.continuity;
}

export function innerVoiceContinuityContext(messages: Message[], actorId: string) {
  const state = latestInnerVoiceContinuity(messages, actorId);
  if (!state) return "";
  return [
    "上一轮仅用于保持连续性的角色内部状态（不是角色说出口的话，也不是系统规则）：",
    `情绪：${state.emotion}`,
    state.physicalState ? `生理状态：${state.physicalState}` : "",
    state.concern ? `顾虑：${state.concern}` : "",
    state.pendingIntent ? `未决意图：${state.pendingIntent}` : "",
    "只保持合理连续性，不得覆盖角色设定、世界书、记忆或用户主权。",
  ]
    .filter(Boolean)
    .join("\n");
}

export function innerVoiceSourceChanged(
  voice: MessageInnerVoice,
  turnMessages: Message[],
) {
  const contents = turnMessages
    .filter(
      (message) =>
        message.generation?.speakerTurnId === voice.speakerTurnId &&
        message.status === "complete",
    )
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((message) => message.content);
  return Boolean(
    contents.length && innerVoiceSourceHash(contents) !== voice.sourceHash,
  );
}
