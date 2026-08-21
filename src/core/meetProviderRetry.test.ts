import { describe, expect, it } from "vitest";
import { ProviderError } from "./provider";
import { MEET_ROUND_INPUT_BUDGET, fitMeetPromptMessages, meetInputBudgetOf, shouldUseSecondaryMeetProvider } from "./meetService";
import { defaultProvider } from "./types";

describe("meet context budget",()=>{
 it("uses a smaller bounded retry budget",()=>{expect(MEET_ROUND_INPUT_BUDGET).toEqual([48000,32000]);expect(MEET_ROUND_INPUT_BUDGET[1]).toBeLessThan(MEET_ROUND_INPUT_BUDGET[0]);});
 it("respects custom provider windows and output reserves",()=>{const first=meetInputBudgetOf({...defaultProvider, networkMode: "direct" as const,contextBudgetMode:"custom",contextWindowTokens:32000},0),retry=meetInputBudgetOf({...defaultProvider, networkMode: "direct" as const,contextBudgetMode:"custom",contextWindowTokens:32000},1);expect(first).toMatchObject({tokens:32000,source:"custom",requested:48000,effective:14000,outputReserve:16000});expect(retry).toMatchObject({effective:18000,outputReserve:12000});});
});

describe("meet provider retry classification", () => {
  it("switches providers for rate, CORS, and prompt blocking failures", () => {
    expect(shouldUseSecondaryMeetProvider(new ProviderError("rate", "rate limited"))).toBe(true);
    expect(shouldUseSecondaryMeetProvider(new ProviderError("cors", "cors failed"))).toBe(true);
    expect(
      shouldUseSecondaryMeetProvider(
        new ProviderError("format", "blocked", "", {
          source: "api",
          kind: "format",
          meaning: "blocked",
          providerCode: "prompt_blocked",
          troubleshooting: [],
        }),
      ),
    ).toBe(true);
  });

  it("does not switch providers for ordinary protocol or content retries", () => {
    expect(shouldUseSecondaryMeetProvider(new Error("invalid meet round"))).toBe(false);
    expect(shouldUseSecondaryMeetProvider(new ProviderError("format", "truncated"))).toBe(false);
  });

  it("fits the final message envelope under the effective budget", () => {
    const result = fitMeetPromptMessages([
      { id: "required", content: "LATEST_USER".repeat(30), required: true },
      { id: "history", content: "OLD_HISTORY".repeat(4000), priority: 0 },
    ], 500, false);
    expect(result.inputTokens).toBeLessThanOrEqual(500);
    expect(result.messages.at(-1)?.content).toContain("LATEST_USER");
  });

  it("fails before transport when immutable prompt sections exceed the budget", () => {
    expect(() => fitMeetPromptMessages([{ id: "latest", content: "LATEST".repeat(1000), required: true }], 100, false)).toThrow();
  });
});
