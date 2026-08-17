import { afterEach, describe, expect, it, vi } from "vitest";
import { generateCharacterReplyTurn } from "./groupChat";
import { createApiErrorInfo, OpenAIProvider, ProviderError, type ProviderChatInvoker } from "./provider";
import { defaultProvider, type Character } from "./types";

const character = {
  id: "character-1",
  name: "角色",
  createdAt: 1,
  updatedAt: 1,
  schemaVersion: 1,
  settings: "",
  chatSettings: {
    language: "zh-CN",
    contextLimit: 20,
    stream: false,
    replyMessageRangeMode: "adaptive",
  },
} as unknown as Character;

const voice = {
  sections: {
    physicalState: "呼吸平稳",
    emotionAndMind: "我在认真思考",
    unspokenWords: "还有话没有说出口",
    selfDeception: "我假装自己并不紧张",
    triggeredMemory: "此刻没有被触发的具体回忆",
    angelThought: "先尊重对方的感受",
    devilThought: "想更直接地表达自己",
  },
  continuity: { emotion: "专注" },
};

function result(text: string) {
  return {
    text,
    truncated: false,
    responseShape: "direct-role-json",
    rawLength: text.length,
    parseStatus: "strict-json" as const,
    strictParseSucceeded: true,
    repairAttempted: false,
    repairedParseSucceeded: false,
    outerContainerClosed: true,
    unterminatedString: false,
    hasMessages: true,
    hasInnerVoice: true,
  };
}

describe("generateCharacterReplyTurn strict retry", () => {
  afterEach(() => vi.restoreAllMocks());

  it("retries once for an incomplete role protocol and then succeeds", async () => {
    const chat = vi.spyOn(OpenAIProvider.prototype, "chatWithMeta")
      .mockResolvedValueOnce(result(JSON.stringify({ messages: [{ content: "只有正文" }] })))
      .mockResolvedValueOnce(result(JSON.stringify({ messages: [{ content: "完整回复" }], innerVoice: voice })));
    const turn = await generateCharacterReplyTurn(
      { ...defaultProvider, apiKey: "test", stream: false },
      [{ role: "user", content: "你好" }],
      character,
      false,
      "private",
      true,
    );
    expect(chat).toHaveBeenCalledTimes(2);
    expect(turn.parts[0].content).toBe("完整回复");
    expect(turn.innerVoice?.continuity.emotion).toBe("专注");
  });

  it("makes exactly two calls and preserves missing_inner_voice diagnostics", async () => {
    const incomplete = result(JSON.stringify({ messages: [{ content: "只有正文" }] }));
    const chat = vi.spyOn(OpenAIProvider.prototype, "chatWithMeta")
      .mockResolvedValueOnce(incomplete)
      .mockResolvedValueOnce(incomplete);
    const error = await generateCharacterReplyTurn(
      { ...defaultProvider, apiKey: "test", stream: false },
      [{ role: "user", content: "你好" }],
      character,
      false,
      "private",
      true,
    ).catch((value) => value) as ProviderError;
    expect(chat).toHaveBeenCalledTimes(2);
    expect(error.apiError).toMatchObject({ providerCode: "missing_inner_voice", failureStage: "inner-voice" });
  });

  it("accepts a complete repaired role protocol even when the relay reports finish_reason length", async () => {
    const malformed = `{messages:[{content:"完整回复",}],innerVoice:{sections:{physicalState:"呼吸平稳",emotionAndMind:"我在认真思考",unspokenWords:"还有话没有说出口",selfDeception:"我假装自己并不紧张",triggeredMemory:"此刻没有被触发的具体回忆",angelThought:"先尊重对方的感受",devilThought:"想更直接地表达自己"},continuity:{emotion:"专注"}},}`;
    const response = {
      ...result(malformed),
      truncated: true,
      finishReason: "length",
      responseShape: "choices",
      rawLength: 3011,
      parseStatus: "repaired-json" as const,
      strictParseSucceeded: false,
      repairAttempted: true,
      repairedParseSucceeded: true,
      outerContainerClosed: false,
      unterminatedString: false,
    };
    const chat = vi.spyOn(OpenAIProvider.prototype, "chatWithMeta").mockResolvedValueOnce(response);
    const turn = await generateCharacterReplyTurn(
      { ...defaultProvider, apiKey: "test", stream: false },
      [{ role: "user", content: "你好" }],
      character,
      false,
      "private",
      true,
    );
    expect(chat).toHaveBeenCalledTimes(1);
    expect(turn.parts[0].content).toBe("完整回复");
    expect(turn.innerVoice?.continuity.emotion).toBe("专注");
  });;
  it("switches only the truncation retry to compact buffered streaming", async () => {
    const calls: Array<{ stream?: boolean; purpose: string; prompt: string; settingStream: boolean }> = [];
    const invoke: ProviderChatInvoker = async (providerSettings, messages, options, purpose) => {
      calls.push({
        stream: options.stream,
        purpose,
        prompt: messages.at(-1)?.content ?? "",
        settingStream: providerSettings.stream,
      });
      if (calls.length === 1)
        throw new ProviderError(
          "format",
          "truncated",
          "",
          createApiErrorInfo("format", {
            providerCode: "truncated_json",
            responseShape: "truncated-json",
            failureStage: "provider-parse",
          }),
        );
      return result(JSON.stringify({ messages: [{ content: "完整回复" }], innerVoice: voice }));
    };
    const turn = await generateCharacterReplyTurn(
      { ...defaultProvider, apiKey: "test", stream: false },
      [{ role: "system", content: "core persona" }, { role: "user", content: "最新用户消息" }],
      character,
      false,
      "private",
      true,
      undefined,
      false,
      false,
      [],
      undefined,
      invoke,
    );
    expect(turn.parts[0]?.content).toBe("完整回复");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ stream: false, settingStream: false, purpose: "generation" });
    expect(calls[1]).toMatchObject({ stream: true, settingStream: true, purpose: "regeneration" });
    expect(calls[1]?.prompt).toContain("single-line minified JSON");
    expect(calls[1]?.prompt).toContain("physicalState");
    expect(calls[1]?.prompt).toContain("devilThought");
    expect(calls[1]?.prompt).toContain("Do not continue");
  });

  it("keeps a non-truncation format retry non-streaming", async () => {
    const streams: Array<boolean | undefined> = [];
    const invoke: ProviderChatInvoker = async (_providerSettings, _messages, options) => {
      streams.push(options.stream);
      if (streams.length === 1)
        throw new ProviderError("format", "invalid", "", createApiErrorInfo("format", { providerCode: "invalid_role_protocol" }));
      return result(JSON.stringify({ messages: [{ content: "完整回复" }], innerVoice: voice }));
    };
    await generateCharacterReplyTurn(
      { ...defaultProvider, apiKey: "test", stream: false },
      [{ role: "user", content: "你好" }],
      character,
      false,
      "private",
      true,
      undefined,
      false,
      false,
      [],
      undefined,
      invoke,
    );
    expect(streams).toEqual([false, false]);
  });
  it("uses the persisted local bubble target instead of selecting again", async () => {
    let prompt = "";
    const invoke: ProviderChatInvoker = async (_settings, messages) => {
      prompt = messages.at(-1)?.content ?? "";
      return result(JSON.stringify({ messages: [{ content: "one" }], innerVoice: voice }));
    };
    const turn = await generateCharacterReplyTurn(
      { ...defaultProvider, apiKey: "test", stream: false },
      [{ role: "user", content: "hello" }],
      character,
      false,
      "private",
      true,
      undefined,
      false,
      false,
      [],
      undefined,
      invoke,
      1,
    );
    expect(turn.targetCount).toBe(1);
    expect(turn.parts).toHaveLength(1);
    expect(prompt).toContain("selected exactly 1 bubbles for this turn");
  });

  it("accepts two complete bubbles in one call when adaptive preference is one", async () => {
    const invoke = vi.fn<ProviderChatInvoker>(async () => result(JSON.stringify({
      messages: [{ content: "one" }, { content: "two" }],
      innerVoice: voice,
    })));
    const diagnostics: unknown[] = [];
    const turn = await generateCharacterReplyTurn(
      { ...defaultProvider, apiKey: "test", stream: false },
      [{ role: "user", content: "short" }],
      character,
      false,
      "private",
      true,
      undefined,
      false,
      false,
      [],
      undefined,
      invoke,
      { mode: "adaptive", min: 1, max: 8, preferred: 1 },
      (_attempt, value) => { diagnostics.push(value); },
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(turn.parts.map((part) => part.content)).toEqual(["one", "two"]);
    expect(turn.targetCount).toBe(1);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        preferredCount: 1,
        rawMessageCount: 2,
        finalMessageCount: 2,
        countResolution: "unchanged",
        countCompliant: true,
      }),
    ]);
  });
});
