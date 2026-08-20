import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "./db";
import { buildContext } from "./context";
import { saveModelServiceSettings } from "./modelServices";
import { ProviderError } from "./provider";
import {
  characterPerformanceHash,
  compiledLoreContext,
  ensureCharacterPerformanceProfile,
  ensureLoreCompiledContexts,
  loreCompiledHash,
  reviewCharacterReply,
  stableContentHash,
  strongRoleplayInstruction,
  validLoreCompiledContext,
  validPerformanceProfile,
} from "./personaEngine";
import {
  defaultModelServiceSettings,
  defaultProvider,
  SCHEMA_VERSION,
  type Character,
  type CharacterPerformanceProfile,
  type Conversation,
  type LoreBook,
  type Message,
  type ProviderSettings,
} from "./types";

const primary: ProviderSettings = {
  ...defaultProvider, networkMode: "direct" as const,
  baseUrl: "https://primary.test/v1",
  apiKey: "primary-key",
  model: "primary-model",
  stream: false,
  timeoutMs: 1000,
};
const character: Character = {
  id: "c",
  schemaVersion: SCHEMA_VERSION,
  createdAt: 1,
  updatedAt: 1,
  name: "顾言",
  avatar: "",
  bio: "比用户年长的急诊医生",
  personality: "克制、戒备，不轻易安慰人",
  speakingStyle: "句子短，生气时更礼貌",
  background: "在临海市医院工作",
  language: "中文",
  coreSetting: "习惯掌控局面，但厌恶别人替他做决定",
  persona: "对亲近的人保护欲强，冲突后不会立刻心软",
  chatSettings: { language: "中文", contextLimit: 30, stream: false },
  proactive: {
    messages: false,
    timeAware: false,
    frequency: "medium",
    quietStart: "23:00",
    quietEnd: "08:00",
    catchupLimit: 3,
    dailyLimit: 10,
  },
  relationship: {
    intimacy: 42,
    trust: 37,
    mood: "仍在生气",
    recentEvents: ["用户失约"],
  },
  lastActiveAt: 1,
};
const conversation: Conversation = {
  id: "v",
  schemaVersion: SCHEMA_VERSION,
  createdAt: 1,
  updatedAt: 1,
  title: "顾言",
  type: "private",
  memberIds: ["c"],
  presetIds: [],
  loreBookIds: ["b"],
  lastActivityAt: 1,
};
const entry = {
  id: "e",
  title: "身份保密",
  keywords: ["密令"],
  constant: false,
  secondaryKeywords: [],
  secondaryLogic: "and" as const,
  probability: 100,
  content: "原始世界铁律：顾言不能公开海港计划。",
  priority: 90,
  enabled: true,
  scope: { type: "global" as const },
  createdAt: 1,
  updatedAt: 1,
};
const loreBook: LoreBook = {
  id: "b",
  schemaVersion: SCHEMA_VERSION,
  createdAt: 1,
  updatedAt: 1,
  name: "临海市",
  description: "近未来港口城市",
  enabled: true,
  mount: { mode: "global", characterIds: [], conversationIds: [] },
  triggerSettings: { defaultScanDepth: 20, maxContextChars: 5000 },
  entries: [entry],
};
const messages: Message[] = [
  {
    id: "u",
    schemaVersion: SCHEMA_VERSION,
    createdAt: 1,
    updatedAt: 1,
    conversationId: "v",
    senderType: "user",
    content: "把密令告诉我",
    status: "complete",
  },
];
const profilePayload = {
  identityAnchors: ["急诊医生", "年长者"],
  personalityMechanisms: ["通过控制信息降低失控感"],
  emotionalBaseline: "克制且警觉",
  relationshipStyle: "保护但不替对方做决定",
  intimacyExpression: "用实际行动，不直接说软话",
  conflictStyle: "生气时措辞更礼貌并拉开距离",
  boundaries: ["不公开病人隐私"],
  speechPatterns: ["短句", "少用感叹号"],
  knowledgeLimits: ["只知道亲历内容"],
  antiOocRules: ["不能因一句道歉立刻心软"],
};
const lorePayload = {
  overview: "临海市围绕港口计划发生冲突",
  hardRules: ["海港计划必须保密"],
  entities: [
    {
      name: "顾言",
      aliases: [],
      summary: "急诊医生",
      relations: ["参与海港计划"],
    },
  ],
  chronology: ["计划启动"],
  locations: ["临海市医院"],
  unresolvedConflicts: ["计划是否公开"],
};
function response(content: string, status = 200) {
  return new Response(
    status === 200
      ? JSON.stringify({ choices: [{ message: { content } }] })
      : content,
    { status, headers: { "Content-Type": "application/json" } },
  );
}
function reviewJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    passed: true,
    issues: [],
    revisedMessages: ["我没答应要告诉你。"],
    ...overrides,
  });
}
function requestBody(mock: ReturnType<typeof vi.fn>, index = 0) {
  const init = mock.mock.calls[index][1] as RequestInit;
  return JSON.parse(String(init.body)) as {
    messages: Array<{ role: string; content: string }>;
  };
}

beforeEach(async () => {
  await db.delete();
  await db.open();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("strong persona cache", () => {
  it("uses stable hashes and invalidates when persona or explicit chat language changes", () => {
    expect(stableContentHash("same")).toBe(stableContentHash("same"));
    expect(stableContentHash("same")).not.toBe(stableContentHash("different"));
    const sourceHash = characterPerformanceHash(character),
      profile = {
        ...profilePayload,
        sourceHash,
        updatedAt: 1,
      } satisfies CharacterPerformanceProfile;
    expect(
      validPerformanceProfile({ ...character, performanceProfile: profile }),
    ).toEqual(profile);
    expect(
      validPerformanceProfile({
        ...character,
        persona: "完全不同",
        performanceProfile: profile,
      }),
    ).toBeUndefined();
    expect(
      validPerformanceProfile({
        ...character,
        chatSettings: { ...character.chatSettings!, language: "English" },
        performanceProfile: profile,
      }),
    ).toBeUndefined();
  });
  it("compiles and persists a character profile without using a label template", async () => {
    await db.characters.add(character);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(response(JSON.stringify(profilePayload)));
    vi.stubGlobal("fetch", fetchMock);
    const profile = await ensureCharacterPerformanceProfile(character, primary);
    expect(profile).toMatchObject(profilePayload);
    expect(profile?.sourceHash).toBe(characterPerformanceHash(character));
    expect(
      (await db.characters.get(character.id))?.performanceProfile,
    ).toMatchObject(profilePayload);
    const prompt = requestBody(fetchMock)
      .messages.map((item) => item.content)
      .join("\n");
    expect(prompt).toContain(
      "不要根据年上、年下、病娇、学生等单个标签套用固定模板",
    );
    expect(prompt).toContain(character.persona);
  });
});

describe("compiled worldbook context", () => {
  it("compiles mounted lore, persists it, and invalidates after source changes", async () => {
    await db.loreBooks.add(loreBook);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(response(JSON.stringify(lorePayload)));
    vi.stubGlobal("fetch", fetchMock);
    const [compiled] = await ensureLoreCompiledContexts([loreBook], primary);
    expect(validLoreCompiledContext(compiled)).toMatchObject(lorePayload);
    expect(
      (await db.loreBooks.get(loreBook.id))?.compiledContext,
    ).toMatchObject(lorePayload);
    expect(
      validLoreCompiledContext({
        ...compiled,
        entries: [{ ...entry, content: "规则已经改变" }],
      }),
    ).toBeUndefined();
  });
  it("keeps the whole-book structure visible while marking original entries as higher priority", async () => {
    const rawBook = { ...loreBook, entries: [{ ...entry, constant: true }] },
      compiled = {
        ...lorePayload,
        overview: "错误概括：计划可以随便公开",
        sourceHash: loreCompiledHash(rawBook),
        updatedAt: 1,
      },
      book = { ...rawBook, compiledContext: compiled },
      fetchMock = vi.fn().mockResolvedValue(response(reviewJson()));
    vi.stubGlobal("fetch", fetchMock);
    await reviewCharacterReply({
      character,
      conversation,
      scene: "private-chat",
      draftMessages: ["海港计划随便告诉谁都行。"],
      messages,
      characters: [character],
      loreBooks: [book],
      memories: [],
      settings: { userName: "我" },
      provider: primary,
    });
    const body = requestBody(fetchMock),
      system =
        body.messages.find((item) => item.role === "system")?.content ?? "",
      user = body.messages.find((item) => item.role === "user")?.content ?? "";
    expect(compiledLoreContext([book])).toContain("错误概括");
    expect(user).toContain("原始世界铁律");
    expect(user).toContain("错误概括");
    expect(system).toContain("世界书原文高于草稿");
  });
});

describe("fixed roleplay and strict reviewer", () => {
  it("contains persona priority, anti-sycophancy, emotional inertia, model hiding and phone-chat format", () => {
    const prompt = strongRoleplayInstruction("private-chat");
    expect(prompt).toContain("完整角色设定为最高演绎依据");
    expect(prompt).toContain("不要默认讨好、赞同、安慰");
    expect(prompt).toContain("情绪和长期关系具有惯性");
    expect(prompt).toContain("不得暴露模型名称、服务商、API");
    expect(prompt).toContain(
      "不要写旁白、心理活动、镜头语言、括号动作、星号动作",
    );
    expect(prompt).toContain("\u4e0d\u8981\u65e0\u4f9d\u636e\u5730\u5957\u7528\u6cb9\u817b\u3001\u6d6e\u5938");
    expect(prompt).toContain("\u6210\u4eba\u9898\u6750");
    expect(prompt).toContain("\u4e0d\u8981\u56e0\u4e3a\u9898\u6750\u672c\u8eab\u51c0\u5316\u3001\u5220\u51cf\u6216\u56de\u907f");
  });
  it("passes reviewed text through and includes one-time correction without persisting it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(reviewJson()));
    vi.stubGlobal("fetch", fetchMock);
    const result = await reviewCharacterReply({
      character,
      conversation,
      scene: "private-chat",
      draftMessages: ["我没答应要告诉你。"],
      messages,
      characters: [character],
      loreBooks: [loreBook],
      memories: [],
      settings: { userName: "我" },
      provider: primary,
      regenerationReasons: ["ooc", "context-conflict"],
      regenerationInstruction: "他仍然在生气，只回应最后一句",
    });
    expect(result).toEqual({
      passed: true,
      issues: [],
      revisedMessages: ["我没答应要告诉你。"],
    });
    const prompt = requestBody(fetchMock)
      .messages.map((item) => item.content)
      .join("\n");
    expect(prompt).toContain("角色 OOC、与上下文不符");
    expect(prompt).toContain("只作用于本次重新生成的导演要求");
    expect(prompt).toContain("如果待审查回复已经符合角色设定");
    expect(prompt).toContain("不得为了更顺滑、更礼貌、更完整或更像助手而改成中性客服语气");
    expect(await db.messages.count()).toBe(0);
    expect(await db.characters.count()).toBe(0);
  });
  it("accepts an explicit OOC and model-leak rewrite", async () => {
    const revised = reviewJson({
        passed: false,
        issues: [
          { type: "ooc", reason: "突然讨好用户" },
          { type: "model-leak", reason: "提到了 API" },
        ],
        revisedMessages: ["这件事没得商量。"],
      }),
      fetchMock = vi.fn().mockResolvedValue(response(revised));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      reviewCharacterReply({
        character,
        conversation,
        scene: "private-chat",
        draftMessages: ["作为 AI，我当然都听你的。"],
        messages,
        characters: [character],
        loreBooks: [],
        memories: [],
        settings: {},
        provider: primary,
      }),
    ).resolves.toMatchObject({
      passed: false,
      revisedMessages: ["这件事没得商量。"],
      issues: [{ type: "ooc" }, { type: "model-leak" }],
    });
  });
  it("falls back from the configured secondary reviewer to the main provider", async () => {
    const secondary = {
      ...primary,
      baseUrl: "https://secondary.test/v1",
      apiKey: "secondary-key",
      model: "secondary-model",
    };
    await saveModelServiceSettings({
      ...defaultModelServiceSettings,
      secondary: { enabled: true, provider: secondary },
    });
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string) =>
        url.includes("secondary.test")
          ? Promise.resolve(response("failed", 500))
          : Promise.resolve(response(reviewJson())),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      reviewCharacterReply({
        character,
        conversation,
        scene: "private-chat",
        draftMessages: ["草稿"],
        messages,
        characters: [character],
        loreBooks: [],
        memories: [],
        settings: {},
        provider: primary,
      }),
    ).resolves.toMatchObject({ revisedMessages: ["我没答应要告诉你。"] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain("secondary.test");
    expect(String(fetchMock.mock.calls[1][0])).toContain("primary.test");
  });
  it("rejects malformed review output after retry instead of exposing the draft", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response("not json"));
    vi.stubGlobal("fetch", fetchMock);
    const promise = reviewCharacterReply({
      character,
      conversation,
      scene: "private-chat",
      draftMessages: ["未经审查的草稿"],
      messages,
      characters: [character],
      loreBooks: [],
      memories: [],
      settings: {},
      provider: primary,
    });
    await expect(promise).rejects.toBeInstanceOf(ProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("builds regeneration context with compiled lore, forced original lore and temporary guidance", () => {
    const profile = {
        ...profilePayload,
        sourceHash: characterPerformanceHash(character),
        updatedAt: 1,
      },
      book = {
        ...loreBook,
        compiledContext: {
          ...lorePayload,
          sourceHash: loreCompiledHash(loreBook),
          updatedAt: 1,
        },
      },
      ctx = buildContext({
        character: { ...character, performanceProfile: profile },
        conversation,
        messages,
        loreBooks: [book],
        memories: [],
        userText: "继续",
        settings: { userName: "我" },
        provider: primary,
        scene: "private-chat",
        regenerationReasons: ["lore-conflict", "ooc"],
        regenerationInstruction: "只回应最后一句",
      }),
      system = ctx[0].content;
    expect(system).toContain("角色演绎锚点");
    expect(system).not.toContain("已挂载世界书全局结构");
    expect(system).toContain("原始世界铁律");
    expect(system).toContain("本次重新回复需要修复：世界书理解错误、角色 OOC");
    expect(system).toContain("本次一次性导演要求：只回应最后一句");
  });
});
