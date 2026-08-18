import { describe, expect, it } from "vitest";
import { ProviderError } from "./provider";
import { shouldUseSecondaryMeetProvider } from "./meetService";

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
});
