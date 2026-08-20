import http from "node:http";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { Agent } from "undici";

export const MAX_REQUEST_BYTES = 6 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const MIN_TIMEOUT_MS = 5_000;
export const MAX_TIMEOUT_MS = 180_000;
const ENVIRONMENT_ID = "matchaphone-d5gjgy87ybfb50382";
const PUBLIC_KEY_ID = "8Phv8bqUYj54QYW8tK1aOe";
const PUBLIC_JWK = { kty: "EC", x: "24gMkSzt5-o2wqygeCp0smVE30zel6abNHc4xUxkDkI", y: "v1W3PMS6dVfbGyBsIitxgvPUJVE1lt6XnQt12a6C6zc", crv: "P-256" };
const allowedProtocols = new Set(["openai-compatible", "openai-responses", "gemini", "claude", "deepseek-compatible"]);
const allowedOrigins = new Set([
  "https://matchaphone-d5gjgy87ybfb50382-1463048417.tcloudbaseapp.com",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);
const sensitiveQueryKey = /(?:api[_-]?key|token|secret|authorization|access[_-]?token|password)/i;

function base64UrlBytes(value) { return Buffer.from(value, "base64url"); }
function canonicalPayload(payload) {
  return JSON.stringify({ version: payload.version, environmentId: payload.environmentId, activationId: payload.activationId, cloudbaseUid: payload.cloudbaseUid, deviceKeyHash: payload.deviceKeyHash, issuedAt: payload.issuedAt, permanent: payload.permanent });
}
export function verifyLicense(license, options = {}) {
  const payload = license?.payload;
  const publicKeyId = options.publicKeyId ?? PUBLIC_KEY_ID;
  const publicJwk = options.publicJwk ?? PUBLIC_JWK;
  if (!payload || license.publicKeyId !== publicKeyId || payload.version !== 1 || payload.environmentId !== ENVIRONMENT_ID || payload.permanent !== true || typeof payload.activationId !== "string" || !payload.activationId || typeof payload.cloudbaseUid !== "string" || !payload.cloudbaseUid || typeof payload.deviceKeyHash !== "string" || !payload.deviceKeyHash || typeof payload.issuedAt !== "number" || !Number.isFinite(payload.issuedAt) || typeof license.signature !== "string") return false;
  try {
    const key = crypto.createPublicKey({ key: publicJwk, format: "jwk" });
    return crypto.verify("sha256", Buffer.from(canonicalPayload(payload)), { key, dsaEncoding: "ieee-p1363" }, base64UrlBytes(license.signature));
  } catch { return false; }
}

function safeHostname(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, "");
  return normalized.length > 0 && !normalized.endsWith(".") && !/(^|\.)(localhost|local|internal|home|lan)$/i.test(normalized);
}
function ipv4Number(ip) { return ip.split(".").reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0); }
function inV4Range(ip, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4Number(ip) & mask) === (ipv4Number(base) & mask);
}
function ipv4Reserved(ip) {
  const ranges = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
    ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
    ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  ];
  return ranges.some(([base, bits]) => inV4Range(ip, base, bits));
}
function ipv6Reserved(ip) {
  const value = ip.replace(/^\[|\]$/g, "").toLowerCase();
  if (value === "::" || value === "::1") return true;
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return net.isIP(mapped[1]) !== 4 || ipv4Reserved(mapped[1]);
  return /^(?:fc|fd)/.test(value) || /^fe[89ab]/.test(value) || /^ff/.test(value)
    || /^2001:db8(?::|$)/.test(value) || /^2001:0(?::|$)/.test(value)
    || /^2002(?::|$)/.test(value) || /^100:(?:0*:){1,3}/.test(value);
}
export function isPublicAddress(address) {
  const normalized = String(address).replace(/^\[|\]$/g, "");
  return net.isIP(normalized) === 4 ? !ipv4Reserved(normalized) : net.isIP(normalized) === 6 ? !ipv6Reserved(normalized) : false;
}
export async function resolvePublicAddresses(hostname, resolver = dns) {
  const normalized = hostname.replace(/^\[|\]$/g, "");
  if (!safeHostname(normalized)) throw new RelayInputError("relay-endpoint-blocked", "Endpoint 主机名不被允许");
  const addresses = await resolver.lookup(normalized, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new RelayInputError("relay-endpoint-blocked", "Endpoint 必须只解析到公网地址");
  return addresses;
}
export function endpointOf(value) {
  let url;
  try { url = new URL(value); } catch { throw new RelayInputError("relay-endpoint-blocked", "Endpoint 格式无效"); }
  if (url.protocol !== "https:" || url.username || url.password || !safeHostname(url.hostname)) throw new RelayInputError("relay-endpoint-blocked", "Relay 只允许不含凭证的公网 HTTPS Endpoint");
  for (const key of url.searchParams.keys()) if (sensitiveQueryKey.test(key)) throw new RelayInputError("relay-endpoint-blocked", "API Key 不得放在 Endpoint 查询参数中");
  return url;
}
export function headersFor(protocol, apiKey) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream, application/x-ndjson" };
  if (protocol === "gemini") headers["x-goog-api-key"] = apiKey;
  else if (protocol === "claude") { headers["x-api-key"] = apiKey; headers["anthropic-version"] = "2023-06-01"; }
  else headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

export class RelayInputError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = "RelayInputError"; this.code = code; this.status = status; }
}
function originAllowed(origin) { return allowedOrigins.has(origin); }
function corsHeaders(origin) {
  if (!originAllowed(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Expose-Headers": "Retry-After, X-Relay-Request-Id, X-Relay-Error-Code, X-Relay-Duration-Ms, X-Upstream-Status, X-Upstream-Bytes",
  };
}
function readBody(req, maxBytes = MAX_REQUEST_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = []; let settled = false;
    req.on("data", chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) { settled = true; reject(new RelayInputError("relay-request-too-large", "Relay 请求体过大", 413)); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!settled) resolve({ text: Buffer.concat(chunks).toString("utf8"), bytes: size }); });
    req.on("error", error => { if (!settled) reject(error); });
  });
}
function createLimiter({ now = Date.now, maxPerMinute = 60, maxConcurrent = 4 } = {}) {
  const counters = new Map(); const active = new Map();
  return {
    acquire(key) {
      const timestamp = now(); const row = counters.get(key);
      const current = !row || timestamp - row.start >= 60_000 ? { start: timestamp, count: 0 } : row;
      if (current.count >= maxPerMinute) throw new RelayInputError("relay-rate-limited", "Relay 调用频率过高，请稍后重试", 429);
      const busy = active.get(key) || 0;
      if (busy >= maxConcurrent) throw new RelayInputError("relay-rate-limited", "Relay 并发请求过多，请稍后重试", 429);
      current.count += 1; counters.set(key, current); active.set(key, busy + 1);
      return () => { const next = (active.get(key) || 1) - 1; if (next > 0) active.set(key, next); else active.delete(key); };
    },
  };
}
function rateKey(license) { return crypto.createHash("sha256").update(`${license.payload.activationId}:${license.payload.deviceKeyHash}`).digest("base64url"); }
function relayError(res, error, requestId, started, origin, now = Date.now) {
  const status = error instanceof RelayInputError ? error.status : 502;
  const code = error?.code || "relay-unavailable";
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Relay-Request-Id": requestId, "X-Relay-Error-Code": code, "X-Relay-Duration-Ms": String(now() - started), ...corsHeaders(origin) });
  res.end(JSON.stringify({ ok: false, error: { code, message: error?.message || "Relay 暂时不可用" } }));
}
function agentFor(addresses) {
  const first = addresses[0];
  return new Agent({ connect: { lookup(_host, _options, callback) { callback(null, first.address, first.family); } }, maxRedirections: 0 });
}
function validateRelayInput(input, verifyLicenseImpl) {
  if (input?.version !== 1 || !allowedProtocols.has(input.protocol) || !["GET", "POST"].includes(input.method) || typeof input.apiKey !== "string" || !input.apiKey.trim() || typeof input.endpoint !== "string") throw new RelayInputError("relay-invalid-request", "Relay 请求字段无效");
  if (!["chat", "models", "connectivity"].includes(input.operation)) throw new RelayInputError("relay-invalid-request", "Relay 操作类型无效");
  if ((input.operation === "models" && input.method !== "GET") || (input.operation !== "models" && input.method !== "POST")) throw new RelayInputError("relay-invalid-request", "Relay 操作与请求方法不匹配");
  if (input.method === "POST" && typeof input.body !== "string") throw new RelayInputError("relay-invalid-request", "Relay POST 请求缺少正文");
  if (Buffer.byteLength(input.body || "") > MAX_REQUEST_BYTES) throw new RelayInputError("relay-request-too-large", "Provider 请求体过大", 413);
  if (!verifyLicenseImpl(input.activationLicense)) throw new RelayInputError("relay-activation-invalid", "茶茶机激活许可无效", 401);
}
async function proxy(res, input, requestId, origin, dependencies) {
  const { fetchImpl, resolver, verifyLicenseImpl, limiter, now, responseLimit } = dependencies;
  validateRelayInput(input, verifyLicenseImpl);
  const release = limiter.acquire(rateKey(input.activationLicense));
  const started = now(); let responseBytes = 0;
  try {
    const url = endpointOf(input.endpoint);
    const addresses = await resolvePublicAddresses(url.hostname, resolver);
    const timeoutMs = Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Number(input.timeoutMs) || 60_000));
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    let upstream;
    try {
      upstream = await fetchImpl(url, { method: input.method, headers: headersFor(input.protocol, input.apiKey), body: input.method === "POST" ? input.body : undefined, redirect: "error", signal: controller.signal, dispatcher: agentFor(addresses) });
    } catch (error) {
      if (controller.signal.aborted) throw new RelayInputError("relay-timeout", "Provider 请求超时", 504);
      throw new RelayInputError("relay-unavailable", "无法连接 Provider", 502);
    } finally { clearTimeout(timer); }
    const declaredLength = Number(upstream.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > responseLimit) throw new RelayInputError("relay-response-too-large", "Provider 响应过大", 502);
    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    const streaming = /(?:text\/event-stream|application\/(?:x-)?ndjson|application\/json-seq)/i.test(contentType);
    const outHeaders = { "Cache-Control": "no-store", "Content-Type": contentType, "X-Relay-Request-Id": requestId, "X-Upstream-Status": String(upstream.status), "X-Relay-Duration-Ms": String(now() - started), ...corsHeaders(origin) };
    const retryAfter = upstream.headers.get("retry-after"); if (retryAfter) outHeaders["Retry-After"] = retryAfter;
    if (!streaming) {
      const body = Buffer.from(await upstream.arrayBuffer());
      responseBytes = body.byteLength;
      if (responseBytes > responseLimit) throw new RelayInputError("relay-response-too-large", "Provider 响应过大", 502);
      outHeaders["X-Upstream-Bytes"] = String(responseBytes);
      res.writeHead(upstream.status, outHeaders); res.end(body);
    } else {
      if (Number.isFinite(declaredLength)) outHeaders["X-Upstream-Bytes"] = String(declaredLength);
      res.writeHead(upstream.status, outHeaders);
      if (upstream.body) for await (const chunk of upstream.body) {
        responseBytes += chunk.byteLength;
        if (responseBytes > responseLimit) { res.destroy(); throw new RelayInputError("relay-response-too-large", "Provider 响应过大", 502); }
        res.write(chunk);
      }
      res.end();
    }
    return { status: upstream.status, responseBytes, durationMs: now() - started };
  } finally { release(); }
}

export function createServer(options = {}) {
  const now = options.now ?? Date.now;
  const logger = options.logger ?? console;
  const dependencies = {
    fetchImpl: options.fetchImpl ?? fetch,
    resolver: options.resolver ?? dns,
    verifyLicenseImpl: options.verifyLicenseImpl ?? verifyLicense,
    limiter: options.limiter ?? createLimiter({ now }),
    now,
    responseLimit: options.responseLimit ?? MAX_RESPONSE_BYTES,
  };
  return http.createServer(async (req, res) => {
    const origin = String(req.headers.origin || ""); const requestId = crypto.randomUUID(); const started = now(); let protocol;
    if (req.method === "OPTIONS") {
      if (!originAllowed(origin)) return relayError(res, new RelayInputError("relay-unauthorized-origin", "当前网页不在 Relay 允许列表", 403), requestId, started, origin, now);
      res.writeHead(204, corsHeaders(origin)); return res.end();
    }
    if (req.method !== "POST") return relayError(res, new RelayInputError("relay-method-not-allowed", "Relay 只接受 POST", 405), requestId, started, origin, now);
    try {
      const raw = await readBody(req); let input;
      try { input = JSON.parse(raw.text); } catch { throw new RelayInputError("relay-invalid-request", "Relay 请求不是有效 JSON"); }
      protocol = allowedProtocols.has(input?.protocol) ? input.protocol : undefined;
      if (!originAllowed(origin)) throw new RelayInputError("relay-unauthorized-origin", "当前网页不在 Relay 允许列表", 403);
      const result = await proxy(res, input, requestId, origin, dependencies);
      logger.info?.(JSON.stringify({ relayRequestId: requestId, protocol, status: result.status, durationMs: result.durationMs, requestBytes: raw.bytes, responseBytes: result.responseBytes, errorCode: undefined }));
    } catch (error) {
      if (!res.headersSent) relayError(res, error, requestId, started, origin, now); else if (!res.writableEnded) res.destroy();
      logger.error?.(JSON.stringify({ relayRequestId: requestId, protocol, status: error?.status || 502, durationMs: now() - started, requestBytes: Number(req.headers["content-length"]) || undefined, responseBytes: undefined, errorCode: error?.code || "relay-unavailable" }));
    }
  });
}

if (process.env.NODE_ENV !== "test" && !process.env.NODE_TEST_CONTEXT) createServer().listen(Number(process.env.PORT) || 8080, "0.0.0.0");
