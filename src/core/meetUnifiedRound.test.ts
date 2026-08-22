import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "./db";
import { OpenAIProvider, ProviderError } from "./provider";
import {
  generateMeetTurn,
  getPendingMeetSave,
  regenerateMeetRound,
  retryPendingMeetSave,
} from "./meetService";
import {
  defaultModelServiceSettings,
  defaultProvider,
  type Character,
  type MeetSession,
} from "./types";

function character(id: string, name: string): Character {
  return {
    id,
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    name,
    avatar: "",
    bio: `${name}的简介`,
    personality: `${name}冷静而主动`,
    speakingStyle: `${name}说话简洁`,
    background: `${name}的背景`,
    language: "中文",
    proactive: {
      messages: false,
      timeAware: false,
      frequency: "medium",
      quietStart: "23:00",
      quietEnd: "08:00",
      catchupLimit: 3,
      dailyLimit: 10,
    },
    memoryExtractionSettings: {
      enabled: false,
      mode: "auto",
      chatThreshold: 50,
      maxMemoriesPerBatch: 8,
      includeSummary: true,
      autoSaveHighConfidence: true,
      meetMemoryEnabled: false,
    },
    relationship: {
      intimacy: 10,
      trust: 10,
      mood: "平静",
      recentEvents: [],
    },
    lastActiveAt: 1,
  };
}

function session(ids: string[], range = { minChars: 80, maxChars: 300 }): MeetSession {
  return {
    id: "meet-unified",
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    participantIds: ids,
    initiator: "user",
    scene: { opening: "大家在客厅见面", location: "客厅" },
    suggestionsEnabled: true,
    narrativeSettings: {
      version: 3,
      ...range,
      thoughtsEnabled: true,
      perspective: "third",
      styleMode: "plain",
      customStyle: "",
    },
    status: "active",
    entries: [],
    startedAt: 1,
    lastActivityAt: 1,
  };
}

function response(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return {
    text,
    finishReason: "stop",
    truncated: false,
    responseShape: "choices",
    rawLength: text.length,
    outputTokens: 160,
  };
}

function validRound(segments?: unknown[]) {
  return {
    version: 1,
    segments:
      segments ?? [
        { type: "narration", text: "灯光落在桌面上。" + "环境".repeat(42) },
        { type: "dialogue", characterId: "one", text: "先坐下慢慢说。" },
      ],
    thoughts: [{ characterId: "one", text: "我想先确认他的意思。" }],
    suggestions: ["继续说下去"],
  };
}

async function setup(ids = ["one", "two", "silent"], range?: { minChars: number; maxChars: number }) {
  await db.delete();
  await db.open();
  await db.characters.bulkAdd(ids.map((id) => character(id, id.toUpperCase())));
  await db.meetSessions.add(session(ids, range));
  await db.settings.put({
    key: "provider",
    value: { ...defaultProvider, networkMode: "direct" as const, apiKey: "test-key", model: "test-model" },
  });
}

async function configureSecondary(overrides: Partial<typeof defaultProvider> = {}) {
  await db.settings.put({
    key: "model-services-v1",
    value: {
      ...defaultModelServiceSettings,
      secondary: {
        enabled: true,
        provider: {
          ...defaultProvider, networkMode: "direct" as const,
          baseUrl: "https://secondary.example/v1",
          apiKey: "secondary-key",
          model: "secondary-model",
          ...overrides,
        },
      },
    },
  });
}

function rateFailure(retryAfterSeconds = 30) {
  return new ProviderError("rate", "调用频率或额度已达上限", "", {
    source: "api",
    kind: "rate",
    httpStatus: 429,
    retryAfterSeconds,
    providerCode: "bad_response_status_code",
    meaning: "调用频率或额度已达上限",
    detail: "rate limited",
  } as any);
}
function corsFailure() {
  return new ProviderError("cors", "浏览器无法访问", "", { kind: "cors", providerCode: "cors_or_fetch_failed", detail: "Failed to fetch" } as any);
}
function blockedFailure() {
  return new ProviderError("format", "内容被拦截", "", { kind: "format", providerCode: "prompt_blocked", detail: "blocked" } as any);
}

describe("unified meet round generation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("uses one request for shared narration, ordered dialogue, repeated speakers and silent participants", async () => {
    await setup();
    await db.loreBooks.add({
      id: "shared-lore",
      schemaVersion: 1,
      createdAt: 1,
      updatedAt: 1,
      name: "共同设定",
      description: "",
      enabled: true,
      mount: { mode: "global", characterIds: [], conversationIds: [] },
      entries: [
        {
          id: "shared-entry",
          title: "灯",
          content: "唯一世界书内容：客厅的灯会轻微闪烁。",
          keywords: [],
          priority: 10,
          enabled: true,
          scope: { type: "global" },
        },
      ],
    } as any);
    const payload = validRound([
      { type: "narration", text: "窗外下着雨。" + "环境".repeat(42) },
      { type: "dialogue", characterId: "one", text: "你先说。" },
      { type: "narration", text: "TWO把杯子放到桌上。" },
      { type: "dialogue", characterId: "two", text: "我也在听。" },
      { type: "dialogue", characterId: "one", text: "那就一起聊。" },
    ]);
    const chat = vi
      .spyOn(OpenAIProvider.prototype, "chatWithMeta")
      .mockResolvedValue(response(payload));

    const result = await generateMeetTurn("meet-unified", "今天想和你们谈谈");
    expect(chat).toHaveBeenCalledTimes(1);
    const prompt = chat.mock.calls[0][0].map((item) => item.content).join("\n");
    expect(prompt).toContain("[one] ONE");
    expect(prompt).toContain("[two] TWO");
    expect(prompt).toContain("[silent] SILENT");
    expect(prompt.match(/唯一世界书内容/g)).toHaveLength(1);
    expect(result.entries.map((entry) => entry.senderType)).toEqual([
      "system",
      "character",
      "system",
      "character",
      "character",
    ]);
    expect(result.entries.map((entry) => entry.senderId).filter(Boolean)).toEqual([
      "one",
      "two",
      "one",
    ]);
    expect(new Set(result.entries.map((entry) => entry.id)).size).toBe(5);
    const saved = await db.meetSessions.get("meet-unified"),
      user = saved?.entries.find((entry) => entry.senderType === "user");
    expect(user?.generation).toMatchObject({
      protocol: "unified-round-v1",
      status: "complete",
      stage: "saving",
      saveResult: "saved",
      injectedLoreEntries: 1,
      characterResults: [
        { characterId: "one", status: "complete", attempts: 1 },
        { characterId: "two", status: "complete", attempts: 1 },
        { characterId: "silent", status: "silent", attempts: 1 },
      ],
    });
  });

  it("saves plain visible text without a second Provider request", async () => {
    await setup(["one"]);
    const chat = vi.spyOn(OpenAIProvider.prototype, "chatWithMeta").mockResolvedValue(response("ordinary text"));
    const result = await generateMeetTurn("meet-unified", "继续");
    expect(chat).toHaveBeenCalledTimes(1);
    expect(result.entries).toMatchObject([{ senderType: "system", narration: "ordinary text" }]);
    const user = (await db.meetSessions.get("meet-unified"))?.entries.find((entry) => entry.senderType === "user");
    expect(user?.generation).toMatchObject({ status: "complete", meetParseMode: "plain-visible-text", visibleContentAccepted: true, saveResult: "saved" });
  });
  it("keeps narration-only visible content and warns instead of rejecting", async () => {
    await setup(["one"]);
    const chat = vi.spyOn(OpenAIProvider.prototype, "chatWithMeta").mockResolvedValue(response("ordinary text"));
    const result = await generateMeetTurn("meet-unified", "继续");
    expect(chat).toHaveBeenCalledTimes(1);
    expect(result.warning).toContain("没有可确认说话人的台词");
    const saved = await db.meetSessions.get("meet-unified");
    expect(saved?.entries.some((entry) => entry.narration === "ordinary text")).toBe(true);
  });
  it("saves a valid round with a length warning", async () => {
    await setup(["one"], { minChars: 100, maxChars: 120 });
    const slight = validRound([
        { type: "narration", text: "景".repeat(84) },
        { type: "dialogue", characterId: "one", text: "我们继续说。" },
      ]),
      chat = vi
        .spyOn(OpenAIProvider.prototype, "chatWithMeta")
        .mockResolvedValueOnce(response(slight));
    const result = await generateMeetTurn("meet-unified", "继续");
    expect(chat).toHaveBeenCalledTimes(1);
    expect(result.warning).toContain("偏离");
    expect(result.warning).toContain("已保留完整场景");
    expect(
      (await db.meetSessions.get("meet-unified"))?.entries.some(
        (entry) => entry.dialogue === "我们继续说。",
      ),
    ).toBe(true);
  });
  it("ignores invalid optional thoughts and updates without rolling back visible segments", async () => {
    await setup(["one"]);
    const payload = {
      ...validRound(),
      thoughts: [{ characterId: "ghost", text: "无效思想" }],
      updates: [{ characterId: "ghost", scenePatch: {} }],
    };
    vi.spyOn(OpenAIProvider.prototype, "chatWithMeta").mockResolvedValue(
      response(payload),
    );
    const result = await generateMeetTurn("meet-unified", "继续");
    expect(result.entries.some((entry) => entry.dialogue)).toBe(true);
    expect(result.warning).toContain("已忽略");
  });

  it("retries local persistence once without another model request", async () => {
    await setup(["one"]);
    const chat = vi
      .spyOn(OpenAIProvider.prototype, "chatWithMeta")
      .mockResolvedValue(response(validRound())),
      originalPut = db.meetSessions.put.bind(db.meetSessions);
    let putCalls = 0;
    vi.spyOn(db.meetSessions, "put").mockImplementation((async (value: any) => {
      putCalls += 1;
      if (putCalls === 2) throw new Error("temporary save failure");
      return originalPut(value);
    }) as any);
    await generateMeetTurn("meet-unified", "继续");
    expect(chat).toHaveBeenCalledTimes(1);
    expect(putCalls).toBe(3);
    const user = (await db.meetSessions.get("meet-unified"))?.entries.find(
      (entry) => entry.senderType === "user",
    );
    expect(user?.generation?.saveResult).toBe("saved");
  });

  it("reports saving only after two real persistence failures", async () => {
    await setup(["one"]);
    const chat = vi
      .spyOn(OpenAIProvider.prototype, "chatWithMeta")
      .mockResolvedValue(response(validRound())),
      originalPut = db.meetSessions.put.bind(db.meetSessions);
    let putCalls = 0;
    const putSpy = vi.spyOn(db.meetSessions, "put").mockImplementation((async (value: any) => {
      putCalls += 1;
      if (putCalls >= 2) throw new Error("persistent save failure");
      return originalPut(value);
    }) as any);
    await expect(generateMeetTurn("meet-unified", "继续")).rejects.toThrow(
      "本地保存失败",
    );
    expect(chat).toHaveBeenCalledTimes(1);
    expect(putCalls).toBe(4);
    const user = (await db.meetSessions.get("meet-unified"))?.entries.find(
      (entry) => entry.senderType === "user",
    );
    expect(user?.generation).toMatchObject({
      status: "failed",
      stage: "saving",
      saveResult: "failed",
      pendingSave: true,
      recoveryAction: "retry-save",
    });
    expect(getPendingMeetSave("meet-unified", user!.id)).toBeDefined();
    putSpy.mockRestore();
    await retryPendingMeetSave("meet-unified", user!.id);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(getPendingMeetSave("meet-unified", user!.id)).toBeUndefined();
    expect((await db.meetSessions.get("meet-unified"))?.entries.some((entry) => entry.dialogue === "先坐下慢慢说。")).toBe(true);
  });

  it("regenerates a unified round in place with deterministic ids and no duplicates", async () => {
    await setup(["one"]);
    const chat = vi
      .spyOn(OpenAIProvider.prototype, "chatWithMeta")
      .mockResolvedValue(response(validRound()));
    await generateMeetTurn("meet-unified", "继续");
    const first = await db.meetSessions.get("meet-unified"),
      user = first!.entries.find((entry) => entry.senderType === "user")!,
      firstIds = first!.entries
        .filter((entry) => entry.roundId === user.roundId && entry.senderType !== "user")
        .map((entry) => entry.id);
    chat.mockResolvedValue(
      response(
        validRound([
          { type: "narration", text: "新的场景。" + "环境".repeat(42) },
          { type: "dialogue", characterId: "one", text: "这是新的台词。" },
        ]),
      ),
    );
    await regenerateMeetRound("meet-unified", user.roundId);
    const second = await db.meetSessions.get("meet-unified"),
      outputs = second!.entries.filter(
        (entry) => entry.roundId === user.roundId && entry.senderType !== "user",
      );
    expect(outputs.map((entry) => entry.id)).toEqual(firstIds);
    expect(new Set(outputs.map((entry) => entry.id)).size).toBe(outputs.length);
    expect(outputs.some((entry) => entry.dialogue === "这是新的台词。")).toBe(true);
  });
  it("ignores a late stale run and keeps the newer unified round", async () => {
    await setup(["one"]);
    const chat = vi
      .spyOn(OpenAIProvider.prototype, "chatWithMeta")
      .mockResolvedValue(response(validRound()));
    await generateMeetTurn("meet-unified", "继续");
    const first = await db.meetSessions.get("meet-unified"),
      user = first!.entries.find((entry) => entry.senderType === "user")!;
    let releaseOld!: (value: ReturnType<typeof response>) => void;
    const oldResponse = new Promise<ReturnType<typeof response>>((resolve) => {
      releaseOld = resolve;
    });
    let regenerationCall = 0;
    chat.mockImplementation(async () => {
      regenerationCall += 1;
      if (regenerationCall === 1) return oldResponse;
      return response(
        validRound([
          { type: "narration", text: "较新的场景。" + "环境".repeat(42) },
          { type: "dialogue", characterId: "one", text: "保留较新的结果。" },
        ]),
      );
    });
    const stale = regenerateMeetRound("meet-unified", user.roundId);
    await vi.waitFor(() => expect(regenerationCall).toBe(1));
    await regenerateMeetRound("meet-unified", user.roundId);
    releaseOld(
      response(
        validRound([
          { type: "narration", text: "迟到的旧场景。" + "环境".repeat(42) },
          { type: "dialogue", characterId: "one", text: "不应覆盖。" },
        ]),
      ),
    );
    await expect(stale).rejects.toThrow("新的重新生成替代");
    const saved = await db.meetSessions.get("meet-unified"),
      outputs = saved!.entries.filter(
        (entry) => entry.roundId === user.roundId && entry.senderType !== "user",
      );
    expect(outputs.some((entry) => entry.dialogue === "保留较新的结果。")).toBe(true);
    expect(outputs.some((entry) => entry.dialogue === "不应覆盖。")).toBe(false);
    expect(new Set(outputs.map((entry) => entry.id)).size).toBe(outputs.length);
  });
  it("uses a distinct configured secondary provider after a primary rate limit", async () => {
    await setup(["one"]);
    await configureSecondary();
    const usedModels: string[] = [];
    const chat = vi.spyOn(OpenAIProvider.prototype, "chatWithMeta").mockImplementation(
      async function (this: any) {
        const model = (this as any).settings.model as string;
        usedModels.push(model);
        if (model === "test-model") throw rateFailure(45);
        return response(validRound());
      },
    );

    const result = await generateMeetTurn("meet-unified", "继续");
    expect(chat).toHaveBeenCalledTimes(2);
    expect(usedModels).toEqual(["test-model", "secondary-model"]);
    expect(result.warning).toContain("已使用副 API 完成本轮场景");
    const saved = await db.meetSessions.get("meet-unified"),
      user = saved?.entries.find((entry) => entry.senderType === "user");
    expect(user?.generation).toMatchObject({
      status: "complete",
      saveResult: "saved",
      model: "secondary-model",
      fallbackUsed: true,
      attempts: [
        { ordinal: 1, providerRole: "primary", errorKind: "rate", httpStatus: 429, retryAfterSeconds: 45 },
        { ordinal: 2, providerRole: "secondary-fallback", model: "secondary-model" },
      ],
    });
  });

  it("does not repeat a rate-limited primary request when no secondary is available", async () => {
    await setup(["one"]);
    const chat = vi.spyOn(OpenAIProvider.prototype, "chatWithMeta").mockRejectedValue(rateFailure(20));
    await expect(generateMeetTurn("meet-unified", "继续")).rejects.toThrow(
      "当前模型暂时达到调用频率或额度限制",
    );
    expect(chat).toHaveBeenCalledTimes(1);
    const user = (await db.meetSessions.get("meet-unified"))?.entries.find(
      (entry) => entry.senderType === "user",
    );
    expect(user?.generation).toMatchObject({
      status: "failed",
      stage: "requesting",
      saveResult: "not-attempted",
      attempts: [{ ordinal: 1, providerRole: "primary", errorKind: "rate", httpStatus: 429 }],
    });
  });

  it("does not treat an identical secondary provider as a fallback", async () => {
    await setup(["one"]);
    await configureSecondary({ baseUrl: defaultProvider.baseUrl, apiKey: "test-key", model: "test-model" });
    const chat = vi.spyOn(OpenAIProvider.prototype, "chatWithMeta").mockRejectedValue(rateFailure());
    await expect(generateMeetTurn("meet-unified", "继续")).rejects.toThrow(
      "当前模型暂时达到调用频率或额度限制",
    );
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("stops after both providers are rate limited without entering saving", async () => {
    await setup(["one"]);
    await configureSecondary();
    const chat = vi.spyOn(OpenAIProvider.prototype, "chatWithMeta")
      .mockRejectedValueOnce(rateFailure(10))
      .mockRejectedValueOnce(rateFailure(60));
    await expect(generateMeetTurn("meet-unified", "继续")).rejects.toThrow(
      "主 API 和副 API 均达到调用频率或额度限制",
    );
    expect(chat).toHaveBeenCalledTimes(2);
    const saved = await db.meetSessions.get("meet-unified"),
      user = saved?.entries.find((entry) => entry.senderType === "user");
    expect(saved?.entries.filter((entry) => entry.senderType !== "user")).toEqual([]);
    expect(user?.generation).toMatchObject({
      status: "failed",
      stage: "requesting",
      saveResult: "not-attempted",
      fallbackUsed: true,
      attempts: [
        { providerRole: "primary", retryAfterSeconds: 10 },
        { providerRole: "secondary-fallback", retryAfterSeconds: 60 },
      ],
    });
  });

  it("distinguishes a non-rate secondary failure after primary rate limiting", async () => {
    await setup(["one"]);
    await configureSecondary();
    const secondaryFailure = new ProviderError("server", "服务暂时不可用", "", {
      source: "api",
      kind: "server",
      httpStatus: 503,
      providerCode: "bad_response_status_code",
      meaning: "服务暂时不可用",
      detail: "server failure",
    } as any);
    vi.spyOn(OpenAIProvider.prototype, "chatWithMeta")
      .mockRejectedValueOnce(rateFailure())
      .mockRejectedValueOnce(secondaryFailure);
    await expect(generateMeetTurn("meet-unified", "继续")).rejects.toThrow(
      "主 API 当前受限，副 API 也未完成本轮生成",
    );
  });
  it("retains provider response metadata for failed transport parsing", async () => {
    await setup(["one"]);
    const failure = new ProviderError(
      "format",
      "响应截断",
      "",
      {
        kind: "format",
        title: "响应格式异常",
        userMessage: "响应截断",
        retryable: true,
        providerCode: "transport_truncated",
        responseShape: "transport-truncated",
        rawLength: 321,
        finishReason: "length",
        transportMarkedIncomplete: true,
        failureStage: "provider-parse",
      } as any,
    );
    const chat = vi
      .spyOn(OpenAIProvider.prototype, "chatWithMeta")
      .mockRejectedValue(failure);
    await expect(generateMeetTurn("meet-unified", "继续")).rejects.toThrow(
      "响应截断",
    );
    expect(chat).toHaveBeenCalledTimes(2);
    const user = (await db.meetSessions.get("meet-unified"))?.entries.find(
      (entry) => entry.senderType === "user",
    );
    expect(user?.generation).toMatchObject({
      stage: "parsing",
      responseShape: "transport-truncated",
      rawLength: 321,
      finishReason: "length",
      truncated: true,
      saveResult: "not-attempted",
    });
    expect(user?.generation?.attempts?.[0]).toMatchObject({
      stage: "parsing",
      responseShape: "transport-truncated",
      rawLength: 321,
      providerCode: "transport_truncated",
    });
  });
});


describe("meet production error closure regressions", () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  it("does not automatically replay a direct CORS failure through the secondary Provider", async () => {
    await setup(["one"]);
    await configureSecondary();
    const models: string[] = [];
    const chat = vi.spyOn(OpenAIProvider.prototype, "chatWithMeta").mockImplementation(async function (this: any) {
      models.push((this as any).settings.model);
      throw corsFailure();
    });
    await expect(generateMeetTurn("meet-unified", "继续")).rejects.toThrow("CORS");
    expect(chat).toHaveBeenCalledTimes(1);
    expect(models).toEqual(["test-model"]);
    const user = (await db.meetSessions.get("meet-unified"))?.entries.find((entry) => entry.senderType === "user");
    expect(user?.generation).toMatchObject({ retryDecision: "stop-unsafe-retry", recoveryAction: "switch-to-relay", sameProviderRetryPrevented: true, attempts: [{ providerRole: "primary", errorKind: "cors" }] });
  });
  it("stops after prompt blocking when no distinct secondary exists", async () => {
    await setup(["one"]);
    const chat = vi.spyOn(OpenAIProvider.prototype, "chatWithMeta").mockRejectedValue(blockedFailure());
    await expect(generateMeetTurn("meet-unified", "继续")).rejects.toThrow("安全策略拦截");
    expect(chat).toHaveBeenCalledTimes(1);
    const user = (await db.meetSessions.get("meet-unified"))?.entries.find((entry) => entry.senderType === "user");
    expect(user?.generation).toMatchObject({ failureClass: "provider-prompt-blocked", retryDecision: "stop-no-distinct-secondary", sameProviderRetryPrevented: true, saveResult: "not-attempted" });
  });

  it("keeps a narration-only structured round without retrying", async () => {
    await setup(["one"]);
    const visible = { version: 1, segments: [{ type: "narration", text: "only narration" }], debug: "must not be copied" };
    const chat = vi.spyOn(OpenAIProvider.prototype, "chatWithMeta").mockResolvedValue(response(visible));
    const result = await generateMeetTurn("meet-unified", "继续");
    expect(chat).toHaveBeenCalledTimes(1);
    expect(result.entries).toMatchObject([{ senderType: "system", narration: "only narration" }]);
    expect(result.warning).toContain("没有可确认说话人的台词");
  });
});

describe("meet end-to-end recovery invariants", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("preserves the user entry and sends zero requests while explicitly offline", async () => {
    await setup(["one"]);
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "onLine");
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    const chat = vi.spyOn(OpenAIProvider.prototype, "chatWithMeta");
    try {
      await expect(generateMeetTurn("meet-unified", "离线输入仍需保留")).rejects.toThrow("网络不可用");
      expect(chat).not.toHaveBeenCalled();
      const user = (await db.meetSessions.get("meet-unified"))?.entries.find((entry) => entry.senderType === "user");
      expect(user).toMatchObject({ content: "离线输入仍需保留", generation: { stage: "waiting-network", failureClass: "network-offline", requestDeliveryState: "not-sent", recoveryAction: "retry-generation" } });
    } finally {
      if (descriptor) Object.defineProperty(navigator, "onLine", descriptor);
      else Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    }
  });

  it("does not automatically retry a possibly delivered network failure", async () => {
    await setup(["one"]);
    await configureSecondary();
    const failure = new ProviderError("network", "网络在请求过程中断开", "", { source: "api", kind: "network", providerCode: "network-unknown-delivery", meaning: "网络中断" } as any);
    const chat = vi.spyOn(OpenAIProvider.prototype, "chatWithMeta").mockRejectedValue(failure);
    await expect(generateMeetTurn("meet-unified", "继续")).rejects.toThrow("网络在请求过程中断开");
    expect(chat).toHaveBeenCalledTimes(1);
    const user = (await db.meetSessions.get("meet-unified"))?.entries.find((entry) => entry.senderType === "user");
    expect(user?.generation).toMatchObject({ failureClass: "network-unknown-delivery", requestDeliveryState: "possibly-sent", retryDecision: "stop-unsafe-retry", sameProviderRetryPrevented: true });
  });

  it("performs exactly one compact retry for an empty successful response", async () => {
    await setup(["one"]);
    const empty = new ProviderError("format", "服务返回了空响应", "", { source: "api", kind: "format", providerCode: "empty_response", meaning: "空响应", responseShape: "empty", rawLength: 0, failureStage: "provider-parse" } as any);
    const chat = vi.spyOn(OpenAIProvider.prototype, "chatWithMeta").mockRejectedValueOnce(empty).mockResolvedValueOnce(response(validRound()));
    await generateMeetTurn("meet-unified", "继续");
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls[1][0].map((message) => message.content).join("\n")).toContain("[N]");
  });

  it("stops invalid Relay activation without claiming Provider delivery", async () => {
    await setup(["one"]);
    const failure = new ProviderError("relay", "Relay activation license is invalid", "", { source: "api", kind: "relay", providerCode: "relay-activation-invalid", relayErrorCode: "relay-activation-invalid", networkMode: "relay", relayUsed: true, meaning: "激活许可无效" } as any);
    const chat = vi.spyOn(OpenAIProvider.prototype, "chatWithMeta").mockRejectedValue(failure);
    await expect(generateMeetTurn("meet-unified", "继续")).rejects.toThrow("activation license is invalid");
    expect(chat).toHaveBeenCalledTimes(1);
    const user = (await db.meetSessions.get("meet-unified"))?.entries.find((entry) => entry.senderType === "user");
    expect(user?.generation).toMatchObject({ stage: "preflight", failureClass: "relay-activation-invalid", requestDeliveryState: "not-sent", recoveryAction: "check-activation", retryDecision: "stop-unsafe-retry" });
  });

  it("marks user cancellation without fallback or automatic retry", async () => {
    await setup(["one"]);
    const chat = vi.spyOn(OpenAIProvider.prototype, "chatWithMeta").mockImplementation((_messages, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new ProviderError("aborted", "生成已停止", "")), { once: true });
    }));
    const controller = new AbortController();
    const promise = generateMeetTurn("meet-unified", "继续", controller.signal);
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(promise).rejects.toMatchObject({ kind: "aborted" });
    const user = (await db.meetSessions.get("meet-unified"))?.entries.find((entry) => entry.senderType === "user");
    expect(user?.generation).toMatchObject({ status: "cancelled", failureClass: "aborted", recoveryAction: "retry-generation", retryDecision: "stop-unsafe-retry" });
  });

  it("requires an explicit save action for complete fragments from a twice-truncated response", async () => {
    await setup(["one"]);
    const partial = "[N] 完整旁白。\n[D:one] 完整台词。\n[D:one] 未完成";
    const truncated = { ...response(partial), finishReason: "length", truncated: true };
    const chat = vi.spyOn(OpenAIProvider.prototype, "chatWithMeta").mockResolvedValue(truncated);
    await expect(generateMeetTurn("meet-unified", "继续")).rejects.toThrow("截断");
    expect(chat).toHaveBeenCalledTimes(2);
    const before = await db.meetSessions.get("meet-unified");
    const user = before?.entries.find((entry) => entry.senderType === "user");
    expect(before?.entries.filter((entry) => entry.senderType !== "user")).toEqual([]);
    expect(user?.generation).toMatchObject({ failureClass: "response-truncated", recoveryAction: "keep-complete-segments", pendingSave: true });
    await retryPendingMeetSave("meet-unified", user!.id);
    const visible = (await db.meetSessions.get("meet-unified"))!.entries.filter((entry) => entry.senderType !== "user").map((entry) => entry.narration ?? entry.dialogue).join("\n");
    expect(visible).toContain("完整旁白");
    expect(visible).toContain("完整台词");
    expect(visible).not.toContain("未完成");
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("shows direct Provider HTTP status in the meet failure", async () => {
    await setup(["one"]);
    const failure = new ProviderError("auth", "provider auth failed", "", { kind: "auth", httpStatus: 401, providerCode: "bad_response_status_code" } as any);
    const chat = vi.spyOn(OpenAIProvider.prototype, "chatWithMeta").mockRejectedValue(failure);
    await expect(generateMeetTurn("meet-unified", "retry")).rejects.toThrow("Provider HTTP 401");
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("shows Relay HTTP status and preserves the upstream failure class", async () => {
    await setup(["one"]);
    const failure = new ProviderError("relay", "relay unavailable", "", { kind: "relay", httpStatus: 502, relayStatus: 502, relayUsed: true, relayErrorCode: "relay-unavailable", upstreamHttpStatus: 0 } as any);
    const chat = vi.spyOn(OpenAIProvider.prototype, "chatWithMeta").mockRejectedValue(failure);
    await expect(generateMeetTurn("meet-unified", "retry")).rejects.toThrow("Relay HTTP 502");
    expect(chat).toHaveBeenCalledTimes(1);
    const user = (await db.meetSessions.get("meet-unified"))?.entries.find((entry) => entry.senderType === "user");
    expect(user?.generation).toMatchObject({ failureClass: "relay-upstream-unavailable", relayStatus: 502, relayErrorCode: "relay-unavailable" });
  });
});
