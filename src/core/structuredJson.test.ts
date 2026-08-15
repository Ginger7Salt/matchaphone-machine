import { describe, expect, it } from "vitest";
import {
  parseStructuredJson,
  parseStructuredJsonWithMeta,
  replyProtocolPresenceOf,
  StructuredJsonError,
} from "./structuredJson";

describe("parseStructuredJson", () => {
  it("extracts fenced JSON after hidden reasoning", () => {
    expect(parseStructuredJson('<think>hidden</think>```json\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it("repairs trailing commas and raw newlines inside strings", () => {
    const parsed = parseStructuredJsonWithMeta('{"text":"line one\nline two",}');
    expect(parsed.value).toEqual({ text: "line one\nline two" });
    expect(parsed.diagnostics).toMatchObject({
      parseStatus: "repaired-json",
      repairAttempted: true,
      repairedParseSucceeded: true,
    });
  });

  it("repairs common model JSON syntax without changing values", () => {
    const parsed = parseStructuredJsonWithMeta(
      "{messages:[{content:'hello'}], innerVoice:{sections:{physicalState:'steady'}, continuity:{emotion:'calm'}}}",
    );
    expect(parsed.value).toEqual({
      messages: [{ content: "hello" }],
      innerVoice: {
        sections: { physicalState: "steady" },
        continuity: { emotion: "calm" },
      },
    });
    expect(parsed.diagnostics).toMatchObject({
      parseStatus: "repaired-json",
      hasMessages: true,
      hasInnerVoice: true,
    });
  });

  it("extracts the largest complete object from surrounding prose", () => {
    expect(parseStructuredJson('preface {"items":[1,2]} suffix')).toEqual({ items: [1, 2] });
  });

  it("repairs a missing outer closing brace when field contents are complete", () => {
    expect(parseStructuredJsonWithMeta('{"secret":"abc"')).toMatchObject({
      value: { secret: "abc" },
      diagnostics: { parseStatus: "repaired-json" },
    });
  });

  it("repairs a syntactically unfinished generic object without exposing values in diagnostics", () => {
    const parsed = parseStructuredJsonWithMeta('{"secret":"private-value');
    expect(parsed).toMatchObject({
      value: { secret: "private-value" },
      diagnostics: { parseStatus: "repaired-json", repairAttempted: true },
    });
    expect(JSON.stringify(parsed.diagnostics)).not.toContain("private-value");
  });

  it("does not convert ordinary text into a JSON string", () => {
    expect(() => parseStructuredJson("plain visible text")).toThrow(StructuredJsonError);
  });

  it("repairs a long role protocol object with malformed model syntax", () => {
    const longText = '这一段包含未转义的"引号"、反斜杠\\路径和多行内容。\n'.repeat(24);
    const raw = [
      "模型说明：",
      "```json",
      '{messages:[{content:"' + longText + '"}], innerVoice:{sections:{',
      "physicalState:'呼吸平稳',",
      "emotionAndMind:'我在认真组织语言',",
      "unspokenWords:'还有一些话没有说出口',",
      "selfDeception:'我假装自己并不紧张',",
      "triggeredMemory:'此刻没有被触发的具体回忆',",
      "angelThought:'先尊重对方的感受',",
      "devilThought:'想更直接地表达自己',",
      "}, continuity:{emotion:'专注',},},}",
      "```",
    ].join("\n");
    const parsed = parseStructuredJsonWithMeta<any>(raw);
    expect(parsed.diagnostics).toMatchObject({
      parseStatus: "repaired-json",
      repairAttempted: true,
      repairedParseSucceeded: true,
      hasMessages: true,
      hasInnerVoice: true,
    });
    expect(parsed.value.messages[0].content).toContain("引号");
    expect(parsed.value.innerVoice.sections.devilThought).toContain("直接");
  });

  it("repairs malformed JSON embedded after surrounding prose", () => {
    expect(parseStructuredJsonWithMeta('说明文字\n{messages:[{content:"ok"}],}').value).toEqual({
      messages: [{ content: "ok" }],
    });
  });

  it("decodes multiply stringified JSON without accepting ordinary text", () => {
    const encoded = JSON.stringify(JSON.stringify({ messages: [{ content: "ok" }] }));
    const first = parseStructuredJsonWithMeta<string>(encoded);
    const second = parseStructuredJsonWithMeta(first.value);
    expect(second.value).toEqual({ messages: [{ content: "ok" }] });
  });

  it("repairs complete role JSON before treating scanner string state as truncation", () => {
    const raw = '{"messages":[{"content":"他说"你好"，然后继续完整回复"}],"innerVoice":{"sections":{"physicalState":"呼吸平稳","emotionAndMind":"认真回应","unspokenWords":"还有话没说","selfDeception":"假装不紧张","triggeredMemory":"此刻没有被触发的具体回忆","angelThought":"尊重对方","devilThought":"想更直接"},"continuity":{"emotion":"专注"}}}';
    const parsed = parseStructuredJsonWithMeta<any>(raw);
    expect(parsed.diagnostics).toMatchObject({
      parseStatus: "repaired-json",
      repairAttempted: true,
      repairedParseSucceeded: true,
      hasMessages: true,
      hasInnerVoice: true,
    });
    expect(parsed.value.messages[0].content).toContain("你好");
  });

  it("marks explicit transport incompleteness after deterministic repair fails", () => {
    let error: unknown;
    try {
      parseStructuredJsonWithMeta('{"messages":[{"content":"unfinished', { transportMarkedIncomplete: true });
    } catch (value) {
      error = value;
    }
    expect(error).toBeInstanceOf(StructuredJsonError);
    expect((error as StructuredJsonError).diagnostics).toMatchObject({
      parseStatus: "truncated-json",
      transportMarkedIncomplete: true,
      repairAttempted: true,
      repairedParseSucceeded: false,
    });
  });


  it("reports compact role protocol presence with the shared wire detector", () => {
    const value = { m: [{ c: "ok" }], v: { s: {}, q: {} } };
    expect(replyProtocolPresenceOf(value)).toEqual({ wireFormat: "compact", hasMessages: true, hasInnerVoice: true });
    expect(parseStructuredJsonWithMeta(JSON.stringify(value)).diagnostics).toMatchObject({
      parseStatus: "strict-json",
      wireFormat: "compact",
      hasMessages: true,
      hasInnerVoice: true,
    });
    expect(parseStructuredJsonWithMeta(JSON.stringify({ m: [{ c: "ok" }] })).diagnostics).toMatchObject({
      wireFormat: "compact",
      hasMessages: true,
      hasInnerVoice: false,
    });
  });

});
