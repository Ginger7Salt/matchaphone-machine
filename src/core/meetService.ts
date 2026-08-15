import { db, getAppSettings, getProvider } from "./db";
import { enqueueBackgroundTask } from "./backgroundTasks";
import { rewardIslandMeet } from "./coupleIsland";
import { memoryExtractionSettingsOf } from "./memoryExtraction";
import { userPersonaContext } from "./userPersona";
import { OpenAIProvider, ProviderError, isContextOverflowError } from "./provider";
import { parseStructuredJsonWithMeta } from "./structuredJson";
import {
  estimateChatTokens,
  fitChatItemsToInternalBudget,
  fitPrioritizedPromptSections,
  INTERNAL_INPUT_BUDGET_TOKENS,
  INTERNAL_LORE_BUDGET_TOKENS,
  type PrioritizedPromptSection,
} from "./tokenBudget";
import {
  chatSettingsOf,
  coreSettingOf,
  languageStyleInstruction,
  personaOf,
  relationshipContextOf,
} from "./character";
import { evaluateStrategyInteraction } from "./relationshipStrategy";
import { autoTranslateCharacter, completedTranslation } from "./bilingual";
import { selectMemories } from "./memory";
import {
  evaluateLore,
  groupLoreByInsertion,
  isLoreBookMounted,
  loreEntriesBlock,
} from "./lore";
import {
  activeSessionConflicts,
  DEFAULT_MEET_NARRATIVE_SETTINGS,
  invitationRelevant,
  localMeetSummary,
  meetNarrativeInstructions,
  meetTimeContext,
  normalizeNarrativeSettings,
  parseMeetReply,
  validateMeetScene,
} from "./meet";
import {
  SCHEMA_VERSION,
  now,
  uid,
  type AppSettings,
  type Character,
  type MeetEntry,
  type MeetNarrativeSettings,
  type MeetScene,
  type MeetSession,
  type Message,
} from "./types";
import {
  conversationChatSettingsOf,
  canCharacterInteract,
} from "./conversationSettings";
import {
  prepareRoleplayResources,
  performanceProfileContext,
  strongRoleplayInstruction,
} from "./personaEngine";
import {
  applyMeetPlotProgress,
  applyMeetScenePatch,
  defaultMeetPlotState,
  defaultMeetSceneState,
  ensureMeetCompiledStyle,
  meetStyleContract,
  meetStyleViolation,
  meetTurnSchema,
  selectMeetResponders,
} from "./meetEngine";
import { resolveSecondaryProvider } from "./modelServices";
import { buildMeetCrossModeContinuity, closeMeetOnlineWindow, resumeMeetSessionForOfflineActivity } from "./crossModeContinuity";

function shouldUseCompactStreamingRetry(error: unknown) {
  if (!(error instanceof ProviderError)) return false;
  const code = error.apiError?.providerCode;
  return code === "truncated_json" || code === "transport_truncated" || code === "malformed_envelope";
}

export async function createMeetSession(input: {
  participantIds: string[];
  conversationId?: string;
  scene: Partial<MeetScene>;
  suggestionsEnabled?: boolean;
  timeAware?: boolean;
  narrativeSettings?: Partial<MeetNarrativeSettings>;
  initiator?: "user" | "character";
  invitationMessageId?: string;
}) {
  const ids = [...new Set(input.participantIds)].filter(Boolean);
  if (!ids.length) throw new Error("请至少选择一位角色");
  const scene = validateMeetScene(input.scene),
    narrativeSettings = normalizeNarrativeSettings(input.narrativeSettings),
    all = await db.meetSessions.toArray(),
    conflict = activeSessionConflicts(all, ids, input.conversationId);
  if (conflict) return conflict;
  const t = now(),
    opening: MeetEntry = {
      id: uid(),
      roundId: uid(),
      senderType: "user",
      content: scene.opening,
      createdAt: t,
    };
  const session: MeetSession = {
    id: uid(),
    schemaVersion: SCHEMA_VERSION,
    createdAt: t,
    updatedAt: t,
    conversationId: input.conversationId,
    participantIds: ids,
    initiator: input.initiator ?? "user",
    invitationMessageId: input.invitationMessageId,
    scene,
    suggestionsEnabled: input.suggestionsEnabled ?? false,
    timeAware: input.timeAware ?? false,
    narrativeSettings,
    status: "active",
    modeBridge: { currentMode: "meet", switchedAt: t },
    entries: [opening],
    startedAt: t,
    lastActivityAt: t,
  };
  await db.meetSessions.add(session);
  return session;
}

export async function updateMeetScene(
  id: string,
  scene: Partial<MeetScene>,
  suggestionsEnabled: boolean,
  narrativeSettings?: Partial<MeetNarrativeSettings>,
  timeAware?: boolean,
) {
  const next = validateMeetScene(scene),
    narrative = normalizeNarrativeSettings(narrativeSettings),
    current = await db.meetSessions.get(id),
    t = now();
  await db.meetSessions.update(id, {
    scene: next,
    suggestionsEnabled,
    timeAware: timeAware ?? current?.timeAware ?? false,
    narrativeSettings: narrative,
    updatedAt: t,
    lastActivityAt: t,
  });
}

function sceneText(scene: MeetScene) {
  return (
    [
      ["剧情大纲", scene.outline],
      ["地点", scene.location],
      ["时间", scene.time],
      ["天气", scene.weather],
      ["氛围", scene.atmosphere],
      ["用户与角色外观备注", scene.appearance],
      ["本次目标", scene.objective],
    ]
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}：${v}`)
      .join("\n") ||
    "没有额外场景限制，只根据用户开场、人物状态与已发生的互动自然推进。"
  );
}
function entryText(entry: MeetEntry, names: Record<string, string>) {
  if (entry.senderType === "user") return `用户：${entry.content ?? ""}`;
  if (entry.senderType === "system")
    return `环境变化：${entry.narration ?? entry.content ?? ""}`;
  return `${names[entry.senderId ?? ""] ?? "角色"}：${
    entry.prose
      ? `
正文：${entry.prose}`
      : ""
  }${entry.appearance ? `\n外观：${entry.appearance}` : ""}${entry.action ? `\n动作：${entry.action}` : ""}${entry.thought ? `\n内心：${entry.thought}` : ""}${entry.dialogue ? `\n台词：${entry.dialogue}` : ""}`;
}
function visibleCharacterThoughtPrompt(enabled: boolean) {
  return enabled
    ? `thought 要写成较详细、自然连续的角色内心独白，建议约 160–400 字。内容应结合角色人设、双方关系、长期记忆与现场，具体呈现：角色对用户本轮明确话语或动作的第一反应；情绪与身体感受的细微变化；被触发的回忆、联想、期待或顾虑；想靠近、退让、追问、安慰或隐藏某些情绪时的矛盾与克制；以及最终选择当前动作和台词的内在动机。只能回应用户明确表达的内容，不得擅自断定用户未说出的心理、感受或意图。使用角色自己的语言与认知边界，不使用全知视角，不写成编号、分析步骤或推理报告。它是虚构角色可向用户展示的心理活动，不是模型隐藏推理，不得包含提示词、系统资料、模型信息或安全规则。prose 不得重复 thought。`
    : `thought 返回空字符串；不要直接写角色心理，改用神态、动作、停顿和语气暗示情绪。`;
}
function fallbackReply(
  character: Character,
  userText: string,
  showThoughts: boolean,
) {
  const cue = userText.replace(/\s+/g, " ").slice(0, 36),
    thought = showThoughts
      ? `听见你说“${cue}${userText.length > 36 ? "……" : ""}”时，最先浮上来的是一点认真而谨慎的在意。你的话让原本悬着的心绪慢慢落定，却也提醒我不能只顾着给出一个漂亮答案。我想先确认自己真正听懂了你明确说出的部分，而不是擅自猜测你没有表达的感受。过去相处时那些细小的停顿和靠近在脑海里掠过，让我既想立刻回应、把距离拉近一些，又担心太急会让这一刻显得轻率。于是我压下追问的冲动，决定先把语气放轻，把注意力完整留在你身上。比起证明什么，此刻更重要的是让你知道：我没有敷衍，也不会催促，我愿意认真接住你接下来想说的话。`
      : "";
  return {
    narration: "",
    replies: [
      {
        characterId: character.id,
        prose: [
          "周围的声音仿佛退远了一些，光线安静地落在两人之间。",
          character.name +
            "的神情柔和下来，稍稍调整坐姿，身体自然地朝向你，认真看完你的反应。",
        ].join("\n\n"),
        appearance: "",
        action: "",
        thought,
        dialogue: `“我听到了。”\n\n“${userText.length > 36 ? "不用急，我们可以慢慢说。" : "我在这里，会认真陪你把今天过完。"}”`,
        suggestions: [] as string[],
      },
    ],
  };
}

export interface MeetTurnResult {
  entries: MeetEntry[];
  warning?: string;
}

export async function generateMeetTurn(
  sessionId: string,
  userText: string,
  signal?: AbortSignal,
): Promise<MeetTurnResult> {
  return generateMeetTurnInternal(sessionId, userText, signal);
}

export async function retryFailedMeetTurn(
  sessionId: string,
  entryId: string,
  signal?: AbortSignal,
): Promise<MeetTurnResult> {
  const session = await db.meetSessions.get(sessionId);
  const entry = session?.entries.find((item) => item.id === entryId);
  if (!session || session.status !== "active") throw new Error("\u8fd9\u6b21\u89c1\u9762\u5df2\u7ecf\u7ed3\u675f");
  if (!entry || entry.senderType !== "user" || entry.generation?.status !== "failed")
    throw new Error("\u6ca1\u6709\u627e\u5230\u53ef\u91cd\u65b0\u751f\u6210\u7684\u5931\u8d25\u8f6e\u6b21");
  return generateMeetTurnInternal(sessionId, entry.content ?? "", signal, entryId);
}

async function updateMeetGeneration(
  sessionId: string,
  entryId: string,
  generation: NonNullable<MeetEntry["generation"]>,
) {
  const latest = await db.meetSessions.get(sessionId);
  if (!latest) return;
  await db.meetSessions.update(sessionId, {
    entries: latest.entries.map((entry) =>
      entry.id === entryId ? { ...entry, generation } : entry,
    ),
    updatedAt: now(),
  });
}

async function generateMeetTurnInternal(
  sessionId: string,
  userText: string,
  signal?: AbortSignal,
  retryEntryId?: string,
): Promise<MeetTurnResult> {
  const text = userText.trim();
  if (!text) throw new Error("请输入你想说的话或动作");
  const session = await db.meetSessions.get(sessionId);
  if (!session || session.status !== "active")
    throw new Error("这次见面已经结束");
  const characters = (
    await db.characters.bulkGet(session.participantIds)
  ).filter(Boolean) as Character[];
  if (!characters.length) throw new Error("参与角色已不存在");
  const t = now(),
    existingUserEntry = retryEntryId
      ? session.entries.find(
          (entry) => entry.id === retryEntryId && entry.senderType === "user",
        )
      : undefined,
    roundId = existingUserEntry?.roundId ?? uid(),
    userEntry: MeetEntry = existingUserEntry
      ? {
          ...existingUserEntry,
          content: text,
          generation: { status: "generating", stage: "requesting" },
        }
      : {
          id: uid(),
          roundId,
          senderType: "user",
          content: text,
          generation: { status: "generating", stage: "requesting" },
          createdAt: t,
        },
    resumedSession = resumeMeetSessionForOfflineActivity(session, t),
    historyEntries = existingUserEntry
      ? resumedSession.entries
          .filter(
            (entry) =>
              entry.id === existingUserEntry.id || entry.roundId !== roundId,
          )
          .map((entry) => (entry.id === existingUserEntry.id ? userEntry : entry))
      : [...resumedSession.entries, userEntry],
    sessionForTurn: MeetSession = {
      ...resumedSession,
      entries: historyEntries,
      lastActivityAt: t,
      updatedAt: t,
    };
  await db.transaction("rw", db.meetSessions, async () => {
    await db.meetSessions.put(sessionForTurn);
  });
  const [provider, memories, loreBooks, conversation, appSettings, onlineMessages] =
      await Promise.all([
        getProvider(),
        db.memories.toArray(),
        db.loreBooks.toArray(),
        session.conversationId
          ? db.conversations.get(session.conversationId)
          : undefined,
        getAppSettings(),
        session.conversationId
          ? db.messages
              .where("conversationId")
              .equals(session.conversationId)
              .sortBy("createdAt")
          : Promise.resolve([] as Message[]),
      ]),
    baseSettings = normalizeNarrativeSettings(sessionForTurn.narrativeSettings),
    settings = await ensureMeetCompiledStyle(baseSettings, provider, signal),
    names = Object.fromEntries(
      characters.map((character) => [character.id, character.name]),
    ),
    history = historyEntries
      .slice(-60)
      .map((entry) => entryText(entry, names))
      .join("\n\n"),
    state =
      sessionForTurn.sceneState ?? defaultMeetSceneState(sessionForTurn.scene, characters),
    plotState =
      sessionForTurn.plotState ?? defaultMeetPlotState(sessionForTurn.scene, characters),
    planningContinuity = buildMeetCrossModeContinuity({
      session: sessionForTurn,
      conversation,
      messages: onlineMessages,
      actorId: characters[0].id,
      names,
    });
  await db.meetSessions.update(session.id, {
    narrativeSettings: settings,
    sceneState: state,
    plotState,
    lastActivityAt: t,
    updatedAt: t,
  });
  if (!provider.apiKey) {
    const fallback = fallbackReply(
        characters[0],
        text,
        settings.thoughtsEnabled,
      ),
      reply = fallback.replies[0],
      entry: MeetEntry = {
        id: uid(),
        roundId,
        senderType: "character",
        senderId: reply.characterId,
        prose: reply.prose,
        thought: reply.thought,
        dialogue: reply.dialogue,
        suggestions: [],
        createdAt: t + 1,
      };
    await db.meetSessions.update(session.id, {
      entries: [...historyEntries.map((item) =>
        item.id === userEntry.id
          ? { ...item, generation: { status: "complete" as const, model: provider.model, saveResult: "saved" as const } }
          : item,
      ), entry],
      lastActivityAt: t + 1,
      updatedAt: t + 1,
    });
    return { entries: [entry] };
  }
  const plan = await selectMeetResponders({
      characters,
      state,
      plotState,
      outline: session.scene.outline,
      userText: text,
      history: [planningContinuity, history].filter(Boolean).join("\n\n"),
      provider,
      signal,
    }),
    entries: MeetEntry[] = [],
    failures: string[] = [],
    style = meetStyleContract(settings),
    generationMeta: NonNullable<MeetEntry["generation"]> = {
      status: "generating",
      stage: "requesting",
      model: provider.model,
      saveResult: "pending",
    };
  let nextState = state,
    nextPlotState = plotState,
    injectedLoreEntries = 0,
    skippedLoreEntries = 0;
  for (const selected of plan.responders) {
    const character = characters.find(
      (item) => item.id === selected.characterId,
    );
    if (!character) continue;
    try {
      const cv = conversation ?? {
          id: session.id,
          schemaVersion: SCHEMA_VERSION,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          title: "线下见面",
          type: "private" as const,
          memberIds: session.participantIds,
          presetIds: [],
          loreBookIds: [],
          lastActivityAt: session.lastActivityAt,
        },
        prepared = await prepareRoleplayResources({
          character,
          conversation: cv,
          loreBooks,
          provider,
          signal,
        }),
        ownMemories = selectMemories(
          memories,
          character.id,
          session.conversationId ?? "",
          10,
          text,
          true,
        ),
        mounted = prepared.loreBooks.filter((book) =>
          conversation
            ? isLoreBookMounted(
                book,
                character.id,
                conversation.id,
                character,
                conversation,
              )
            : book.enabled,
        ),
        loreDecisions = evaluateLore({
          books: mounted,
          texts: [history, planningContinuity, text],
          characterId: character.id,
          conversationId: session.conversationId ?? session.id,
          character,
          conversation,
          seed: `meet:${session.id}:${roundId}:${character.id}`,
          budget: Math.floor(INTERNAL_LORE_BUDGET_TOKENS * 3.2),
        }),
        lore = loreDecisions.filter((item) => item.injected),
        loreGroups = groupLoreByInsertion(lore),
        earlier = entries.map((entry) => entryText(entry, names)).join("\n\n"),
        bilingual = autoTranslateCharacter(character, cv),
        crossModeContinuity = buildMeetCrossModeContinuity({
          session: sessionForTurn,
          conversation,
          messages: onlineMessages,
          actorId: character.id,
          names,
        }),
        promptSections: PrioritizedPromptSection[] = [
          { id: "roleplay-protocol", content: strongRoleplayInstruction("private-chat"), required: true },
          { id: "base-lore", content: loreEntriesBlock(loreGroups["base-rules"]), priority: 98 },
          { id: "meet-boundary", content: "这是线下见面，不是手机聊天。角色可以主动靠近、递物或发起接触，但动作必须停在用户回应点，不得替用户写接受、拒绝、动作、心理、身体反应或台词。小范围移动和自然环境变化可以推进；换地点、时间跳跃、新事件和新人物只能提议。", required: true },
          { id: "character-core", content: `当前角色：${character.name}\n核心设定：${coreSettingOf(character)}\n完整人设：${personaOf(character)}\n${performanceProfileContext(prepared.character)}\n${languageStyleInstruction(chatSettingsOf(character).language)}`, required: true },
          { id: "character-lore", content: loreEntriesBlock(loreGroups["after-character"]), priority: 94 },
          { id: "user-persona", content: userPersonaContext(appSettings), required: true },
          { id: "time-awareness", content: meetTimeContext(sessionForTurn, new Date(t)), required: Boolean(sessionForTurn.timeAware) },
          { id: "scene-outline", content: `剧情大纲（软方向）：${session.scene.outline ?? "无"}`, priority: 92 },
          { id: "scene-state", content: `场景状态：${JSON.stringify(nextState)}`, priority: 94 },
          { id: "plot-state", content: `剧情状态：${JSON.stringify(nextPlotState)}`, priority: 92 },
          { id: "plot-rule", content: "角色有责任主动推进剧情，不能完全迎合、依附用户或把所有决定退还给用户。合适时必须作出决定、揭露信息、制造或缓解冲突、提出具体行动、产生后果或推进关系；重大结果必须停在用户回应点。推进必须来自人设、记忆、世界书、大纲或已有因果，不得凭空制造灾难和陌生人物。", priority: 96 },
          { id: "memories", content: ownMemories.length ? `角色自己的记忆：${ownMemories.map((item) => item.content).join("；")}` : false, priority: 60 },
          { id: "memory-lore", content: loreEntriesBlock(loreGroups["after-memory"]), priority: 82 },
          { id: "style", content: `严格文风契约：\n${style}`, required: true },
          { id: "history-lore", content: loreEntriesBlock(loreGroups["before-history"]), priority: 74 },
          { id: "history", content: `完整线下记录：\n${history}`, priority: 25 },
          { id: "continuity", content: crossModeContinuity, priority: 55 },
          { id: "round-earlier", content: earlier ? `本轮前面角色已经公开的帖子：\n${earlier}` : false, priority: 78 },
          { id: "user-lore", content: loreEntriesBlock(loreGroups["before-user"]), priority: 90 },
          { id: "latest-user", content: `用户本轮明确输入：${text}`, required: true },
          { id: "thought-contract", content: visibleCharacterThoughtPrompt(settings.thoughtsEnabled), required: true },
          { id: "output-contract", content: `只生成 ${character.name} 的一个帖子。prose 与 thought 严格执行文风；dialogue 只按角色自己的说话习惯。目标篇幅 ${settings.minChars}–${settings.maxChars} 字。只返回严格 JSON：{"characterId":"${character.id}","prose":"正文","thought":"角色内心或空字符串","dialogue":"说出口的话","suggestions":[],"plotProgress":{"advanced":true或false,"actionType":"decision|reveal|conflict|proposal|consequence|relationship|environment","summary":"推进摘要","requiresUserResponse":true或false},"scenePatch":{}}`, required: true },
          { id: "translation-contract", content: bilingual ? "For prose, thought and dialogue, also return translations with faithful Simplified Chinese versions. Do not alter plot content." : false, required: Boolean(bilingual) },
        ];
      injectedLoreEntries += lore.length;
      skippedLoreEntries += loreDecisions.length - lore.length;
      generationMeta.injectedLoreEntries = injectedLoreEntries;
      generationMeta.skippedLoreEntries = skippedLoreEntries;
      let turn: ReturnType<typeof meetTurnSchema.parse> | undefined;
      let lastTurnError: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const fittedPrompt = fitPrioritizedPromptSections(
            [
              ...promptSections,
              ...(attempt
                ? [{
                    id: "retry-contract",
                    content: "上一次回复格式不正确或上下文过长。只返回一个完整 JSON 对象；角色 ID 必须一致；不要代码块或解释。",
                    required: true,
                  }]
                : []),
            ],
            attempt === 0
              ? INTERNAL_INPUT_BUDGET_TOKENS
              : Math.floor(INTERNAL_INPUT_BUDGET_TOKENS * 0.72),
          );
          const compactStreamingRetry = attempt === 1 && shouldUseCompactStreamingRetry(lastTurnError);
          const baseMessages = [
            {
              role: "system" as const,
              content:
                "\u4f60\u6b63\u5728\u751f\u6210\u7ebf\u4e0b\u89c1\u9762\u89d2\u8272\u56de\u590d\u3002\u5fc5\u987b\u9075\u5b88\u7528\u6237\u63d0\u4f9b\u7684\u7ed3\u6784\uff0c\u53ea\u8f93\u51fa\u6709\u6548 JSON\u3002",
            },
            {
              role: "user" as const,
              content: compactStreamingRetry
                ? `${fittedPrompt.text}\n\n这是一次完整紧凑重生成：只输出单行、无 Markdown、无解释的完整 JSON；不得续写或拼接上一次响应；保留所有必需字段、角色 ID 和必要译文。`
                : fittedPrompt.text,
            },
          ];
          const fitted = fitChatItemsToInternalBudget(baseMessages);
          generationMeta.stage = "requesting";
          generationMeta.estimatedInputTokens = Math.max(
            generationMeta.estimatedInputTokens ?? 0,
            estimateChatTokens(fitted.items),
          );
          await updateMeetGeneration(session.id, userEntry.id, { ...generationMeta });
          const response = await new OpenAIProvider({ ...provider, stream: compactStreamingRetry }).chatWithMeta(
            fitted.items,
            {
              stream: compactStreamingRetry,
              signal,
              timeoutMs: null,
              temperature: attempt === 0 ? provider.temperature : 0.1,
            },
          );
          Object.assign(generationMeta, {
            stage: "parsing" as const,
            responseShape: response.responseShape,
            rawLength: response.rawLength,
            outputTokens: response.outputTokens,
            finishReason: response.finishReason,
            truncated: response.truncated,
          });
          await updateMeetGeneration(session.id, userEntry.id, { ...generationMeta });
          const raw = response.text;

          const structured = parseStructuredJsonWithMeta(raw, {
            transportMarkedIncomplete: response.truncated,
          });
          let candidate: unknown = structured.value;

          if (Array.isArray(candidate)) candidate = candidate[0];
          if (candidate && typeof candidate === "object") {
            const root = candidate as Record<string, unknown>;
            if (Array.isArray(root.replies)) {
              candidate = root.replies[0];
            } else if (typeof root.content === "string" && !root.characterId) {
              candidate = {
                characterId: character.id,
                prose: root.content,
                thought: "",
                dialogue: "",
                suggestions: [],
              };
            }
          }

          if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
            const row = candidate as Record<string, unknown>;
            if (!row.characterId) candidate = { ...row, characterId: character.id };
          }
          generationMeta.stage = "validating";
          await updateMeetGeneration(session.id, userEntry.id, { ...generationMeta });
          const parsed = meetTurnSchema.parse(candidate);
          if (parsed.characterId !== character.id) {
            throw new Error("\u89d2\u8272 ID \u4e0e\u5f53\u524d\u89d2\u8272\u4e0d\u4e00\u81f4");
          }
          if (
            bilingual &&
            ((!parsed.translations?.prose && parsed.prose) ||
              (!parsed.translations?.dialogue && parsed.dialogue) ||
              (settings.thoughtsEnabled &&
                parsed.thought &&
                !parsed.translations?.thought))
          ) {
            throw new Error("\u53cc\u8bed\u56de\u590d\u7f3a\u5c11\u5fc5\u8981\u8bd1\u6587");
          }
          if (meetStyleViolation(parsed, settings)) {
            throw new ProviderError(
              "format",
              `\u89c1\u9762\u56de\u590d\u7bc7\u5e45\u672a\u8fbe\u5230\u8bbe\u7f6e\u8303\u56f4\uff08\u9700\u8981 ${settings.minChars}-${settings.maxChars} \u5b57\uff09`,
            );
          }
          turn = parsed;
          lastTurnError = undefined;
          break;
        } catch (error) {
          if (error instanceof ProviderError && error.kind === "aborted") {
            throw error;
          }
          lastTurnError = error;
        }
      }
      if (!turn) {
        throw lastTurnError ?? new Error("\u89d2\u8272\u56de\u590d\u683c\u5f0f\u65e0\u6cd5\u6062\u590d");
      }
      const createdAt = t + entries.length + 1,
        entry: MeetEntry = {
          id: uid(),
          roundId,
          senderType: "character",
          senderId: character.id,
          prose:
            (entries.length === 0 && plan.sharedEnvironmentChange
              ? plan.sharedEnvironmentChange + "\n\n"
              : "") + turn.prose,
          thought: settings.thoughtsEnabled ? turn.thought : "",
          dialogue: turn.dialogue,
          translations: bilingual
            ? {
                prose: turn.translations?.prose
                  ? completedTranslation(
                      turn.prose,
                      turn.translations.prose,
                      provider.model,
                    )
                  : undefined,
                thought:
                  turn.thought && turn.translations?.thought
                    ? completedTranslation(
                        turn.thought,
                        turn.translations.thought,
                        provider.model,
                      )
                    : undefined,
                dialogue: turn.translations?.dialogue
                  ? completedTranslation(
                      turn.dialogue,
                      turn.translations.dialogue,
                      provider.model,
                    )
                  : undefined,
              }
            : undefined,
          suggestions: session.suggestionsEnabled ? turn.suggestions : [],
          scenePatch: turn.scenePatch,
          plotProgress: turn.plotProgress,
          createdAt,
        };
      entries.push(entry);
      nextState = applyMeetScenePatch(
        nextState,
        character.id,
        turn.scenePatch,
        text,
      );
      nextPlotState = applyMeetPlotProgress(
        nextPlotState,
        character.id,
        turn.plotProgress,
        entry.id,
      );
    } catch (error) {
      if (error instanceof ProviderError && error.kind === "aborted") throw error;
      failures.push(
        `${character.name}：${
          error instanceof Error ? error.message : "\u56de\u590d\u751f\u6210\u5931\u8d25"
        }`,
      );
    }
  }
  if (!entries.length) {
    const reason = failures[0] ?? "角色没有生成有效回复";
    const latest = await db.meetSessions.get(session.id);
    if (latest) await db.meetSessions.update(session.id, {
      entries: latest.entries.map(entry => entry.id === userEntry.id ? { ...entry, generation: { ...generationMeta, status: "failed" as const, error: reason, model: provider.model, saveResult: "failed" as const } } : entry),
      updatedAt: now(),
    });
    throw new Error(reason);
  }
  generationMeta.stage = "saving";
  await updateMeetGeneration(session.id, userEntry.id, { ...generationMeta });
  const current = await db.meetSessions.get(session.id);
  if (!current || current.status !== "active")
    throw new Error("见面状态已经变化");
  await db.meetSessions.update(session.id, {
    entries: [...current.entries.map(entry => entry.id === userEntry.id ? { ...entry, generation: { ...generationMeta, status: "complete" as const, model: provider.model, saveResult: "saved" as const } } : entry), ...entries],
    narrativeSettings: settings,
    sceneState: nextState,
    plotState: nextPlotState,
    lastActivityAt: entries[entries.length - 1]!.createdAt,
    updatedAt: now(),
  });
  for (const entry of entries) {
    const character = characters.find((item) => item.id === entry.senderId);
    if (character?.chatSettings?.strategyMode?.enabled)
      try {
        await evaluateStrategyInteraction({
          character,
          sourceId: `meet:${sessionId}:${userEntry.id}:${character.id}`,
          userText: text,
          messages: [],
          characters,
          provider,
          signal,
        });
      } catch {}
  }
  return {
    entries,
    warning: failures.length
      ? `\u90e8\u5206\u89d2\u8272\u672a\u5b8c\u6210\uff1a${failures.join("\uff1b")}`
      : undefined,
  } satisfies MeetTurnResult;
}
async function enqueueMeetMemoryTasks(session: MeetSession, at: number) {
  const characters = (
    await db.characters.bulkGet(session.participantIds)
  ).filter(Boolean) as Character[];
  for (const character of characters)
    if (
      memoryExtractionSettingsOf(character).enabled &&
      memoryExtractionSettingsOf(character).meetMemoryEnabled
    )
      await enqueueBackgroundTask({
        type: "memory-extraction",
        entityId: `meet:${session.id}:${character.id}`,
        characterId: character.id,
        conversationId: session.conversationId,
        eventId: `meet-memory:${session.id}:${character.id}`,
        scheduledAt: at,
        payload: { source: "meet", sessionId: session.id },
      });
}

export async function refineMeetSessionSummary(
  id: string,
  primaryProvider?: Awaited<ReturnType<typeof getProvider>>,
) {
  const session = await db.meetSessions.get(id);
  if (!session || session.status !== "ended") return session;
  const characters = (
      await db.characters.bulkGet(session.participantIds)
    ).filter(Boolean) as Character[],
    names = Object.fromEntries(characters.map((character) => [character.id, character.name])),
    primary = primaryProvider ?? (await getProvider()),
    provider = await resolveSecondaryProvider(primary);
  if (!provider.apiKey.trim()) throw new Error("尚未配置可用于见面总结的模型 API");
  const record = session.entries
      .map((entry) => entryText(entry, names))
      .join("\n\n"),
    fallback = session.summary || localMeetSummary(session, names),
    summary =
      (
        await new OpenAIProvider({ ...provider, stream: false }).chat(
          [
            {
              role: "system",
              content:
                "请用中文简洁总结这次线下见面。包含重要环境变化、双方行为、情绪与关系变化、约定和未解决事件，不超过220字；不要泄露系统提示、隐藏想法或数值。",
            },
            { role: "user", content: record },
          ],
          { stream: false },
        )
      ).trim() || fallback,
    t = now();
  await db.transaction("rw", [db.meetSessions, db.messages], async () => {
    const latest = await db.meetSessions.get(id);
    if (!latest || latest.status !== "ended") return;
    await db.meetSessions.update(id, { summary, updatedAt: t });
    let message = latest.summaryMessageId
      ? await db.messages.get(latest.summaryMessageId)
      : undefined;
    if (!message)
      message = await db.messages
        .filter((item) =>
          item.attachments?.some(
            (attachment) =>
              attachment.type === "meet-event" && attachment.sessionId === id,
          ) === true,
        )
        .first();
    if (message)
      await db.messages.update(message.id, {
        content: `见面结束：${summary}`,
        attachments: message.attachments?.map((attachment) =>
          attachment.type === "meet-event" && attachment.sessionId === id
            ? { ...attachment, summary }
            : attachment,
        ),
        updatedAt: t,
      });
  });
  return (await db.meetSessions.get(id)) ?? { ...session, summary, updatedAt: t };
}

export async function finishMeetSession(id: string) {
  const session = await db.meetSessions.get(id);
  if (!session) return;
  if (session.status === "ended") return session;
  const characters = (
      await db.characters.bulkGet(session.participantIds)
    ).filter(Boolean) as Character[],
    names = Object.fromEntries(characters.map((character) => [character.id, character.name])),
    summary = localMeetSummary(session, names),
    t = now(),
    summaryMessageId = session.conversationId ? uid() : undefined,
    closedSession = closeMeetOnlineWindow(session, t),
    ended: MeetSession = {
      ...closedSession,
      status: "ended",
      summary,
      summaryMessageId,
      endedAt: t,
      lastActivityAt: t,
      updatedAt: t,
    };
  await db.transaction(
    "rw",
    [db.meetSessions, db.messages, db.conversations],
    async () => {
      await db.meetSessions.put(ended);
      if (session.conversationId && summaryMessageId) {
        const message: Message = {
          id: summaryMessageId,
          schemaVersion: SCHEMA_VERSION,
          createdAt: t,
          updatedAt: t,
          conversationId: session.conversationId,
          senderType: "system",
          content: `见面结束：${summary}`,
          kind: "meet-event",
          attachments: [
            {
              type: "meet-event",
              sessionId: id,
              participantIds: session.participantIds,
              durationMs: Math.max(0, t - session.startedAt),
              summary,
            },
          ],
          status: "complete",
        };
        await db.messages.add(message);
        await db.conversations.update(session.conversationId, {
          lastActivityAt: t,
          updatedAt: t,
        });
      }
    },
  );
  await Promise.allSettled([
    enqueueBackgroundTask({
      type: "meet-summary",
      entityId: `meet:${id}`,
      conversationId: session.conversationId,
      eventId: `meet-summary:${id}`,
      scheduledAt: t,
      payload: { sessionId: id },
    }),
    enqueueMeetMemoryTasks(ended, t),
    ...session.participantIds.map((characterId) => rewardIslandMeet(characterId, id, summary, session.conversationId)),
  ]);
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event("mira:proactive-check"));
  return ended;
}
export function meetInvitationPrompt(input: {
  character: Character;
  userText: string;
  replyText: string;
  appSettings: AppSettings;
}) {
  return [
    `角色：${input.character.name}`,
    userPersonaContext(input.appSettings),
    `用户本轮内容：${input.userText}`,
    `角色刚才的回复：${input.replyText}`,
    "若生成邀请文案、角色开场或场景描述，必须符合角色人设、双方关系和用户身份背景；不得替用户决定行动、感受、心理或发言，也不得暴露人物设定、系统资料、模型或提示词。",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function maybeCreateMeetInvitation(input: {
  character: Character;
  conversationId: string;
  userText: string;
  replyText: string;
  signal?: AbortSignal;
}) {
  const conversation = await db.conversations.get(input.conversationId);
  if (
    !conversation ||
    !canCharacterInteract(input.character) ||
    !conversationChatSettingsOf(conversation, input.character).permissions
      ?.proactiveMeetInvitation ||
    !invitationRelevant(`${input.userText}\n${input.replyText}`)
  )
    return;
  const pending = await db.messages
    .where("conversationId")
    .equals(input.conversationId)
    .filter(
      (message) =>
        message.kind === "meet-invitation" &&
        message.attachments?.some(
          (a) => a.type === "meet-invitation" && a.state === "pending",
        ) === true,
    )
    .first();
  if (pending) return;
  const [provider, appSettings] = await Promise.all([
    getProvider(),
    getAppSettings(),
  ]);
  if (!provider.apiKey) return;
  try {
    const raw = await new OpenAIProvider(provider).chat(
        [
          {
            role: "system",
            content: `判断角色回复是否自然包含线下见面意图。只返回严格 JSON：{"invite":true,"invitationText":"邀请文案","opening":"角色准备的开场","location":"可选地点","atmosphere":"可选氛围"}。没有明确意图返回 {"invite":false}。`,
          },
          {
            role: "user",
            content: meetInvitationPrompt({ ...input, appSettings }),
          },
        ],
        { stream: false, signal: input.signal, timeoutMs: null },
      ),
      start = raw.indexOf("{"),
      end = raw.lastIndexOf("}"),
      value = JSON.parse(raw.slice(start, end + 1));
    if (
      value.invite !== true ||
      !String(value.invitationText ?? "").trim() ||
      !String(value.opening ?? "").trim()
    )
      return;
    const t = now(),
      message: Message = {
        id: uid(),
        schemaVersion: SCHEMA_VERSION,
        createdAt: t,
        updatedAt: t,
        conversationId: input.conversationId,
        senderType: "character",
        senderId: input.character.id,
        content: String(value.invitationText),
        kind: "meet-invitation",
        attachments: [
          {
            type: "meet-invitation",
            invitationId: uid(),
            conversationId: input.conversationId,
            characterId: input.character.id,
            participantIds: [input.character.id],
            invitationText: String(value.invitationText),
            scene: {
              opening: String(value.opening),
              location: String(value.location ?? "").trim() || undefined,
              atmosphere: String(value.atmosphere ?? "").trim() || undefined,
            },
            state: "pending",
            expiresAt: t + 7 * 86400000,
          },
        ],
        status: "complete",
      };
    await db.transaction("rw", [db.messages, db.conversations], async () => {
      await db.messages.add(message);
      await db.conversations.update(input.conversationId, {
        lastActivityAt: t,
        updatedAt: t,
      });
    });
    return message;
  } catch {
    return;
  }
}
export async function respondMeetInvitation(
  messageId: string,
  accept: boolean,
) {
  const message = await db.messages.get(messageId),
    attachment = message?.attachments?.find(
      (a) => a.type === "meet-invitation",
    );
  if (
    !message ||
    !attachment ||
    attachment.type !== "meet-invitation" ||
    attachment.state !== "pending"
  )
    return;
  if (!accept) {
    await db.messages.update(messageId, {
      attachments: message.attachments?.map((a) =>
        a === attachment
          ? { ...attachment, state: "declined" as const, processedAt: now() }
          : a,
      ),
      updatedAt: now(),
    });
    return;
  }
  const session = await createMeetSession({
    participantIds: attachment.participantIds,
    conversationId: attachment.conversationId,
    scene: attachment.scene,
    narrativeSettings: DEFAULT_MEET_NARRATIVE_SETTINGS,
    initiator: "character",
    invitationMessageId: messageId,
  });
  const fresh = await db.messages.get(messageId),
    freshAttachment = fresh?.attachments?.find(
      (a) => a.type === "meet-invitation",
    );
  if (
    !fresh ||
    !freshAttachment ||
    freshAttachment.type !== "meet-invitation" ||
    freshAttachment.state !== "pending"
  )
    return session;
  await db.messages.update(messageId, {
    attachments: fresh.attachments?.map((a) =>
      a === freshAttachment
        ? {
            ...freshAttachment,
            state: "accepted" as const,
            sessionId: session.id,
            processedAt: now(),
          }
        : a,
    ),
    updatedAt: now(),
  });
  return session;
}

export async function toggleMeetEntryFavorite(
  sessionId: string,
  entryId: string,
  time = now(),
) {
  const session = await db.meetSessions.get(sessionId);
  if (!session) return;
  const target = session.entries.find((entry) => entry.id === entryId);
  if (!target) return;
  const favoritedAt = target.favoritedAt ? undefined : time,
    entries = session.entries.map((entry) =>
      entry.id === entryId ? { ...entry, favoritedAt } : entry,
    );
  await db.meetSessions.update(sessionId, { entries, updatedAt: time });
  return favoritedAt;
}
export async function editMeetUserEntry(
  sessionId: string,
  entryId: string,
  content: string,
) {
  const value = content.trim();
  if (!value) throw new Error("帖子内容不能为空");
  const session = await db.meetSessions.get(sessionId),
    target = session?.entries.find((entry) => entry.id === entryId);
  if (
    !session ||
    session.status !== "active" ||
    !target ||
    target.senderType !== "user"
  )
    throw new Error("当前帖子不能编辑");
  const t = now(),
    entries = session.entries.map((entry) =>
      entry.id === entryId ? { ...entry, content: value } : entry,
    );
  await db.meetSessions.update(sessionId, {
    entries,
    lastActivityAt: t,
    updatedAt: t,
  });
  return entries.find((entry) => entry.id === entryId);
}
export async function deleteMeetEntry(sessionId: string, entryId: string) {
  const session = await db.meetSessions.get(sessionId);
  if (!session || session.status !== "active")
    throw new Error("已结束的见面不能删除帖子");
  if (!session.entries.some((entry) => entry.id === entryId)) return;
  const t = now(),
    entries = session.entries.filter((entry) => entry.id !== entryId);
  await db.meetSessions.update(sessionId, {
    entries,
    lastActivityAt: t,
    updatedAt: t,
  });
}
export function meetEntryPlainText(entry: MeetEntry) {
  return [
    entry.content,
    entry.narration,
    entry.prose,
    entry.appearance,
    entry.action,
    entry.dialogue,
  ]
    .filter(Boolean)
    .join("\n\n");
}
export async function regenerateMeetCharacterEntry(
  sessionId: string,
  entryId: string,
  signal?: AbortSignal,
) {
  const session = await db.meetSessions.get(sessionId);
  if (!session || session.status !== "active")
    throw new Error("已结束的见面不能重新生成");
  const target = session.entries.find((entry) => entry.id === entryId);
  if (!target || target.senderType !== "character" || !target.senderId)
    throw new Error("当前帖子不能重新生成");
  const source = session.entries.find(
    (entry) => entry.roundId === target.roundId && entry.senderType === "user",
  );
  if (!source?.content) throw new Error("找不到这一轮的用户输入");
  const character = await db.characters.get(target.senderId);
  if (!character) throw new Error("角色已不存在");
  const baseSettings = normalizeNarrativeSettings(session.narrativeSettings),
    [provider, appSettings] = await Promise.all([
      getProvider(),
      getAppSettings(),
    ]),
    settings = await ensureMeetCompiledStyle(baseSettings, provider, signal),
    bilingual = autoTranslateCharacter(character),
    characters = [character],
    names = { [character.id]: character.name },
    generationTime = new Date(),
    history = session.entries
      .filter((entry) => entry.id !== entryId)
      .slice(-60)
      .map((entry) => entryText(entry, names))
      .join("\n\n");
  let reply: ReturnType<typeof parseMeetReply>["replies"][number];
  if (!provider.apiKey) {
    reply = fallbackReply(character, source.content, settings.thoughtsEnabled)
      .replies[0];
  } else {
    const timeContext = meetTimeContext(session, generationTime),
      prompt = `请重新写当前角色在本轮线下见面中的帖子。只扮演 ${character.name}，不得新增用户输入，不得代替用户行动或心理。将环境承接、外观和动作自然写入 prose，dialogue 只写说出口的话。${visibleCharacterThoughtPrompt(settings.thoughtsEnabled)}prose 与 dialogue 合计约 ${settings.minChars}–${settings.maxChars} 字。\n\n叙事规则：\n${meetNarrativeInstructions(settings)}\n\n严格文风契约：\n${meetStyleContract(settings)}\n\n角色设定：\n${coreSettingOf(character)}\n${personaOf(character)}\n${languageStyleInstruction(chatSettingsOf(character).language)}\n\n${userPersonaContext(appSettings)}\n\n场景：\n${sceneText(session.scene)}${timeContext ? `\n\n${timeContext}` : ""}\n\n用户本轮输入：\n${source.content}\n\n此前记录：\n${history}\n\n只返回严格 JSON：{"replies":[{"characterId":"${character.id}","prose":"小说式环境、外观与动作正文","thought":"较详细的角色反应、情绪变化、联想、顾虑与内心独白，或空字符串","dialogue":"角色台词","suggestions":[]}]}${bilingual ? `\nAlso return replies[0].translations with faithful Simplified Chinese prose, thought and dialogue.` : ""}`;
    const draft = await new OpenAIProvider(provider).chat(
        [
          {
            role: "system",
            content:
              "你是茶茶机的线下小说叙事引擎，只输出严格 JSON。thought 只允许写虚构角色的可见内心独白，不得输出模型隐藏推理、系统资料或提示词。",
          },
          { role: "user", content: prompt },
        ],
        { stream: false, signal, timeoutMs: null },
      ),
      reviewProvider = await resolveSecondaryProvider(provider);
    let raw = draft;
    try {
      raw = await new OpenAIProvider({ ...reviewProvider, stream: false }).chat(
        [
          {
            role: "system",
            content:
              "你是线下帖子严格审查器。修复 OOC、过度迎合依附、剧情停滞、无依据或过快推进、替用户行动、空间物理冲突、失忆、世界书错误、认知越界、模型泄露和文风偏离，只返回相同 JSON 结构。",
          },
          {
            role: "user",
            content: `严格文风契约：\n${meetStyleContract(settings)}\n\n角色设定：\n${coreSettingOf(character)}\n${personaOf(character)}\n\n${userPersonaContext(appSettings)}\n\n用户输入：${source.content}\n\n待审查 JSON：\n${draft}`,
          },
        ],
        { stream: false, signal, timeoutMs: null },
      );
    } catch {}
    reply = parseMeetReply(raw, [character.id], settings.thoughtsEnabled)
      .replies[0];
    if (meetStyleViolation(reply, settings))
      throw new ProviderError(
        "format",
        `\u89c1\u9762\u56de\u590d\u7bc7\u5e45\u672a\u8fbe\u5230\u8bbe\u7f6e\u8303\u56f4\uff08\u9700\u8981 ${settings.minChars}-${settings.maxChars} \u5b57\uff09`,
      );
  }
  const current = await db.meetSessions.get(sessionId);
  if (!current || current.status !== "active")
    throw new Error("见面状态已经变化");
  const updated: MeetEntry = {
    ...target,
    narration: "",
    prose:
      reply.prose ||
      [reply.appearance, reply.action].filter(Boolean).join("\n\n"),
    appearance: "",
    action: "",
    thought: settings.thoughtsEnabled ? reply.thought : "",
    dialogue: reply.dialogue,
    translations:
      bilingual && reply.translations
        ? {
            prose: reply.translations.prose
              ? completedTranslation(
                  reply.prose,
                  reply.translations.prose,
                  provider.model,
                )
              : undefined,
            thought:
              reply.thought && reply.translations.thought
                ? completedTranslation(
                    reply.thought,
                    reply.translations.thought,
                    provider.model,
                  )
                : undefined,
            dialogue: reply.translations.dialogue
              ? completedTranslation(
                  reply.dialogue,
                  reply.translations.dialogue,
                  provider.model,
                )
              : undefined,
          }
        : undefined,
    suggestions: current.suggestionsEnabled ? reply.suggestions : [],
    favoritedAt: target.favoritedAt,
  };
  const t = now(),
    entries = current.entries.map((entry) =>
      entry.id === entryId ? updated : entry,
    );
  await db.meetSessions.update(sessionId, {
    entries,
    lastActivityAt: t,
    updatedAt: t,
  });
  if (character.chatSettings?.strategyMode?.enabled)
    try {
      await evaluateStrategyInteraction({
        character,
        sourceId: `meet:${sessionId}:${source.id}:${character.id}`,
        userText: source.content,
        messages: [],
        characters,
        provider,
        signal,
      });
    } catch {}
  return updated;
}

export async function generateMeetOpeningDraft(
  conversationId: string,
  participantIds: string[],
  signal?: AbortSignal,
) {
  const [
    conversation,
    provider,
    app,
    allCharacters,
    messages,
    books,
    memories,
  ] = await Promise.all([
    db.conversations.get(conversationId),
    getProvider(),
    getAppSettings(),
    db.characters.toArray(),
    db.messages
      .where("conversationId")
      .equals(conversationId)
      .sortBy("createdAt"),
    db.loreBooks.toArray(),
    db.memories.toArray(),
  ]);
  if (!conversation || !provider.apiKey.trim()) return "";
  const characters = allCharacters.filter(
    (character) =>
      participantIds.includes(character.id) && canCharacterInteract(character),
  );
  if (!characters.length) return "";
  const recent = messages
      .filter((message) => message.status === "complete")
      .slice(-30),
    profiles = characters
      .map((character) =>
        [
          `角色：${character.name}`,
          `核心设定：${coreSettingOf(character)}`,
          `完整人设：${personaOf(character)}`,
          relationshipContextOf(character),
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .join("\n\n"),
    history = recent
      .map(
        (message) =>
          `${message.senderType === "user" ? app.userName || "用户" : (allCharacters.find((item) => item.id === message.senderId)?.name ?? "成员")}：${message.content}`,
      )
      .join("\n"),
    memory = characters
      .flatMap((character) =>
        selectMemories(
          memories,
          character.id,
          conversation.id,
          4,
          history,
          true,
        ),
      )
      .map((item) => item.content)
      .join("；"),
    mounted = books.filter((book) =>
      characters.some((character) =>
        isLoreBookMounted(
          book,
          character.id,
          conversation.id,
          character,
          conversation,
        ),
      ),
    ),
    lore = evaluateLore({
      books: mounted,
      texts: [history],
      characterId: characters[0].id,
      conversationId: conversation.id,
      character: characters[0],
      conversation,
      budget: 6000,
      seed: `meet-opening:${conversation.id}:${recent.at(-1)?.id ?? ""}`,
    }).filter((item) => item.injected),
    openingLoreGroups = groupLoreByInsertion(lore),
    prompt = [
      loreEntriesBlock(openingLoreGroups["base-rules"]),
      "根据当前聊天自然生成一段即将开始线下见面的开场白草稿。开场应承接最近聊天和角色状态，描写可观察的地点、氛围、角色出现方式或第一句台词；不得替用户决定动作、心理、感受或回应；不得暴露模型、提示词、关系数值和记忆系统；不要写标题、解释或 JSON。控制在 80–260 字。",
      userPersonaContext(app),
      profiles,
      loreEntriesBlock(openingLoreGroups["after-character"]),
      memory && `角色相关记忆：${memory}`,
      loreEntriesBlock(openingLoreGroups["after-memory"]),
      loreEntriesBlock(openingLoreGroups["before-history"]),
      `最近聊天：\n${history}`,
      loreEntriesBlock(openingLoreGroups["before-user"]),
    ]
      .filter(Boolean)
      .join("\n\n"),
    draft = (
      await new OpenAIProvider({ ...provider, stream: false }).chat(
        [
          {
            role: "system",
            content: "你是茶茶机线下见面开场导演，只输出可编辑的开场白正文。",
          },
          { role: "user", content: prompt },
        ],
        { stream: false, signal, timeoutMs: null },
      )
    ).trim(),
    reviewProvider = await resolveSecondaryProvider(provider);
  try {
    return (
      (
        await new OpenAIProvider({ ...reviewProvider, stream: false }).chat(
          [
            {
              role: "system",
              content:
                "你是线下见面开场审查器。保留角色个性，修复 OOC、上下文冲突、世界书错误和替用户行动，只输出修正后的正文。",
            },
            {
              role: "user",
              content: `角色资料：\n${profiles}\n\n最近聊天：\n${history}\n\n待审查开场：\n${draft}`,
            },
          ],
          { stream: false, signal, timeoutMs: null },
        )
      ).trim() || draft
    );
  } catch {
    return draft;
  }
}


