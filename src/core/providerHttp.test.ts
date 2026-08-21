import { beforeEach, describe, expect, it, vi } from "vitest";
import { getStoredActivationLicense, verifyStoredActivation } from "./activation";
import { executeProviderHttp, ProviderRelayError } from "./providerHttp";
import { defaultProvider } from "./types";

vi.mock("./activation", () => ({ getStoredActivationLicense: vi.fn(), verifyStoredActivation: vi.fn() }));
const license = { payload: { version: 1 as const, environmentId: "matchaphone-d5gjgy87ybfb50382", activationId: "activation", cloudbaseUid: "uid", deviceKeyHash: "device", issuedAt: 1, permanent: true as const }, signature: "signature", publicKeyId: "key" };

beforeEach(() => {
  vi.mocked(getStoredActivationLicense).mockResolvedValue(license);
  vi.mocked(verifyStoredActivation).mockResolvedValue(true);
  vi.stubGlobal("crypto", { ...globalThis.crypto, randomUUID: () => "relay-client-request" });
});

describe("provider HTTP network modes", () => {
  it("uses browser direct mode without contacting Relay", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await executeProviderHttp({ settings: { ...defaultProvider, networkMode: "direct", apiKey: "secret" }, protocol: "openai-compatible", endpoint: "https://provider.example/v1/chat/completions", operation: "chat", method: "POST", headers: { Authorization: "Bearer secret", "Content-Type": "application/json" }, body: "{}", timeoutMs: 5000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://provider.example/v1/chat/completions");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "error", headers: { Authorization: "Bearer secret" } });
    expect(result.metadata).toEqual({ networkMode: "direct", relayUsed: false });
  });

  it("sends only the Relay envelope to the same-origin endpoint", async () => {
    let envelope: any;
    vi.stubGlobal("window", { location: { origin: "https://app.example" } });
    const fetchMock = vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
      envelope = JSON.parse(String(options.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200, headers: { "Content-Type": "application/json", "X-Relay-Request-Id": "relay-server-request", "X-Relay-Duration-Ms": "12", "X-Upstream-Status": "200", "X-Upstream-Bytes": "42" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await executeProviderHttp({ settings: { ...defaultProvider, networkMode: "relay", apiKey: "secret" }, protocol: "gemini", endpoint: "https://provider.example/v1beta/models/model:generateContent", operation: "chat", method: "POST", headers: { "x-goog-api-key": "secret" }, body: "{\"contents\":[]}", timeoutMs: 5000 });
    expect(fetchMock.mock.calls[0][0]).toBe("https://app.example/api/provider-relay");
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({ "Content-Type": "application/json" });
    expect(envelope).toMatchObject({ version: 1, requestId: expect.any(String), operation: "chat", protocol: "gemini", apiKey: "secret", method: "POST", body: "{\"contents\":[]}", activationLicense: license });
    expect(result.metadata).toMatchObject({ networkMode: "relay", relayUsed: true, relayRequestId: "relay-server-request", relayDurationMs: 12, upstreamHttpStatus: 200, upstreamBytes: 42 });
  });

  it("does not fall back to direct when Relay is unavailable", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch secret"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(executeProviderHttp({ settings: { ...defaultProvider, networkMode: "relay", apiKey: "secret" }, protocol: "openai-compatible", endpoint: "https://provider.example/v1/chat/completions", operation: "chat", method: "POST", headers: { Authorization: "Bearer secret" }, body: "{}", timeoutMs: 5000 })).rejects.toMatchObject({ code: "relay-unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid local activation before contacting Relay", async () => {
    vi.mocked(verifyStoredActivation).mockResolvedValue(false);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(executeProviderHttp({ settings: { ...defaultProvider, networkMode: "relay", apiKey: "secret" }, protocol: "openai-compatible", endpoint: "https://provider.example/v1/chat/completions", operation: "chat", method: "POST", headers: {}, body: "{}", timeoutMs: 5000 })).rejects.toMatchObject({ code: "relay-activation-invalid", status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces sanitized Relay error metadata", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "Endpoint 被拒绝" } }), { status: 400, headers: { "Content-Type": "application/json", "X-Relay-Request-Id": "relay-id", "X-Relay-Error-Code": "relay-endpoint-blocked", "X-Relay-Duration-Ms": "7" } })));
    const promise = executeProviderHttp({ settings: { ...defaultProvider, networkMode: "relay", apiKey: "secret" }, protocol: "openai-compatible", endpoint: "https://provider.example/v1/chat/completions", operation: "chat", method: "POST", headers: {}, body: "{}", timeoutMs: 5000 });
    await expect(promise).rejects.toBeInstanceOf(ProviderRelayError);
    await expect(promise).rejects.toMatchObject({ code: "relay-endpoint-blocked", status: 400, relayRequestId: "relay-id", durationMs: 7 });
  });
});
