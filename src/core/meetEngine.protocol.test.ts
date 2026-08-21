import { describe, expect, it } from "vitest";
import { MeetProtocolError, parseMeetTurnResponse } from "./meetEngine";

const id = "character";

describe("meet provider protocol", () => {
  it("accepts the direct meet turn protocol", () => {
    expect(parseMeetTurnResponse(JSON.stringify({ characterId: id, prose: "一段现场叙事", thought: "", dialogue: "你好", suggestions: [] }), id)).toMatchObject({ characterId: id, prose: "一段现场叙事", dialogue: "你好" });
  });

  it("accepts the legacy replies container and selects the current character", () => {
    const raw = JSON.stringify({ narration: "环境", replies: [{ characterId: "other", prose: "忽略" }, { characterId: id, prose: "保留", dialogue: "在这里" }] });
    expect(parseMeetTurnResponse(raw, id)).toMatchObject({ characterId: id, prose: "保留", dialogue: "在这里" });
  });

  it("rejects compact and legacy private-chat protocols", () => {
    expect(() => parseMeetTurnResponse(JSON.stringify({ m: [{ c: "聊天" }], v: { s: {} } }), id)).toThrow(MeetProtocolError);
    expect(() => parseMeetTurnResponse(JSON.stringify({ messages: [{ content: "聊天" }], innerVoice: {} }), id)).toThrow(MeetProtocolError);
  });

  it("does not accept plain text or an empty meet object", () => {
    expect(() => parseMeetTurnResponse("普通文本", id)).toThrow(MeetProtocolError);
    expect(() => parseMeetTurnResponse("{}", id)).toThrow(MeetProtocolError);
  });
});
import {
  meetRoundStyleViolation,
  parseMeetRoundResponse,
  parseMeetRoundResponseWithMeta,
  parseMeetRoundResponseResilient,
} from "./meetEngine";

describe("unified meet response normalization", () => {
  it("unwraps a deterministic provider response wrapper without inventing content", () => {
    const result = parseMeetRoundResponseWithMeta(
      JSON.stringify({ data: { version: 1, segments: [{ type: "dialogue", characterId: "one", text: "Offline dialogue" }] } }),
      ["one"],
    );
    expect(result.repairApplied).toBe(true);
    expect(result.payload.segments).toEqual([{ type: "dialogue", characterId: "one", text: "Offline dialogue" }]);
  });

  it("rejects a wrapper that contains narration only", () => {
    expect(() => parseMeetRoundResponseWithMeta(
      JSON.stringify({ result: { version: 1, segments: [{ type: "narration", text: "Narration only" }] } }),
      ["one"],
    )).toThrow();
  });
});

describe("unified meet round protocol", () => {
  it("preserves shared narration and interleaved repeated dialogue", () => {
    const parsed = parseMeetRoundResponse(
      JSON.stringify({
        version: 1,
        segments: [
          { type: "narration", text: "雨声落在窗边。" },
          { type: "dialogue", characterId: "one", text: "先坐吧。" },
          { type: "narration", text: "门口传来脚步声。" },
          { type: "dialogue", characterId: "two", text: "我来晚了。" },
          { type: "dialogue", characterId: "one", text: "没关系。" },
        ],
      }),
      ["one", "two", "silent"],
    );
    expect(parsed.segments.map((segment) => segment.type)).toEqual([
      "narration",
      "dialogue",
      "narration",
      "dialogue",
      "dialogue",
    ]);
    expect(
      parsed.segments.filter((segment) => segment.type === "dialogue"),
    ).toHaveLength(3);
  });

  it("allows silent participants and ignores invalid optional payloads", () => {
    const parsed = parseMeetRoundResponse(
      JSON.stringify({
        version: 1,
        segments: [
          { type: "narration", text: "灯光暗下来。" },
          { type: "dialogue", characterId: "one", text: "我知道。" },
        ],
        thoughts: [
          { characterId: "one", text: "要慢一点说。" },
          { characterId: "ghost", text: "不应保存。" },
        ],
        updates: [{ characterId: "ghost", scenePatch: {} }],
        suggestions: ["继续", 123],
      }),
      ["one", "silent"],
      { thoughtsEnabled: true, bilingualCharacterIds: ["one"] },
    );
    expect(parsed.thoughts).toEqual([
      { characterId: "one", text: "要慢一点说。" },
    ]);
    expect(parsed.updates).toBeUndefined();
    expect(parsed.suggestions).toEqual(["继续"]);
    expect(parsed.warnings?.join("；")).toContain("缺少译文");
  });

  it("rejects ordinary chat, plain text, unknown speakers and narration-only rounds", () => {
    expect(() =>
      parseMeetRoundResponse(
        JSON.stringify({ m: [{ c: "聊天" }], v: { s: {} } }),
        ["one"],
      ),
    ).toThrow(MeetProtocolError);
    expect(() => parseMeetRoundResponse("普通文本", ["one"])).toThrow(
      MeetProtocolError,
    );
    expect(() =>
      parseMeetRoundResponse(
        JSON.stringify({
          version: 1,
          segments: [
            { type: "dialogue", characterId: "ghost", text: "错误" },
          ],
        }),
        ["one"],
      ),
    ).toThrow("角色 ID");
    expect(() =>
      parseMeetRoundResponse(
        JSON.stringify({
          version: 1,
          segments: [{ type: "narration", text: "只有描写。" }],
        }),
        ["one"],
      ),
    ).toThrow("至少需要一条角色台词");
  });

  it("counts only visible narration and dialogue for the round range", () => {
    const payload = parseMeetRoundResponse(
      JSON.stringify({
        version: 1,
        segments: [
          { type: "narration", text: "一二三" },
          { type: "dialogue", characterId: "one", text: "四五" },
        ],
        thoughts: [{ characterId: "one", text: "这段隐藏思想不计数" }],
      }),
      ["one"],
      { thoughtsEnabled: true },
    );
    expect(
      meetRoundStyleViolation(payload, {
        minChars: 5,
        maxChars: 5,
        thoughtsEnabled: true,
        perspective: "third",
        styleMode: "plain",
        customStyle: "",
      }),
    ).toMatchObject({ count: 5, belowMinimum: false, aboveMaximum: false });
  });
});

describe("meet regression validation details", () => {
  it("records deterministic detail codes for conservative round rejection", () => {
    try {
      parseMeetRoundResponseWithMeta(JSON.stringify({ version: 1, segments: [{ type: "dialogue", characterId: "ghost", text: "bad" }] }), ["one"]);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(MeetProtocolError);
      expect((error as MeetProtocolError).detailCode).toBe("unknown-character");
    }
    try {
      parseMeetRoundResponseWithMeta(JSON.stringify({ version: 1, segments: [{ type: "dialogue", characterId: "one", text: "ok" }], updates: [{ characterId: "one", scenePatch: { clothing: [123] } }] }), ["one"]);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(MeetProtocolError);
      expect((error as MeetProtocolError).detailCode).toBe("invalid-scene-update");
    }
  });

  it("accepts deterministic version and optional-field normalization", () => {
    const result = parseMeetRoundResponseWithMeta(JSON.stringify({ version: "1", segments: [{ type: "dialogue", characterId: "one", text: "ok" }], thoughts: null, updates: null, suggestions: null }), ["one"]);
    expect(result.payload.version).toBe(1);
    expect(result.repairApplied).toBe(true);
  });

});

describe("resilient meet visible-content guarantee", () => {
  const names = { one: "小一", two: "小二" };

  it("salvages common speech/action aliases without inventing text", () => {
    const result = parseMeetRoundResponseResilient(JSON.stringify({
      version: 1,
      segments: [
        { type: "action", content: "她走到窗边。" },
        { type: "speech", characterId: "one", content: "我在这里。" },
        { type: "speech", characterId: "ghost", text: "无法确认说话人。" },
      ],
      updates: [{ characterId: "one", scenePatch: { clothing: [123] } }],
    }), ["one", "two"], { participantNames: names, thoughtsEnabled: true });
    expect(result.parseMode).toBe("compatible-json");
    expect(result.payload.segments).toEqual([
      { type: "narration", text: "她走到窗边。" },
      { type: "dialogue", characterId: "one", text: "我在这里。" },
      { type: "narration", text: "无法确认说话人。" },
    ]);
    expect(result.unknownSpeakerCount).toBe(1);
    expect(result.ignoredMetadataCount).toBe(1);
  });

  it("accepts narration-only and plain visible text", () => {
    const narration = parseMeetRoundResponseResilient(JSON.stringify({ version: 1, segments: [{ type: "narration", text: "风吹过走廊。" }] }), ["one"]);
    expect(narration.payload.segments).toEqual([{ type: "narration", text: "风吹过走廊。" }]);
    expect(narration.parseMode).toBe("compatible-json");

    const plain = parseMeetRoundResponseResilient("风吹过走廊。\n“你来了。”", ["one"], { participantNames: names });
    expect(plain.parseMode).toBe("plain-visible-text");
    expect(plain.payload.segments).toEqual([
      { type: "narration", text: "风吹过走廊。" },
      { type: "dialogue", characterId: "one", text: "“你来了。”" },
    ]);
  });

  it("maps tagged lines and exact unique names while preserving unknown speakers as narration", () => {
    const result = parseMeetRoundResponseResilient("[N] 门被推开。\n[D:one] 进来吧。\n小二：我也到了。\n[D:ghost] 不应误认。", ["one", "two"], { participantNames: names });
    expect(result.parseMode).toBe("tagged-lines");
    expect(result.payload.segments).toEqual([
      { type: "narration", text: "门被推开。" },
      { type: "dialogue", characterId: "one", text: "进来吧。" },
      { type: "dialogue", characterId: "two", text: "我也到了。" },
      { type: "narration", text: "不应误认。" },
    ]);
    expect(result.unknownSpeakerCount).toBe(1);
  });

  it("recovers only complete visible strings from malformed JSON-like output", () => {
    const result = parseMeetRoundResponseResilient('{"version":1,"segments":[{"type":"narration","text":"完整片段"},{"type":"dialogue","text":"未闭合', ["one"]);
    expect(result.parseMode).toBe("compatible-json");
    expect(result.payload.segments).toContainEqual({ type: "narration", text: "完整片段" });
    expect(result.payload.segments.map((segment) => segment.text).join("\n")).not.toContain("未闭合");
  });

  it("still rejects an actually empty response", () => {
    expect(() => parseMeetRoundResponseResilient("   ", ["one"])).toThrow(MeetProtocolError);
  });
});