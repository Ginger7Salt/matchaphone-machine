import { getStoredActivationLicense, verifyStoredActivation } from "./activation";
import { PUBLIC_DEMO_MODE, publicDemoBackendError } from "./publicDemo";
import type { ProviderProtocol, ProviderSettings } from "./types";

export type ProviderRelayOperation = "chat" | "models" | "connectivity";
export interface ProviderHttpMetadata {
  networkMode: "relay" | "direct";
  relayUsed: boolean;
  relayRequestId?: string;
  relayStatus?: number;
  relayErrorCode?: string;
  relayDurationMs?: number;
  upstreamHttpStatus?: number;
  upstreamBytes?: number;
}
export interface ProviderHttpResult { response: Response; metadata: ProviderHttpMetadata }
export class ProviderRelayError extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
    public relayRequestId?: string,
    public durationMs?: number,
    public upstreamHttpStatus?: number,
    public upstreamBytes?: number,
  ) { super(message); this.name = "ProviderRelayError"; }
}

export function relayUrl() {
  if (typeof window === "undefined") return "/api/provider-relay";
  return `${window.location.origin}/api/provider-relay`;
}
function numberHeader(headers: Headers, name: string) {
  const value = Number(headers.get(name));
  return Number.isFinite(value) ? value : undefined;
}
function relayMetadata(response: Response): ProviderHttpMetadata {
  return {
    networkMode: "relay",
    relayUsed: true,
    relayRequestId: response.headers.get("X-Relay-Request-Id") ?? undefined,
    relayStatus: response.status,
    relayErrorCode: response.headers.get("X-Relay-Error-Code") ?? undefined,
    relayDurationMs: numberHeader(response.headers, "X-Relay-Duration-Ms"),
    upstreamHttpStatus: numberHeader(response.headers, "X-Upstream-Status"),
    upstreamBytes: numberHeader(response.headers, "X-Upstream-Bytes"),
  };
}

export async function executeProviderHttp(input: {
  settings: ProviderSettings;
  protocol: Exclude<ProviderProtocol, "auto">;
  endpoint: string;
  operation: ProviderRelayOperation;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<ProviderHttpResult> {
  const useRelay = input.settings.networkMode === "relay" && !PUBLIC_DEMO_MODE;
  if (!useRelay) {
    const response = await fetch(input.endpoint, {
      method: input.method,
      headers: input.headers,
      body: input.body,
      signal: input.signal,
      redirect: "error",
    });
    return { response, metadata: { networkMode: "direct", relayUsed: false } };
  }
  const [activationLicense, activationValid] = await Promise.all([
    getStoredActivationLicense(),
    verifyStoredActivation(),
  ]);
  if (!activationLicense || !activationValid)
    throw new ProviderRelayError("relay-activation-invalid", "Relay activation license is invalid", 401);
  let response: Response;
  try {
    response = await fetch(relayUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        requestId: crypto.randomUUID(),
        operation: input.operation,
        protocol: input.protocol,
        endpoint: input.endpoint,
        apiKey: input.settings.apiKey,
        method: input.method,
        ...(input.body === undefined ? {} : { body: input.body }),
        timeoutMs: input.timeoutMs,
        activationLicense,
      }),
      signal: input.signal,
      redirect: "error",
    });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    throw new ProviderRelayError("relay-unavailable", "无法连接安全 Relay", undefined, undefined, undefined);
  }
  const metadata = relayMetadata(response);
  if (metadata.relayErrorCode) {
    let message = "安全 Relay 请求失败";
    try {
      const payload = await response.clone().json() as { error?: { message?: string } };
      if (payload?.error?.message) message = payload.error.message;
    } catch {}
    throw new ProviderRelayError(metadata.relayErrorCode, message, response.status, metadata.relayRequestId, metadata.relayDurationMs, metadata.upstreamHttpStatus, metadata.upstreamBytes);
  }
  return { response, metadata };
}
