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