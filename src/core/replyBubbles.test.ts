import { describe, expect, it } from "vitest";
import {
  adaptiveReplyRetryReason,
  normalizeReplyBubbles,
  normalizeStrictReplyBubbles,
  parseReplyBubbles,
  parseReplyTurn,
  parseStrictReplyTurn,
  replyBubbleInstruction,
  replyBubblePlanOf,
  replyBubbleRangeOf,
  visibleCharacterCount,
} from "./replyBubbles";
import { SCHEMA_VERSION, type Character } from "./types";

const character = {
  id: "c",
  schemaVersion: SCHEMA_VERSION,
  createdAt: 1,
  updatedAt: 1,
  name: "Role",
  avatar: "",
  bio: "",
  personality: "",
  speakingStyle: "",
  background: "",
  language: "English",
  proactive: {
    messages: false,
    timeAware: false,
    frequency: "low",
    quietStart: "23:00",
    quietEnd: "08:00",
    catchupLimit: 0,
    dailyLimit: 0,
  },
  relationship: { intimacy: 0, trust: 0, mood: "", recentEvents: [] },
  lastActiveAt: 1,
} as Character;

describe("reply bubble normalization", () => {
  it("uses adaptive counts when no range was configured and clamps explicit values", () => {
    expect(replyBubbleRangeOf(character)).toEqual({ min: 1, max: 8, adaptive: true });
    expect(replyBubbleInstruction(character, true, "private")).toContain(
      "There is no preset reply count",
    );
    expect(
      replyBubbleRangeOf({
        ...character,
        chatSettings: {
          language: "English",
          contextLimit: 30,
          stream: false,
          minReplyMessages: 2,
          maxReplyMessages: 4,
        },
      }),
    ).toEqual({ min: 1, max: 8, adaptive: true });
    expect(
      replyBubbleRangeOf({
        ...character,
        chatSettings: {
          language: "English",
          contextLimit: 30,
          stream: false,
          minReplyMessages: 9,
          maxReplyMessages: 1,
        },
      }),
    ).toEqual({ min: 8, max: 8, adaptive: false });
  });

  it("plans a concise variable rhythm for unconfigured characters", () => {
    const shortContext = [
      ...Array.from({ length: 5 }, (_, index) => ({ role: "assistant" as const, content: `old-a-${index}` })),
      { role: "user" as const, content: "上一轮" },
      ...Array.from({ length: 5 }, (_, index) => ({ role: "assistant" as const, content: `old-b-${index}` })),
      { role: "user" as const, content: "还在工作吗？" },
    ];
    const shortPlan = replyBubblePlanOf(character, shortContext, "private");
    expect(shortPlan).toMatchObject({ adaptive: true, preferredMin: 1, preferredMax: 2, recentCounts: [5, 5] });
    expect(adaptiveReplyRetryReason(shortPlan, Array.from({ length: 5 }, (_, index) => ({ content: String(index) })))).toContain("over-expanded");
    const normalPlan = replyBubblePlanOf(character, [{ role: "user", content: "今天下班后想去散散步，然后顺路买一点晚饭。" }], "private");
    expect(normalPlan).toMatchObject({ preferredMin: 2, preferredMax: 4 });
    const complexPlan = replyBubblePlanOf(character, [{ role: "user", content: "今天发生了很多事。你觉得我应该先和同事解释吗？还是等明天冷静一点再说？我也有点担心自己说错话。" }], "private");
    expect(complexPlan).toMatchObject({ preferredMin: 3, preferredMax: 6 });
    expect(replyBubbleInstruction(character, false, "private", false, false, false, shortPlan)).toContain("Never default to five bubbles");
  });

  it("enforces the locally selected exact bubble count for strict turns", () => {
    const parsed = parseStrictReplyTurn(
      JSON.stringify({ m: [{ c: "one" }, { c: "two" }] }),
      false,
      { min: 1, max: 8, adaptive: true },
      false,
      undefined,
      3,
    );
    expect(parsed.parts).toHaveLength(2);
    expect(parsed.compliant).toBe(false);
  });

  it("removes ordered-list markers from generated bubbles", () => {
    const parsed = parseReplyBubbles(
      JSON.stringify({
        messages: [
          { content: "1. first", translation: "1. \u7b2c\u4e00\u6761" },
          { content: "2) second", translation: "2) \u7b2c\u4e8c\u6761" },
        ],
      }),
      true,
      { min: 1, max: 8, adaptive: true },
    );
    expect(parsed.parts).toEqual([
      { content: "first", translation: "\u7b2c\u4e00\u6761" },
      { content: "second", translation: "\u7b2c\u4e8c\u6761" },
    ]);
  });

  it("accepts top-level arrays, common wrapper keys, fenced JSON and plain monolingual text", () => {
    const range = { min: 1, max: 8, adaptive: true };
    expect(parseReplyBubbles('[{"content":"first"}]', false, range).parts[0].content).toBe("first");
    expect(parseReplyBubbles('{"reply":"got it"}', false, range).parts[0].content).toBe("got it");
    expect(parseReplyBubbles('preface\n```json\n{"messages":["okay"]}\n```', false, range).parts[0].content).toBe("okay");
    expect(parseReplyBubbles("Plain text reply.", false, range).parts[0].content).toBe("Plain text reply.");
  });

  it("keeps visible messages when a required inner voice is malformed", () => {
    const parsed = parseReplyTurn(JSON.stringify({ messages: [{ content: "visible reply" }], innerVoice: { sections: {} } }), false, { min: 1, max: 8, adaptive: true }, true);
    expect(parsed.parts[0].content).toBe("visible reply");
    expect(parsed.innerVoice).toBeUndefined();
    expect(parsed.innerVoiceFormatError).toBe(true);
  });
  it("parses one required inner voice for the whole turn", () => {
    const parsed = parseReplyTurn(
      JSON.stringify({
        messages: [{ content: "first" }, { content: "second" }],
        innerVoice: {
          sections: {
            physicalState: "呼吸有一点慢下来。",
            emotionAndMind: "我仍然有些犹豫。",
            unspokenWords: "其实我还想再说一点。",
            selfDeception: "我假装自己并不在意。",
            triggeredMemory: "此刻没有被触发的具体回忆",
            angelThought: "先给对方一点空间。",
            devilThought: "干脆直接追问答案。",
          },
          continuity: { emotion: "犹豫" },
        },
      }),
      false,
      { min: 1, max: 8, adaptive: true },
      true,
    );
    expect(parsed.parts).toHaveLength(2);
    expect(parsed.innerVoice).toMatchObject({
      sections: { unspokenWords: "其实我还想再说一点。" },
      continuity: { emotion: "犹豫" },
    });
    expect(parsed.innerVoice?.content).toContain("【没说出口的话】");
  });

  it("turns blank-line paragraphs in one model item into separate bubbles", () => {
    const parsed = parseReplyBubbles(
      JSON.stringify({ messages: [{ content: "first\n\nsecond" }] }),
      false,
      { min: 2, max: 4 },
    );
    expect(parsed).toEqual({
      compliant: true,
      parts: [{ content: "first" }, { content: "second" }],
    });
  });

  it("keeps bilingual paragraphs aligned while splitting", () => {
    const parsed = parseReplyBubbles(
      JSON.stringify({
        messages: [
          {
            content: "first\n\nsecond",
            translation: "one\n\ntwo",
          },
        ],
      }),
      true,
      { min: 2, max: 4 },
    );
    expect(parsed.parts).toEqual([
      { content: "first", translation: "one" },
      { content: "second", translation: "two" },
    ]);
  });

  it("merges adjacent overflow without losing content", () => {
    const normalized = normalizeReplyBubbles(
      ["a", "b", "c", "d", "e"].map((content) => ({ content })),
      { min: 1, max: 3 },
    );
    expect(normalized.compliant).toBe(true);
    expect(normalized.parts).toHaveLength(3);
    expect(normalized.parts.map((item) => item.content).join("\n\n")).toContain(
      "a",
    );
    expect(normalized.parts.map((item) => item.content).join("\n\n")).toContain(
      "e",
    );
  });

  it("reports a short unsplittable response as non-compliant", () => {
    expect(
      normalizeReplyBubbles([{ content: "ok" }], { min: 2, max: 4 }),
    ).toMatchObject({ compliant: false, parts: [{ content: "ok" }] });
  });

  it("parses a validated optional music action", () => {
    const parsed = parseReplyTurn(
      JSON.stringify({
        messages: [{ content: "一起听吧" }],
        musicAction: { type: "play", trackId: "track-1" },
      }),
      false,
      { min: 1, max: 8, adaptive: true },
      false,
    );
    expect(parsed.musicAction).toEqual({ type: "play", trackId: "track-1" });
    expect(replyBubbleInstruction(character, false, "private", false, true)).toContain("musicAction");
  });

  it("parses a validated optional island action", () => {
    const parsed = parseReplyTurn(
      JSON.stringify({ messages: [{ content: "I left a note" }], islandAction: { type: "leave-letter", title: "Tonight", text: "Come back when you want." } }),
      false,
      { min: 1, max: 8, adaptive: true },
      false,
    );
    expect(parsed.islandAction).toEqual({ type: "leave-letter", title: "Tonight", text: "Come back when you want." });
    expect(replyBubbleInstruction(character, false, "private", false, false, true)).toContain("islandAction");
  });

  it("splits long Chinese replies at complete sentence and clause boundaries", () => {
    const normalized = normalizeReplyBubbles(
      [{ content: "我今天路过那家店，突然想起你之前说过的话。后来下雨了，我就站在屋檐下等了一会儿。" }],
      { min: 1, max: 8, adaptive: true },
    );
    expect(normalized.parts.length).toBeGreaterThan(1);
    expect(normalized.parts.map((part) => part.content).join("")).toBe("我今天路过那家店，突然想起你之前说过的话。后来下雨了，我就站在屋檐下等了一会儿。");
    expect(normalized.parts.every((part) => /[，。]$/.test(part.content))).toBe(true);
  });

  it("keeps semantic bubbles instead of merging them past the soft maximum", () => {
    const normalized = normalizeReplyBubbles(
      ["这是第一句完整的话。", "这是第二句完整而且稍微更长一些的话。", "这是第三句完整的话。"].map((content) => ({ content })),
      { min: 1, max: 1 },
    );
    expect(normalized.parts.length).toBeGreaterThan(1);
    expect(normalized.compliant).toBe(false);
  });

  it("counts emoji as visible graphemes", () => {
    expect(visibleCharacterCount("好呀👩‍❤️‍👩！")).toBe(4);
  });

  it("mentions the twenty-character semantic target in the model instruction", () => {
    const instruction = replyBubbleInstruction(character, false, "private");
    expect(instruction).toContain("around 20 visible characters");
    expect(instruction).toContain("semantically complete sentence or phrase");
  });

});


// Character DJ 2.0 structured action coverage.
describe("character DJ music actions", () => {
  it("parses queue, search and balanced-control actions", () => {
    const base = { messages: [{ content: "这首之后换一首吧" }] };
    expect(parseReplyTurn(JSON.stringify({ ...base, musicAction: { type: "queue-track", trackId: "track-2", placement: "next", reason: "适合现在" } }), false, { min: 1, max: 8, adaptive: true }, false).musicAction).toEqual({ type: "queue-track", trackId: "track-2", placement: "next", reason: "适合现在" });
    expect(parseReplyTurn(JSON.stringify({ ...base, musicAction: { type: "search-track", query: "雨天 安静", placement: "end" } }), false, { min: 1, max: 8, adaptive: true }, false).musicAction).toEqual({ type: "search-track", query: "雨天 安静", placement: "end" });
    expect(parseReplyTurn(JSON.stringify({ ...base, musicAction: { type: "propose-control", control: "clear-queue", reason: "想重新选一组" } }), false, { min: 1, max: 8, adaptive: true }, false).musicAction).toEqual({ type: "propose-control", control: "clear-queue", reason: "想重新选一组" });
  });
});

describe("reply sticker actions", () => {
  it("parses an optional sticker id and exposes the catalog in the JSON contract", () => {
    const parsed = parseReplyTurn(
      JSON.stringify({
        messages: [{ content: "好吧" }],
        stickerId: "sticker-1",
      }),
      false,
      { min: 1, max: 8, adaptive: true },
      false,
    );
    expect(parsed.stickerId).toBe("sticker-1");
    const instruction = replyBubbleInstruction(
      character,
      false,
      "private",
      false,
      false,
      false,
      undefined,
      [{ id: "sticker-1", name: "无语", description: "无语地看着你" }],
    );
    expect(instruction).toContain('"stickerId":null');
    expect(instruction).toContain("sticker-1");
    expect(instruction).toContain("do not explain");
  });

  it("does not request a sticker field without an available mounted catalog", () => {
    expect(replyBubbleInstruction(character, false, "private")).not.toContain(
      '"stickerId":null',
    );
  });
  it("keeps consensual adult text with quotes and newlines in visible reply and inner voice", () => {
    const visible = "ADULT_CONSENSUAL: \"stop whenever you want\".\nI will listen.";
    const parsed = parseReplyTurn(JSON.stringify({
      messages: [{ content: visible }],
      innerVoice: { sections: {
        physicalState: "\u547c\u5438\u4fdd\u6301\u5e73\u7a33\u3002",
        emotionAndMind: "\u6211\u8ba4\u771f\u7559\u610f\u53cc\u65b9\u7684\u540c\u610f\u3002",
        unspokenWords: "\u6211\u8fd8\u60f3\u7ee7\u7eed\u8ba4\u771f\u542c\u5bf9\u65b9\u8bf4\u3002",
        selfDeception: "\u6211\u5047\u88c5\u81ea\u5df1\u5e76\u4e0d\u7d27\u5f20\u3002",
        triggeredMemory: "\u6b64\u523b\u6ca1\u6709\u88ab\u89e6\u53d1\u7684\u5177\u4f53\u56de\u5fc6",
        angelThought: "\u5148\u660e\u786e\u786e\u8ba4\u8fb9\u754c\u3002",
        devilThought: "\u76f4\u63a5\u8bf4\u51fa\u81ea\u5df1\u7684\u6b32\u671b\u3002",
      }, continuity: { emotion: "\u4e13\u6ce8" } },
    }), false, { min: 1, max: 8, adaptive: true }, true);
    expect(parsed.parts.map((part) => part.content).join("\\n")).toContain("stop whenever you want");
    expect(parsed.parts.map((part) => part.content).join(" ").replace(/\s+/g, " ")).toContain("I will listen");
    expect(parsed.innerVoiceFormatError).toBe(false);
    expect(parsed.innerVoice?.sections.unspokenWords).toContain("\u8ba4\u771f\u542c");
  });

});


describe("compact reply wire protocol", () => {
  it("parses the compact m/v wire protocol and derives inner voice content locally", () => {
    const parsed = parseReplyTurn(
      JSON.stringify({
        m: [{ c: "\u5148\u62b1\u62b1\u4f60" }],
        v: {
          s: {
            p: "\u547c\u5438\u653e\u6162",
            e: "\u62c5\u5fc3\u4f46\u8ba4\u771f",
            u: "\u5176\u5b9e\u5f88\u60f3\u966a\u4f60",
            d: "\u5047\u88c5\u6ca1\u90a3\u4e48\u5728\u610f",
            r: "\u6b64\u523b\u6ca1\u6709\u88ab\u89e6\u53d1\u7684\u5177\u4f53\u56de\u5fc6",
            a: "\u5148\u542c\u4f60\u8bf4\u5b8c",
            x: "\u60f3\u7acb\u523b\u8ffd\u95ee",
          },
          q: { e: "\u62c5\u5fc3", p: "\u80a9\u8180\u653e\u677e", c: "\u6015\u4f60\u96be\u53d7", i: "\u5148\u966a\u7740\u4f60" },
        },
      }),
      false,
      { min: 1, max: 8, adaptive: true },
      true,
    );
    expect(parsed.parts).toEqual([{ content: "\u5148\u62b1\u62b1\u4f60", translation: undefined }]);
    expect(parsed.innerVoice?.sections.physicalState).toBe("\u547c\u5438\u653e\u6162");
    expect(parsed.innerVoice?.content).toContain("\u8eab\u4f53\u6b64\u523b");
  });

  it("rejects an oversized compact field instead of truncating it", () => {
    expect(() => parseReplyTurn(
      JSON.stringify({
        m: [{ c: "a".repeat(81) }],
        v: { s: { p: "p", e: "e", u: "u", d: "d", r: "r", a: "a", x: "x" }, q: { e: "e" } },
      }),
      false,
      { min: 1, max: 8, adaptive: true },
      true,
    )).toThrow();
  });

  it("accepts a complete compact reply whose serialized wire text exceeds the old global cap", () => {
    const raw = JSON.stringify({
      m: [{ c: "\u5b8c\u6574\u56de\u590d" }],
      v: { s: { p: "\u547c\u5438\u5e73\u7a33", e: "\u8ba4\u771f\u56de\u5e94", u: "\u8fd8\u6709\u4e00\u70b9\u60f3\u8bf4", d: "\u5047\u88c5\u5e76\u4e0d\u5728\u610f", r: "\u6b64\u523b\u6ca1\u6709\u88ab\u89e6\u53d1\u7684\u5177\u4f53\u56de\u5fc6", a: "\u5148\u5c0a\u91cd\u5bf9\u65b9", x: "\u60f3\u66f4\u76f4\u63a5\u4e00\u70b9" }, q: { e: "\u4e13\u6ce8" } },
    }) + " ".repeat(2600);
    expect(raw.length).toBeGreaterThan(2400);
    expect(parseStrictReplyTurn(raw, false, { min: 1, max: 8, adaptive: true }, true).parts[0]?.content).toBe("\u5b8c\u6574\u56de\u590d");
  });

  it("keeps strict m-array items as explicit bubble boundaries", () => {
    const parsed = normalizeStrictReplyBubbles(
      [{ content: "First sentence. Second sentence?" }],
      { min: 1, max: 8, adaptive: true },
      { mode: "adaptive", min: 1, max: 8, preferred: 1 },
    );
    expect(parsed.parts).toEqual([{ content: "First sentence. Second sentence?" }]);
    expect(parsed.countDiagnostics).toMatchObject({
      rawMessageCount: 1,
      finalMessageCount: 1,
      countResolution: "unchanged",
      countCompliant: true,
    });
  });

  it("accepts two natural bubbles when adaptive preference is one", () => {
    const parsed = normalizeStrictReplyBubbles(
      [{ content: "one" }, { content: "two" }],
      { min: 1, max: 8, adaptive: true },
      { mode: "adaptive", min: 1, max: 8, preferred: 1 },
    );
    expect(parsed.compliant).toBe(true);
    expect(parsed.parts).toHaveLength(2);
    expect(parsed.countDiagnostics).toMatchObject({
      preferredCount: 1,
      rawMessageCount: 2,
      finalMessageCount: 2,
      countResolution: "unchanged",
      countCompliant: true,
    });
  });
});
