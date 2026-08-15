import { z } from "zod";
import { db, getAppSettings, getImageGenerationSettings } from "./db";
import { userPersonaContext } from "./userPersona";
import { buildContext, matchLore, type ChatItem } from "./context";
import { resolveChatPresenceContext, type ChatPresenceContext } from "./chatPresence";
import { resolveOnlineCrossModeContinuity } from "./crossModeContinuity";
import { validateLocalCharacterReply } from "./replyValidation";
import {duplicateFeedPost} from "./feedDedupe";
import {findLocalTimeContradiction,localTimeContext} from "./localTime";
import {visibleCharacterCount} from "./replyBubbles";
import { groupLoreByInsertion, loreEntriesBlock } from "./lore";
import {
  prepareRoleplayResources,
  reviewCharacterReply,
} from "./personaEngine";
import {
  chatSettingsOf,
  coreSettingOf,
  languageStyleInstruction,
  mountedLoreBooks,
  personaOf,
  relationshipContextOf,
} from "./character";
import { generateImage } from "./imageGeneration";
import { compileImagePromptPlan, reviewFaceConsistency } from "./imageDirector";
import { dataUrlToFile, saveImageMedia } from "./mediaAssets";
import { OpenAIProvider, ProviderError } from "./provider";
import { generateCharacterReplyTurn } from "./groupChat";
import {
  createMessageInnerVoice,
  generatedInnerVoiceOf,
  innerVoiceContinuityContext,
  innerVoiceInstruction,
} from "./innerVoice";
import { maybeAttachCharacterVoice } from "./speech";
import {
  characterDue,
  localDayStart,
  proactiveSettingsOf,
} from "./proactiveRules";
import {
  now,
  SCHEMA_VERSION,
  uid,
  type AppSettings,
  type Character,
  type FeedComment,
  type FeedImageAttachment,
  type FeedPost,
  type Conversation,
  type Message,
  type PendingFeedInteraction,
  type ProviderSettings,
} from "./types";
import {
  conversationChatSettingsOf,
  canCharacterInteract,
} from "./conversationSettings";
import { enqueueBackgroundTask } from "./backgroundTasks";
import { createMusicInvitationMessage, musicSettingsOf } from "./music";
import { notifyIncomingCall, notifyProactiveMessages } from "./notifications";
import { autoTranslateCharacter, completedTranslation } from "./bilingual";
import {
  normalizeReplyBubbles,
  replyBubbleInstruction,
  replyBubbleRangeOf,
} from "./replyBubbles";

const strip = (text: string) =>
  text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
const parse = (text: string) => {
  try {
    return JSON.parse(strip(text));
  } catch {
    throw new ProviderError("format", "模型没有返回有效 JSON");
  }
};
const messageSchema = z.object({ messages: z.array(z.string()) });
const bilingualMessageSchema = z.object({
  messages: z.array(z.object({ content: z.string(), translation: z.string() })),
});
const feedSchema = z.object({
  content: z.string().trim().min(1),
  translation: z.string().trim().optional(),
  imagePrompt: z.string().trim().max(2000).nullable().optional(),
});
const contentSchema = z.object({
  content: z.string(),
  translation: z.string().optional(),
});
async function twice<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (first) {
    if (first instanceof ProviderError && first.kind === "aborted") throw first;
    return fn();
  }
}
export function proactiveMessages(raw: unknown) {
  const result = messageSchema.safeParse(raw);
  if (!result.success)
    throw new ProviderError("format", "主动消息格式无法识别");
  const rows = result.data.messages
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 8);
  if (!rows.length) throw new ProviderError("format", "没有有效主动消息");
  return rows;
}
function proactiveMessageItems(
  raw: unknown,
  bilingual: boolean,
  character: Character,
): Array<{ content: string; translation?: string }> {
  const rows = bilingual
    ? (() => {
        const result = bilingualMessageSchema.safeParse(raw);
        if (!result.success)
          throw new ProviderError(
            "format",
            "Bilingual proactive message format is invalid",
          );
        return result.data.messages.map((item) => ({
          content: item.content.trim(),
          translation: item.translation.trim(),
        }));
      })()
    : proactiveMessages(raw).map((content) => ({ content }));
  const normalized = normalizeReplyBubbles(rows, replyBubbleRangeOf(character));
  if (
    !normalized.compliant ||
    (bilingual && normalized.parts.some((item) => !item.translation?.trim()))
  )
    throw new ProviderError(
      "format",
      "\u4e3b\u52a8\u79c1\u804a\u7684\u6d88\u606f\u6761\u6570\u6216\u8bd1\u6587\u4e0d\u7b26\u5408\u89d2\u8272\u8bbe\u7f6e",
    );
  return normalized.parts;
}
export function proactiveContent(raw: unknown) {
  const result = contentSchema.safeParse(raw);
  if (!result.success || !result.data.content.trim())
    throw new ProviderError("format", "动态格式无法识别");
  return result.data.content.trim();
}
export function validateProactiveFeedStyle(content:string){
  const value=content.trim(),length=visibleCharacterCount(value),sentences=(value.match(/[^。！？!?]+[。！？!?]+[”’"')）】》」』]*|[^。！？!?]+$/gu)??[]).map(item=>item.trim()).filter(Boolean);
  if(!value)return{valid:false as const,reason:"正文为空",length,sentenceCount:0};
  if(/[\r\n]/u.test(value))return{valid:false as const,reason:"正文必须只保留一个短段落",length,sentenceCount:sentences.length};
  if(length>120)return{valid:false as const,reason:`正文有 ${length} 个可见字符，超过 120 字硬上限`,length,sentenceCount:sentences.length};
  if(sentences.length>3)return{valid:false as const,reason:`正文包含 ${sentences.length} 句，超过 1–3 句限制`,length,sentenceCount:sentences.length};
  const novelCues=[/镜头|特写|画面切换/u,/缓缓|悄然|轻轻地/u,/光影|余晖|空气中|窗外/u,/指尖|眸光|嘴角|心底|内心深处/u,/仿佛|宛如|像是.{0,8}一般/u];
  if(novelCues.filter(pattern=>pattern.test(value)).length>=2)return{valid:false as const,reason:"正文包含过多小说旁白、景物或细密动作描写",length,sentenceCount:sentences.length};
  return{valid:true as const,length,sentenceCount:sentences.length};
}

function proactiveFeed(raw: unknown, bilingual = false) {
  const result = feedSchema.safeParse(raw);
  if (!result.success) throw new ProviderError("format", "Invalid feed format");
  const translation = result.data.translation?.trim();
  if (bilingual && !translation)
    throw new ProviderError(
      "format",
      "Bilingual feed is missing a translation",
    );
  return {
    content: result.data.content.trim(),
    translation,
    imagePrompt: result.data.imagePrompt?.trim() || undefined,
  };
}
function proactiveContentItem(raw: unknown, bilingual: boolean) {
  const result = contentSchema.safeParse(raw);
  if (!result.success || !result.data.content.trim())
    throw new ProviderError("format", "Invalid content format");
  const content = result.data.content.trim(),
    translation = result.data.translation?.trim();
  if (bilingual && !translation)
    throw new ProviderError(
      "format",
      "Bilingual content is missing a translation",
    );
  return { content, translation };
}
function privateConversation(characterId: string, conversations: any[]) {
  return conversations.find(
    (c) =>
      c.type === "private" &&
      c.memberIds.length === 1 &&
      c.memberIds[0] === characterId,
  );
}
function feedSystem(
  character: Character,
  books: any[],
  memories: any[],
  appSettings?: AppSettings,
  at = new Date(),
) {
  const chat = chatSettingsOf(character),
    lore = matchLore(
      mountedLoreBooks(character, books),
      "",
      character.id,
      "feed",
    ),
    loreGroups = groupLoreByInsertion(lore),
    ownMemories = memories.filter(
      (item: any) => item.characterId === character.id,
    );
  return [
    loreEntriesBlock(loreGroups["base-rules"]),
    `角色：${character.name}\n核心设定：${coreSettingOf(character)}\n人物设定：${personaOf(character)}`,
    loreEntriesBlock(loreGroups["after-character"]),
    userPersonaContext(appSettings),
    localTimeContext({enabled:character.proactive.timeAware, at}),
    languageStyleInstruction(chat.language),
    relationshipContextOf(character),
    ownMemories.length
      ? `记忆：${ownMemories.map((item: any) => item.content).join("；")}`
      : "",
    loreEntriesBlock(loreGroups["after-memory"]),
    loreEntriesBlock(loreGroups["before-history"]),
    loreEntriesBlock(loreGroups["before-user"]),
  ]
    .filter(Boolean)
    .join("\n\n");
}
async function saveMessageEvent(
  character: Character,
  provider: ProviderSettings,
  ctx: ChatItem[],
  conversationId: string,
) {
  const bilingual = autoTranslateCharacter(character),
    history = await db.messages
      .where("conversationId")
      .equals(conversationId)
      .filter((message) => message.status === "complete")
      .sortBy("createdAt"),
    continuityContext = innerVoiceContinuityContext(history, character.id),
    requestContext = continuityContext
      ? [...ctx, { role: "system" as const, content: continuityContext }]
      : ctx,
    turn = await generateCharacterReplyTurn(
      provider,
      requestContext,
      character,
      bilingual,
      "proactive",
      true,
    ),
    parts = turn.parts;
  const eventId = uid(),
    t = now(),
    turnId = uid(),
    innerVoice = createMessageInnerVoice({
      draft: turn.innerVoice!,
      actorType: "character",
      actorId: character.id,
      speakerTurnId: turnId,
      contents: parts.map((part) => part.content),
      provider,
      createdAt: t,
    }),
    rows: Message[] = parts.map((part, index) => ({
      id: uid(),
      schemaVersion: SCHEMA_VERSION,
      createdAt: t + index,
      updatedAt: t + index,
      conversationId,
      senderType: "character",
      senderId: character.id,
      content: part.content,
      translation: part.translation
        ? completedTranslation(part.content, part.translation, provider.model)
        : undefined,
      innerVoice: index === 0 ? innerVoice : undefined,
      status: "complete",
      origin: "proactive",
      proactiveEventId: eventId,
      generation: {
        model: provider.model,
        temperature: provider.temperature,
        stream: false,
        speakerTurnId: turnId,
        segmentIndex: index,
      },
    }));
  await db.transaction(
    "rw",
    [db.messages, db.conversations, db.characters],
    async () => {
      await db.messages.bulkAdd(rows);
      await db.conversations.update(conversationId, {
        lastActivityAt: t + parts.length - 1,
        updatedAt: t,
      });
      const p = proactiveSettingsOf(character);
      await db.characters.update(character.id, {
        proactiveSettings: {
          ...p,
          message: { ...p.message, lastSuccessAt: t, lastCheckedAt: t },
        },
        lastActiveAt: t,
        updatedAt: t,
      });
    },
  );
  await maybeAttachCharacterVoice({
    character,
    messageIds: rows.map((message) => message.id),
    provider,
  });
}
const richMessageSchema = z.object({
  action: z
    .enum([
      "text",
      "sticker",
      "image",
      "voice-call",
      "video-call",
      "meet-invitation",
      "music-invitation",
    ])
    .default("text"),
  messages: z
    .array(
      z.union([
        z.string(),
        z.object({ content: z.string(), translation: z.string() }),
      ]),
    )
    .optional(),
  stickerId: z.string().optional(),
  imagePrompt: z.string().optional(),
  summary: z.string().optional(),
  summaryTranslation: z.string().optional(),
  invitationText: z.string().optional(),
  invitationTranslation: z.string().optional(),
  opening: z.string().optional(),
  openingTranslation: z.string().optional(),
  location: z.string().optional(),
  atmosphere: z.string().optional(),
  trackId: z.string().optional(),
  innerVoice: z.object({
    sections: z.object({
      physicalState: z.string().trim().min(1).max(420),
      emotionAndMind: z.string().trim().min(1).max(420),
      unspokenWords: z.string().trim().min(1).max(420),
      selfDeception: z.string().trim().min(1).max(420),
      triggeredMemory: z.string().trim().min(1).max(600),
      angelThought: z.string().trim().min(1).max(420),
      devilThought: z.string().trim().min(1).max(420),
    }).strict(),
    continuity: z.object({
      emotion: z.string().trim().min(1).max(160),
      concern: z.string().trim().max(240).optional(),
      pendingIntent: z.string().trim().max(240).optional(),
      physicalState: z.string().trim().max(240).optional(),
    }).strict(),
  }).strict(),
});
async function markMessageSuccess(
  character: Character,
  t: number,
  image = false,
) {
  const p = proactiveSettingsOf(character);
  await db.characters.update(character.id, {
    proactiveSettings: {
      ...p,
      message: { ...p.message, lastSuccessAt: t, lastCheckedAt: t },
      image: image ? { ...p.image!, lastGeneratedAt: t } : p.image,
    },
    lastActiveAt: t,
    updatedAt: t,
  });
}
async function saveRichMessageEvent(
  character: Character,
  provider: ProviderSettings,
  ctx: ChatItem[],
  conversation: Conversation,
  reviewData: {
    messages: Message[];
    loreBooks: any[];
    memories: any[];
    settings: AppSettings;
    characters: Character[];
  },
  presence: ChatPresenceContext,
  crossModeContinuity = "",
) {
  const settings = conversationChatSettingsOf(conversation, character),
    permissions = settings.permissions!,
    freshCharacter = (await db.characters.get(character.id)) ?? character,
    proactive = proactiveSettingsOf(freshCharacter),
    musicSettings = musicSettingsOf(freshCharacter),
    musicInviteDue = musicSettings.canInviteToListen && (!musicSettings.lastProactiveInviteAt || Date.now() - musicSettings.lastProactiveInviteAt >= 12 * 3600000),
    musicTracks = musicInviteDue ? (await db.musicTracks.orderBy("updatedAt").reverse().limit(30).toArray()) : [],
    imageSettings = proactive.image!,
    imageStart = localDayStart(),
    todayImages = await db.messages
      .where("conversationId")
      .equals(conversation.id)
      .filter(
        (message) =>
          message.senderId === character.id &&
          message.origin === "proactive" &&
          message.createdAt >= imageStart &&
          message.attachments?.some(
            (item) => item.type === "image" || item.type === "text-image",
          ) === true,
      )
      .count(),
    imageDue =
      todayImages < imageSettings.dailyLimit &&
      (!imageSettings.lastGeneratedAt ||
        Date.now() - imageSettings.lastGeneratedAt >=
          imageSettings.cooldownHours * 3600000),
    previousCharacterMessage = [...reviewData.messages]
      .reverse()
      .find((message) => message.senderId === character.id),
    previousCharacterSentSticker =
      previousCharacterMessage?.kind === "sticker" ||
      previousCharacterMessage?.attachments?.some(
        (attachment) => attachment.type === "sticker",
      ) === true,
    packs = permissions.proactiveSticker && !previousCharacterSentSticker
      ? await db.stickerPacks.bulkGet(settings.proactiveStickerPackIds ?? [])
      : [],
    stickers = packs.filter(Boolean).flatMap((pack) => pack!.stickers),
    allowed = [
      "text",
      permissions.proactiveSticker && stickers.length ? "sticker" : "",
      imageDue ? "image" : "",
      permissions.proactiveVoiceCall ? "voice-call" : "",
      permissions.proactiveVideoCall ? "video-call" : "",
      permissions.proactiveMeetInvitation ? "meet-invitation" : "",
      musicTracks.length ? "music-invitation" : "",
    ].filter(Boolean),
    musicCatalog = musicTracks.map((track) => ({ id: track.id, title: track.title, artists: track.artists })),
    stickerCatalog = stickers.map((sticker) => ({
      id: sticker.id,
      name: sticker.name,
      description: sticker.description,
    })),
    imageGuidance =
      imageSettings.frequency === "low"
        ? "图片为低频行为，只有非常自然且值得分享时才选择 image。"
        : imageSettings.frequency === "high"
          ? "可以更积极分享生活，但仍不能为展示功能而发图。"
          : "在图片比纯文字更自然时才选择 image。";
  const bilingual = autoTranslateCharacter(character, conversation);
  const replyRange = replyBubbleRangeOf(character);
  const instruction = `请根据人设、关系与最近聊天，自然决定这次主动联系的形式。${imageGuidance}${imageSettings.onlyWhenRelevant ? "图片必须与最近聊天、角色生活或当前情境相关。" : ""}只可从 ${allowed.join("、")} 中选择一种。text 可发送 1–8 条气泡；其他动作一次只能一个。${stickerCatalog.length ? `可用表情包（只能使用目录中的真实 stickerId；只有在能自然补充当前情绪、态度或语气且符合人设时才选择，不得为了使用功能强行发送，不得用文字解释表情含义）：${JSON.stringify(stickerCatalog)}` : ""}${musicCatalog.length ? `可邀请歌曲（只能使用这些真实 ID）：${JSON.stringify(musicCatalog)}` : ""}\n只返回严格 JSON：{"action":"${allowed.join("|")}","messages":["文字"],"stickerId":"可选","trackId":"音乐库歌曲ID","imagePrompt":"可选中文画面需求","summary":"通话缘由","invitationText":"邀约文案","opening":"见面开场","location":"可选","atmosphere":"可选"}${bilingual ? `\nFor every visible character text, return an object with content and translation. Also provide summaryTranslation, invitationTranslation, and openingTranslation when the related field is used.` : ""}`;
  const instructionWithInnerVoice = instruction + "\n" + innerVoiceInstruction(bilingual);
  const decision = await twice(async () => {
      const parsed = richMessageSchema.safeParse(
        parse(
          await new OpenAIProvider(provider).chat(
            [...ctx, { role: "user", content: instructionWithInnerVoice }],
            { stream: false },
          ),
        ),
      );
      if (!parsed.success)
        throw new ProviderError("format", "主动消息格式无法识别");
      return {
        ...parsed.data,
        innerVoice: generatedInnerVoiceOf(parsed.data.innerVoice),
      };
    }),
    eventId = uid(),
    t = now(),
    baseItems = (decision.messages ?? [])
      .map((value) =>
        typeof value === "string"
          ? { content: value.trim(), translation: undefined }
          : {
              content: value.content.trim(),
              translation: value.translation.trim(),
            },
      )
      .filter((value) => value.content)
      .slice(0, 8),
    base = baseItems.map((value) => value.content),
    baseTranslations = baseItems.map((value) => value.translation),
    draftText =
      decision.action === "voice-call" || decision.action === "video-call"
        ? [
            decision.summary?.trim() ||
              "\u60f3\u548c\u4f60\u804a\u4e00\u4f1a\u513f",
          ]
        : decision.action === "meet-invitation" || decision.action === "music-invitation"
          ? [
              decision.invitationText?.trim() ||
                decision.summary?.trim() ||
                "\u60f3\u89c1\u4f60\u4e00\u9762",
            ]
          : base.length
            ? base
            : [
                decision.summary?.trim() ||
                  "\u7a81\u7136\u60f3\u8d77\u4f60\u4e86\u3002",
              ],
    draftTranslations =
      decision.action === "voice-call" || decision.action === "video-call"
        ? [decision.summaryTranslation?.trim()]
        : decision.action === "meet-invitation" || decision.action === "music-invitation"
          ? [
              decision.invitationTranslation?.trim() ||
                decision.summaryTranslation?.trim(),
            ]
          : base.length
            ? baseTranslations
            : [decision.summaryTranslation?.trim()],
    localValidation = validateLocalCharacterReply({
      messages: draftText,
      translations: draftTranslations,
      characterName: character.name,
      presence,
    }),
    reviewNeeded = decision.action !== "sticker" && localValidation.issues.length > 0,
    review = !reviewNeeded
      ? { revisedMessages: draftText, revisedTranslations: draftTranslations, revisedInnerVoice: decision.innerVoice }
      : await reviewCharacterReply({
            character,
            conversation,
            scene: "proactive-message",
            draftMessages: draftText,
            messages: reviewData.messages,
            characters: reviewData.characters,
            loreBooks: reviewData.loreBooks,
            memories: reviewData.memories,
            settings: reviewData.settings,
            provider,
            bilingual,
            draftInnerVoice: decision.innerVoice,
            innerVoiceRequired: true,
            presence,
            crossModeContinuity,
          }),
    reviewedInnerVoice = review.revisedInnerVoice ?? decision.innerVoice,
    reviewedText = review.revisedMessages,
    reviewedTranslations = bilingual ? (review.revisedTranslations ?? []) : [];
  if (
    bilingual &&
    decision.action !== "sticker" &&
    (reviewedTranslations.length !== reviewedText.length ||
      reviewedTranslations.some((value) => !value?.trim()))
  )
    throw new ProviderError(
      "format",
      "Bilingual proactive reply is missing a translation",
    );
  if (decision.action !== "sticker") {
    const finalValidation = validateLocalCharacterReply({
      messages: reviewedText,
      translations: reviewedTranslations,
      characterName: character.name,
      presence,
    });
    if (finalValidation.issues.length)
      throw new ProviderError(
        "format",
        finalValidation.issues.includes("remote-presence")
          ? "主动消息仍违反线上聊天距离约束"
          : "主动消息仍不符合本地格式要求",
      );
  }
  if (decision.action === "text") {
    const normalized = normalizeReplyBubbles(
      reviewedText.map((content, index) => ({
        content,
        translation: bilingual ? reviewedTranslations[index] : undefined,
      })),
      replyRange,
    );
    if (
      !normalized.compliant ||
      (bilingual && normalized.parts.some((part) => !part.translation?.trim()))
    )
      throw new ProviderError(
        "format",
        "\u4e3b\u52a8\u79c1\u804a\u7684\u6d88\u606f\u6761\u6570\u4e0d\u7b26\u5408\u89d2\u8272\u8bbe\u7f6e",
      );
    reviewedText.splice(
      0,
      reviewedText.length,
      ...normalized.parts.map((part) => part.content),
    );
    reviewedTranslations.splice(
      0,
      reviewedTranslations.length,
      ...normalized.parts.map((part) => part.translation ?? ""),
    );
  }
  if (decision.action === "music-invitation") {
    const track = musicTracks.find((item) => item.id === decision.trackId) ?? musicTracks[0];
    if (track) {
      const result = await createMusicInvitationMessage({ conversationId: conversation.id, characterId: character.id, invitedBy: "character", trackId: track.id });
      const invitationText = reviewedText[0] || decision.invitationText?.trim() || `想和你一起听「${track.title}」`;
      const turnId = uid(), turnVoice = createMessageInnerVoice({ draft: reviewedInnerVoice, actorType: "character", actorId: character.id, speakerTurnId: turnId, contents: [invitationText], provider, createdAt: t });
      await db.transaction("rw", [db.messages, db.characters], async () => {
        await db.messages.update(result.message.id, { content: invitationText, translation: reviewedTranslations[0] ? completedTranslation(invitationText, reviewedTranslations[0], provider.model) : undefined, proactiveEventId: eventId, innerVoice: turnVoice, generation: { model: provider.model, temperature: provider.temperature, stream: false, speakerTurnId: turnId, segmentIndex: 0 }, updatedAt: t });
        const current = await db.characters.get(character.id), baseCharacter = current ?? character, currentMusic = musicSettingsOf(baseCharacter);
        await db.characters.update(character.id, { chatSettings: { ...chatSettingsOf(baseCharacter), music: { ...currentMusic, lastProactiveInviteAt: t } }, updatedAt: t });
      });
      await markMessageSuccess(character, t);
      const saved = await db.messages.get(result.message.id); if (saved) await notifyProactiveMessages(character, conversation, [saved]);
      return;
    }
  }
  if (decision.action === "voice-call" || decision.action === "video-call") {
    const callType = decision.action === "video-call" ? "video" : "voice",
      summary = reviewedText[0] || "想和你聊一会儿",
      expiresAt = t + 60_000;
    await markMessageSuccess(character, t);
    await enqueueBackgroundTask({
      type: "proactive-call",
      entityId: eventId,
      eventId,
      characterId: character.id,
      conversationId: conversation.id,
      scheduledAt: expiresAt,
      nextAttemptAt: expiresAt,
      payload: {
        eventId,
        conversationId: conversation.id,
        characterId: character.id,
        callType,
        summary,
        createdAt: t,
        expiresAt,
      },
    });
    if (document.visibilityState === "visible")
      window.dispatchEvent(
        new CustomEvent("mira:incoming-call", {
          detail: {
            eventId,
            conversationId: conversation.id,
            characterId: character.id,
            callType,
            summary,
            createdAt: t,
            expiresAt,
          },
        }),
      );
    else
      await notifyIncomingCall(character, conversation, {
        eventId,
        callType,
        summary,
        createdAt: t,
      });
    return;
  }
  let rows: Message[] = [];
  if (decision.action === "sticker") {
    const sticker = stickers.find((item) => item.id === decision.stickerId);
    if (sticker)
      rows = [
        {
          id: uid(),
          schemaVersion: SCHEMA_VERSION,
          createdAt: t,
          updatedAt: t,
          conversationId: conversation.id,
          senderType: "character",
          senderId: character.id,
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
          origin: "proactive",
          proactiveEventId: eventId,
        },
      ];
  }
  if (decision.action === "image") {
    const imagePolicy = proactiveSettingsOf(character).image!,
      feedImage = chatSettingsOf(character).feedImage,
      referenceId = imagePolicy.useCharacterReference
        ? (feedImage?.referenceAssetId ??
          character.visualProfile?.lastAcceptedImageAssetId)
        : undefined,
      reference = referenceId
        ? (await db.mediaAssets.get(referenceId))?.data
        : undefined,
      compiled = await compileImagePromptPlan({
        character,
        conversation,
        loreBooks: reviewData.loreBooks,
        memories: reviewData.memories,
        messages: reviewData.messages,
        request:
          decision.imagePrompt?.trim() ||
          decision.summary?.trim() ||
          "分享一张符合角色当前生活的照片",
        provider,
        settings: reviewData.settings,
        referenceAssetId: referenceId,
      }),
      plan = compiled.plan,
      content = imagePolicy.includeMessage
        ? reviewedText[0] || plan.companionMessages[0] || ""
        : "";
    let real = false;
    if (permissions.proactiveChatImage)
      try {
        const generationSettings = await getImageGenerationSettings(),
          vendor = generationSettings[generationSettings.provider];
        if (vendor.enabled && vendor.apiKey.trim()) {
          const result = await generateImage(generationSettings, {
              prompt:
                generationSettings.provider === "openai"
                  ? plan.openaiPrompt
                  : plan.novelaiPrompt,
              negativePrompt: plan.negativePrompt,
              referenceDataUrl: reference,
            }),
            face = reference
              ? await reviewFaceConsistency(reference, result.dataUrl)
              : undefined;
          if (!face || (face.passed && face.score >= 0.82)) {
            const asset = await saveImageMedia(
              await dataUrlToFile(result.dataUrl, `chat-${Date.now()}.png`),
              "chat-image",
            );
            rows = [
              {
                id: uid(),
                schemaVersion: SCHEMA_VERSION,
                createdAt: t,
                updatedAt: t,
                conversationId: conversation.id,
                senderType: "character",
                senderId: character.id,
                content,
                translation: reviewedTranslations[0]
                  ? completedTranslation(
                      content,
                      reviewedTranslations[0],
                      provider.model,
                    )
                  : undefined,
                kind: "image",
                attachments: [
                  {
                    type: "image",
                    assetId: asset.id,
                    description: plan.visualSummary,
                    visionMode: "description",
                    width: asset.width,
                    height: asset.height,
                  },
                ],
                status: "complete",
                origin: "proactive",
                proactiveEventId: eventId,
              },
            ];
            real = true;
            const current = await db.characters.get(character.id);
            if (current?.visualProfile)
              await db.characters.update(character.id, {
                visualProfile: {
                  ...current.visualProfile,
                  lastAcceptedImageAssetId: asset.id,
                  updatedAt: t,
                },
                updatedAt: t,
              });
          }
        }
      } catch {}
    if (!real)
      rows = [
        {
          id: uid(),
          schemaVersion: SCHEMA_VERSION,
          createdAt: t,
          updatedAt: t,
          conversationId: conversation.id,
          senderType: "character",
          senderId: character.id,
          content,
          translation: reviewedTranslations[0]
            ? completedTranslation(
                content,
                reviewedTranslations[0],
                provider.model,
              )
            : undefined,
          kind: "image",
          attachments: [
            {
              type: "text-image",
              description: plan.textImageDescription,
              intent: plan.intent,
              characterId: character.id,
              generationEventId: eventId,
              createdAt: t,
            },
          ],
          status: "complete",
          origin: "proactive",
          proactiveEventId: eventId,
        },
      ];
  }
  if (decision.action === "meet-invitation" && decision.opening?.trim()) {
    const invitationText =
      reviewedText[0] || decision.invitationText?.trim() || "想见你一面";
    rows = [
      {
        id: uid(),
        schemaVersion: SCHEMA_VERSION,
        createdAt: t,
        updatedAt: t,
        conversationId: conversation.id,
        senderType: "character",
        senderId: character.id,
        content: invitationText,
        translation: reviewedTranslations[0]
          ? completedTranslation(
              invitationText,
              reviewedTranslations[0],
              provider.model,
            )
          : undefined,
        kind: "meet-invitation",
        attachments: [
          {
            type: "meet-invitation",
            invitationId: uid(),
            conversationId: conversation.id,
            characterId: character.id,
            participantIds: [character.id],
            invitationText,
            scene: {
              opening: decision.opening.trim(),
              location: decision.location?.trim() || undefined,
              atmosphere: decision.atmosphere?.trim() || undefined,
            },
            state: "pending",
            expiresAt: t + 7 * 86400000,
          },
        ],
        status: "complete",
        origin: "proactive",
        proactiveEventId: eventId,
      },
    ];
  }
  if (!rows.length)
    rows = reviewedText.slice(0, 8).map((content, index) => ({
      id: uid(),
      schemaVersion: SCHEMA_VERSION,
      createdAt: t + index,
      updatedAt: t + index,
      conversationId: conversation.id,
      senderType: "character",
      senderId: character.id,
      content,
      translation: reviewedTranslations[index]
        ? completedTranslation(
            content,
            reviewedTranslations[index],
            provider.model,
          )
        : undefined,
      status: "complete",
      origin: "proactive",
      proactiveEventId: eventId,
      generation: {
        model: provider.model,
        temperature: provider.temperature,
        stream: false,
      },
    }));
  if (!rows.length)
    throw new ProviderError("format", "角色一致性审查没有返回主动消息");
  const turnId = uid(),
    turnVoice = createMessageInnerVoice({ draft: reviewedInnerVoice, actorType: "character", actorId: character.id, speakerTurnId: turnId, contents: rows.map((row) => row.content), provider, createdAt: t });
  rows = rows.map((row, index) => ({ ...row, innerVoice: index === 0 ? turnVoice : undefined, generation: { model: provider.model, temperature: provider.temperature, stream: false, ...row.generation, speakerTurnId: turnId, segmentIndex: index } }));
  await db.transaction(
    "rw",
    [db.messages, db.conversations, db.characters],
    async () => {
      await db.messages.bulkAdd(rows);
      await db.conversations.update(conversation.id, {
        lastActivityAt: t + rows.length - 1,
        updatedAt: t,
      });
      await markMessageSuccess(
        character,
        t,
        rows.some((row) =>
          row.attachments?.some(
            (item) => item.type === "image" || item.type === "text-image",
          ),
        ),
      );
    },
  );
  await maybeAttachCharacterVoice({
    character,
    messageIds: rows
      .filter((row) => !row.kind || row.kind === "text")
      .map((row) => row.id),
    provider,
  });
  await notifyProactiveMessages(character, conversation, rows);
}
const friendRequestSchema = z.object({
  apply: z.boolean(),
  message: z.string().trim().max(120).optional(),
});
async function maybeCreateFriendRequest(
  character: Character,
  provider: ProviderSettings,
  ctx: ChatItem[],
) {
  if (character.contactState?.status !== "blocked") return;
  const raw = await new OpenAIProvider(provider).chat(
      [
        ...ctx,
        {
          role: "user",
          content:
            '你已被用户拉黑。请根据人设、关系和历史决定这次是否重新发送好友申请。只返回严格 JSON：{"apply":true或false,"message":"不超过120字的申请理由"}',
        },
      ],
      { stream: false },
    ),
    parsed = friendRequestSchema.safeParse(parse(raw)),
    t = now();
  if (parsed.success && parsed.data.apply) {
    const p = proactiveSettingsOf(character);
    await db.characters.update(character.id, {
      contactState: {
        status: "request-pending",
        blockedAt: character.contactState.blockedAt,
        friendRequest: {
          id: uid(),
          message: parsed.data.message || "想重新和你说说话。",
          createdAt: t,
          status: "pending",
        },
      },
      proactiveSettings: {
        ...p,
        message: { ...p.message, lastSuccessAt: t, lastCheckedAt: t },
      },
      updatedAt: t,
    });
  } else await markMessageSuccess(character, t);
}
function scheduledCharacters(
  characters: Character[],
  createdAt: number,
  excludeId?: string,
): PendingFeedInteraction[] {
  const pool = characters
    .filter((c) => c.id !== excludeId && canCharacterInteract(c))
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt || a.id.localeCompare(b.id))
    .slice(0, 10);
  return pool.map((c, index) => ({
    id: uid(),
    kind: "initial-comment",
    characterId: c.id,
    scheduledAt:
      createdAt +
      5000 +
      Math.round(((index + Math.random()) / Math.max(1, pool.length)) * 175000),
  }));
}
export function scheduleUserPostInteractions(
  characters: Character[],
  createdAt: number,
) {
  return scheduledCharacters(characters, createdAt);
}
async function createFeedDraft(
  character: Character,
  provider: ProviderSettings,
  books: any[],
  memories: any[],
  posts: FeedPost[],
  appSettings: AppSettings,
  rejectedContents: Array<{content:string;reason:string}> = [],
) {
  const generationTime = new Date();
  const recent = posts
      .filter(
        (x) =>
          (x.authorType ?? "character") === "character" &&
          x.authorId === character.id,
      )
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 5),
    settings = await getImageGenerationSettings(),
    vendor = settings[settings.provider],
    feedImage = chatSettingsOf(character).feedImage,
    canImage = Boolean(
      feedImage?.enabled && vendor.enabled && vendor.apiKey.trim(),
    ),
    bilingual = autoTranslateCharacter(character),
    prompt = `请以角色身份发布一条社交平台短动态，而不是小说片段。正文只写一个短段落，使用 1–3 个语义完整的短句，目标约 20–80 个可见字符，绝对不能超过 120 个 Unicode 字素。禁止小说旁白、镜头语言、连续景物铺陈、细密动作描写和长篇心理独白；不要编造未发生的见面、旅行、礼物或关系进展。当前时间或时段的表述必须严格符合系统提供的本地时间；没有把握时不要写具体时间。避免重复近期内容：\n${recent.map((x) => x.content).join("\n") || "暂无"}${rejectedContents.length ? `\n以下草稿已被拒绝，必须根据原因彻底改写：\n${rejectedContents.map(item=>`拒绝原因：${item.reason}\n草稿：${item.content}`).join("\n")}` : ""}\n${canImage ? "你可以自行决定是否需要一张配图，需要时用中文描述要分享的真实画面，不需要时返回 null。" : "本次只能发布纯文字，imagePrompt 必须为 null。"}\n只返回 JSON：{"content":"动态正文","imagePrompt":null或"中文画面需求"}${bilingual ? `\nAlso return "translation", a faithful Simplified Chinese translation of content. Keep the translation in one short paragraph and aligned with the original sentences.` : ""}`
  const draft = proactiveFeed(
    parse(
      await new OpenAIProvider(provider).chat(
        [
          {
            role: "system",
            content: feedSystem(character, books, memories, appSettings, generationTime),
          },
          { role: "user", content: prompt },
        ],
        { stream: false },
      ),
    ),
    bilingual,
  );
  const styleCheck=validateProactiveFeedStyle(draft.content);
  const translationCheck=draft.translation?validateProactiveFeedStyle(draft.translation):undefined;
  const styleIssue=!styleCheck.valid?styleCheck.reason:translationCheck&&!translationCheck.valid?`翻译${translationCheck.reason}`:undefined;
  if(styleIssue)return{draft,image:undefined,generation:undefined,styleIssue};
  let image: FeedImageAttachment | undefined,
    generation: FeedPost["imageGeneration"];
  if (canImage && draft.imagePrompt) {
    const referenceId =
        feedImage?.referenceAssetId ??
        character.visualProfile?.lastAcceptedImageAssetId,
      reference = referenceId
        ? (await db.mediaAssets.get(referenceId))?.data
        : undefined,
      compiled = await compileImagePromptPlan({
        character,
        loreBooks: books,
        memories,
        messages: [],
        request: draft.imagePrompt,
        provider,
        settings: appSettings,
        referenceAssetId: referenceId,
      }),
      plan = compiled.plan,
      result = await generateImage(settings, {
        prompt:
          settings.provider === "openai"
            ? plan.openaiPrompt
            : plan.novelaiPrompt,
        negativePrompt: plan.negativePrompt,
        referenceDataUrl: reference,
      }),
      face = reference
        ? await reviewFaceConsistency(reference, result.dataUrl)
        : undefined;
    if (!face || (face.passed && face.score >= 0.82)) {
      const asset = await saveImageMedia(
        await dataUrlToFile(result.dataUrl, `feed-${Date.now()}.png`),
        "feed-image",
      );
      image = {
        id: uid(),
        source: "asset",
        assetId: asset.id,
        description: plan.visualSummary,
        width: asset.width,
        height: asset.height,
        generated: true,
      };
      generation = {
        provider: result.provider,
        model: result.model,
        prompt:
          settings.provider === "openai"
            ? plan.openaiPrompt
            : plan.novelaiPrompt,
      };
      const current = await db.characters.get(character.id);
      if (current?.visualProfile)
        await db.characters.update(character.id, {
          visualProfile: {
            ...current.visualProfile,
            lastAcceptedImageAssetId: asset.id,
            updatedAt: Date.now(),
          },
          updatedAt: Date.now(),
        });
    }
  }
  return { draft, image, generation };
}
async function discardFeedDraft(created:Awaited<ReturnType<typeof createFeedDraft>>){
  if(created.image?.assetId)await db.mediaAssets.delete(created.image.assetId);
}
async function saveFeedEvent(
  character: Character,
  provider: ProviderSettings,
  books: any[],
  memories: any[],
  posts: FeedPost[],
  characters: Character[],
  appSettings: AppSettings,
) {
  const rejected:Array<{content:string;reason:string}>=[];
  let created:Awaited<ReturnType<typeof createFeedDraft>>|undefined;
  for(let attempt=0;attempt<2;attempt++){
    created=await twice(()=>createFeedDraft(character,provider,books,memories,posts,appSettings,rejected));
    const duplicate=duplicateFeedPost(created.draft.content,posts,character.id),timeConflict=findLocalTimeContradiction(created.draft.content),styleIssue=created.styleIssue;
    if(!duplicate&&!timeConflict&&!styleIssue)break;
    rejected.push({content:created.draft.content,reason:styleIssue??(duplicate?"与该角色已有动态重复或高度相似":"与当前本地时间矛盾")});
    await discardFeedDraft(created);
    created=undefined;
  }
  if(!created)throw new ProviderError("format","动态内容与历史内容重复或当前时间矛盾");
  const t=now(),eventId=uid(),post:FeedPost={
    id:uid(),schemaVersion:SCHEMA_VERSION,createdAt:t,updatedAt:t,authorType:"character",authorId:character.id,content:created.draft.content,
    translation:created.draft.translation?completedTranslation(created.draft.content,created.draft.translation,provider.model):undefined,
    images:created.image?[created.image]:[],imageDescription:created.image?.description,liked:false,comments:[],origin:"proactive",proactiveEventId:eventId,
    pendingInteractions:scheduledCharacters(characters,t,character.id),imageGeneration:created.generation,
  };
  try{
    await db.transaction("rw",[db.feedPosts,db.characters],async()=>{
      const currentPosts=await db.feedPosts.where("authorId").equals(character.id).toArray();
      if(duplicateFeedPost(post.content,currentPosts,character.id))throw new ProviderError("format","动态内容已由并发任务保存");
      await db.feedPosts.add(post);
      const p=proactiveSettingsOf(character);
      await db.characters.update(character.id,{proactiveSettings:{...p,feed:{...p.feed,lastSuccessAt:t,lastCheckedAt:t}},lastActiveAt:t,updatedAt:t});
    });
  }catch(error){await discardFeedDraft(created);throw error;}
}

export async function runProactive(
  provider: ProviderSettings,
  onlineSince: number,
  characterId?: string,
) {
  if (!provider.apiKey) return;
  const [
      characters,
      conversations,
      messages,
      posts,
      books,
      memories,
      appSettings,
    ] = await Promise.all([
      db.characters.toArray(),
      db.conversations.toArray(),
      db.messages.toArray(),
      db.feedPosts.toArray(),
      db.loreBooks.toArray(),
      db.memories.toArray(),
      getAppSettings(),
    ]),
    start = localDayStart(),
    targets = characterId
      ? characters.filter((c) => c.id === characterId)
      : characters;
  for (const c of targets.sort((a, b) => a.lastActiveAt - b.lastActiveAt)) {
    const counts = {
        message: new Set(
          messages
            .filter(
              (m) =>
                m.senderId === c.id &&
                m.origin === "proactive" &&
                m.createdAt >= start,
            )
            .map((m) => m.proactiveEventId),
        ).size,
        feed: posts.filter(
          (p) =>
            (p.authorType ?? "character") === "character" &&
            p.authorId === c.id &&
            p.origin === "proactive" &&
            p.createdAt >= start,
        ).length,
      },
      due = characterDue(c, Date.now(), counts, onlineSince),
      cv = privateConversation(c.id, conversations);
    if (cv && due.message > 0) {
      const generationTime = new Date(),
        history = (
          await db.messages
            .where("conversationId")
            .equals(cv.id)
            .sortBy("createdAt")
        ).filter((m) => m.status === "complete"),
        prepared = await prepareRoleplayResources({
          character: c,
          conversation: cv,
          loreBooks: books,
          provider,
        }),
        cast = characters.map((item) =>
          item.id === c.id ? prepared.character : item,
        ),
        presence = await resolveChatPresenceContext({
          conversation: cv,
          actorId: prepared.character.id,
          messages: history,
        }),
        crossModeContinuity = await resolveOnlineCrossModeContinuity({
          conversation: cv,
          actorId: prepared.character.id,
          names: Object.fromEntries(cast.map((item) => [item.id, item.name])),
        }),
        ctx = buildContext({
          character: prepared.character,
          conversation: cv,
          messages: history,
          loreBooks: prepared.loreBooks,
          memories,
          userText: !canCharacterInteract(c)
            ? "考虑是否重新申请好友"
            : "主动联系用户",
          settings: appSettings,
          provider,
          characters: cast,
          scene: "proactive-message",
          presence,
          crossModeContinuity,
          timeAt: generationTime,
        });
      if (!canCharacterInteract(c)) {
        if (c.contactState?.status === "blocked")
          try {
            await maybeCreateFriendRequest(prepared.character, provider, ctx);
          } catch {}
        continue;
      }
      for (let i = 0; i < due.message; i++)
        try {
          await saveRichMessageEvent(prepared.character, provider, ctx, cv, {
            messages: history,
            loreBooks: prepared.loreBooks,
            memories,
            settings: appSettings,
            characters: cast,
          }, presence, crossModeContinuity);
        } catch {
          break;
        }
    }
    if (!canCharacterInteract(c)) continue;
    for (let i = 0; i < due.feed; i++)
      try {
        await saveFeedEvent(
          c,
          provider,
          books,
          memories,
          await db.feedPosts.toArray(),
          characters,
          appSettings,
        );
      } catch {
        break;
      }
  }
}
async function feedImages(post: FeedPost) {
  const values: string[] = [];
  for (const image of post.images ?? []) {
    if (image.source === "asset" && image.assetId) {
      const asset = await db.mediaAssets.get(image.assetId);
      if (asset?.data) values.push(asset.data);
    } else if (image.url) values.push(image.url);
  }
  return values;
}
function commentPrompt(
  post: FeedPost,
  comments: FeedComment[],
  character: Character,
  authorName: string,
  appSettings: AppSettings,
  target?: FeedComment,
  imageUrls: string[] = [],
  bilingual = false,
  at = new Date(),
): ChatItem[] {
  const descriptions = [
      post.imageDescription,
      ...(post.images ?? []).map((x) => x.description),
    ]
      .filter(Boolean)
      .join("；"),
    instruction = target
      ? `用户正在直接回复你：${target.content}`
      : "请自然评论这条动态，不要替其他角色说话。";
  return [
    { role: "system", content: feedSystem(character, [], [], appSettings, at) },
    {
      role: "user",
      content: `动态作者：${authorName}\n动态正文：${post.content || "（无文字）"}\n图片说明：${descriptions || ((post.images?.length ?? 0) > 0 ? `用户分享了${post.images?.length}张图片` : "无")}\n已有评论：\n${comments.map((c) => c.content).join("\n") || "暂无"}\n${instruction}\n只返回 JSON：{\"content\":\"回复内容\"}${bilingual ? `\nReturn a translation field containing a faithful Simplified Chinese translation.` : ""}`,
      imageUrls,
    },
  ];
}
export async function processFeedInteractions(provider: ProviderSettings) {
  if (!provider.apiKey || document.visibilityState !== "visible") return;
  const [posts, characters, books, memories, appSettings] = await Promise.all([
    db.feedPosts.toArray(),
    db.characters.toArray(),
    db.loreBooks.toArray(),
    db.memories.toArray(),
    getAppSettings(),
  ]);
  for (const post of posts) {
    const due = (post.pendingInteractions ?? []).filter(
      (x) => x.scheduledAt <= Date.now(),
    );
    for (const job of due) {
      const character = characters.find((c) => c.id === job.characterId);
      if (!character || !canCharacterInteract(character)) {
        await db.feedPosts.update(post.id, {
          pendingInteractions: (post.pendingInteractions ?? []).filter(
            (x) => x.id !== job.id,
          ),
        });
        continue;
      }
      try {
        const generationTime = new Date(),
          authorName =
            (post.authorType ?? "character") === "user"
              ? appSettings.userName?.trim() || "用户"
              : (characters.find((c) => c.id === post.authorId)?.name ??
                "已删除角色"),
          images = await feedImages(post),
          prompt = commentPrompt(
            post,
            post.comments,
            character,
            authorName,
            appSettings,
            job.parentId
              ? post.comments.find((c) => c.id === job.parentId)
              : undefined,
            images,
            autoTranslateCharacter(character),
            generationTime,
          );
        prompt[0].content = feedSystem(character, books, memories, appSettings, generationTime);
        const bilingual = autoTranslateCharacter(character),
          generated = await twice(async () =>
            proactiveContentItem(
              parse(
                await new OpenAIProvider(provider).chat(prompt, {
                  stream: false,
                }),
              ),
              bilingual,
            ),
          ),
          content = generated.content;
        const t = now(),
          comment: FeedComment = {
            id: uid(),
            authorType: "character",
            authorId: character.id,
            content,
            translation: generated.translation
              ? completedTranslation(
                  content,
                  generated.translation,
                  provider.model,
                )
              : undefined,
            createdAt: t,
            parentId: job.parentId,
            threadRootId: job.threadRootId ?? job.parentId,
            replyToAuthorType: job.replyToAuthorType,
            replyToAuthorId: job.replyToAuthorId,
            origin: "proactive",
            status: "complete",
          };
        await db.feedPosts.update(post.id, {
          comments: [...post.comments, comment],
          pendingInteractions: (post.pendingInteractions ?? []).filter(
            (x) => x.id !== job.id,
          ),
          updatedAt: t,
        });
        post.comments.push(comment);
        post.pendingInteractions = (post.pendingInteractions ?? []).filter(
          (x) => x.id !== job.id,
        );
      } catch {
        await db.feedPosts.update(post.id, {
          pendingInteractions: (post.pendingInteractions ?? []).filter(
            (x) => x.id !== job.id,
          ),
        });
      }
    }
  }
}
export function makeReplyJob(
  characterId: string,
  userComment: FeedComment,
): PendingFeedInteraction {
  return {
    id: uid(),
    kind: "reply",
    characterId,
    scheduledAt: Date.now() + 2000 + Math.round(Math.random() * 10000),
    parentId: userComment.id,
    threadRootId: userComment.threadRootId ?? userComment.id,
    replyToAuthorType: "user",
  };
}


