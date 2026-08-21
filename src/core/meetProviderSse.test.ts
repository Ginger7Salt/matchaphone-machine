import { describe, expect, it, vi } from "vitest";
import { OpenAIProvider } from "./provider";
import { defaultProvider } from "./types";

const encoder = new TextEncoder();
const provider = {
  ...defaultProvider,
  networkMode: "direct" as const,
  apiKey: "test-key",
  baseUrl: "https://api.test/v1",
  stream: true,
  timeoutMs: 1000,
};
function stream(body: string) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
const round = JSON.stringify({
  version: 1,
  segments: [{ type: "dialogue", characterId: "one", text: "完整台词" }],
});

describe("meet SSE candidate selection", () => {
  it("treats a complete JSON object inside delta.content as one object", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream(
      `data: ${JSON.stringify({ choices: [{ delta: { content: round } }] })}\n\ndata: [DONE]\n\n`,
    )));
    const result = await new OpenAIProvider(provider).chatWithMeta(
      [{ role: "user", content: "meet" }],
      { stream: true },
    );
    expect(result.text).toBe(round);
    expect(result.sseMode).toBe("complete-object");
    expect(result.normalizationPath).toContain("delta.content");
  });

  it("does not append metadata after a complete object", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream(
      `data: ${JSON.stringify({ choices: [{ delta: { content: round } }] })}\n\n` +
      `data: ${JSON.stringify({ usage: { total_tokens: 99 } })}\n\ndata: [DONE]\n\n`,
    )));
    const result = await new OpenAIProvider(provider).chatWithMeta(
      [{ role: "user", content: "meet" }],
      { stream: true },
    );
    expect(result.text).toBe(round);
    expect(result.text).not.toContain("total_tokens");
  });

  it("keeps delta text in order without treating reasoning as visible content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream(
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "hidden" } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: { content: "{\\\"version\\\":1," } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: { content: "\\\"segments\\\":[{\\\"type\\\":\\\"dialogue\\\",\\\"characterId\\\":\\\"one\\\",\\\"text\\\":\\\"短\\\"}]}" } }] })}\n\ndata: [DONE]\n\n`,
    )));
    const result = await new OpenAIProvider(provider).chatWithMeta(
      [{ role: "user", content: "meet" }],
      { stream: true },
    );
    expect(result.text).not.toContain("hidden");
    expect(result.text).toContain("短");
  });
});
