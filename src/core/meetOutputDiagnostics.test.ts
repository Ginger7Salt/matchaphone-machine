import { describe, expect, it } from "vitest";
import { MeetProtocolError, parseMeetRoundResponseWithMeta } from "./meetEngine";

describe("meet output diagnostics", () => {
  it("reports the malformed segment field without response text", () => {
    expect(() => parseMeetRoundResponseWithMeta(JSON.stringify({ version: 1, segments: [{ type: "dialogue", characterId: "character", text: 42 }] }), ["character"]))
      .toThrowError(MeetProtocolError);
    try {
      parseMeetRoundResponseWithMeta(JSON.stringify({ version: 1, segments: [{ type: "dialogue", characterId: "character", text: 42 }] }), ["character"]);
    } catch (error) {
      expect(error).toMatchObject({ detailCode: "invalid-segment-text", diagnostics: { segmentIndex: 0, segmentType: "dialogue", field: "text", segmentCount: 1 } });
      expect(String(error)).not.toContain("42");
    }
  });
  it("reports unknown character location without saving text", () => {
    try {
      parseMeetRoundResponseWithMeta(JSON.stringify({ version: 1, segments: [{ type: "dialogue", characterId: "ghost", text: "PRIVATE_TEXT" }] }), ["character"]);
    } catch (error) {
      expect(error).toMatchObject({ detailCode: "unknown-character", diagnostics: { segmentIndex: 0, segmentType: "dialogue", field: "characterId", segmentCount: 1 } });
      expect(String(error)).not.toContain("PRIVATE_TEXT");
    }
  });
});
