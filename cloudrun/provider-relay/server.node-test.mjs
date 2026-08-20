import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { endpointOf, headersFor, isPublicAddress, resolvePublicAddresses, verifyLicense, createServer } from "./server.mjs";

test("rejects non-HTTPS and credential-bearing endpoints", () => {
  assert.throws(() => endpointOf("http://example.com/v1"), /公网 HTTPS/);
  assert.throws(() => endpointOf("https://user:pass@example.com/v1"), /公网 HTTPS/);
  assert.throws(() => endpointOf("https://example.com/v1?api_key=secret"), /查询参数/);
  assert.equal(endpointOf("https://example.com/v1?tenant=demo").hostname, "example.com");
});

test("rejects private and reserved addresses", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "::1", "fc00::1", "fe80::1"]) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress("8.8.8.8"), true);
});

test("checks every DNS answer", async () => {
  await assert.rejects(() => resolvePublicAddresses("example.com", { lookup: async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }] }), /公网地址/);
  await assert.doesNotReject(() => resolvePublicAddresses("example.com", { lookup: async () => [{ address: "8.8.8.8", family: 4 }] }));
});

test("constructs only protocol-specific auth headers", () => {
  assert.deepEqual(headersFor("openai-compatible", "secret"), { "Content-Type": "application/json", Accept: "application/json, text/event-stream, application/x-ndjson", Authorization: "Bearer secret" });
  assert.equal(headersFor("gemini", "secret")["x-goog-api-key"], "secret");
  assert.equal(headersFor("claude", "secret")["x-api-key"], "secret");
  assert.equal(headersFor("claude", "secret").Authorization, undefined);
});

test("rejects invalid activation license before contacting an upstream", async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port; server.unref();
  try {
    const response = await fetch(`http://127.0.0.1:${port}`, { method: "POST", headers: { Origin: "http://localhost:5173", "Content-Type": "application/json" }, body: JSON.stringify({ version: 1, requestId: "test", operation: "chat", protocol: "openai-compatible", endpoint: "https://example.com/v1/chat/completions", apiKey: "PRIVATE_KEY", method: "POST", body: "PRIVATE_PROMPT", timeoutMs: 5000, activationLicense: {} }) });
    assert.equal(response.status, 401);
    const text = await response.text();
    assert.match(text, /relay-activation-invalid/);
    assert.doesNotMatch(text, /PRIVATE_KEY|PRIVATE_PROMPT|example\.com/);
  } finally { server.closeAllConnections?.(); server.closeIdleConnections?.(); server.close(); }
});

test("license verifier rejects malformed records", () => { assert.equal(verifyLicense(undefined), false); assert.equal(verifyLicense({ payload: { version: 1 }, signature: "x", publicKeyId: "x" }), false); });

test("verifies WebCrypto-compatible IEEE-P1363 license signatures", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicJwk = publicKey.export({ format: "jwk" });
  const payload = { version: 1, environmentId: "matchaphone-d5gjgy87ybfb50382", activationId: "activation-test", cloudbaseUid: "uid-test", deviceKeyHash: "device-test", issuedAt: 1_700_000_000_000, permanent: true };
  const canonical = JSON.stringify(payload);
  const signature = crypto.sign("sha256", Buffer.from(canonical), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  assert.equal(verifyLicense({ payload, signature, publicKeyId: "test-key" }, { publicJwk, publicKeyId: "test-key" }), true);
  const derSignature = crypto.sign("sha256", Buffer.from(canonical), { key: privateKey, dsaEncoding: "der" }).toString("base64url");
  assert.equal(verifyLicense({ payload, signature: derSignature, publicKeyId: "test-key" }, { publicJwk, publicKeyId: "test-key" }), false);
});
const testOrigin = "http://localhost:5173";
const fakeLicense = { payload: { version: 1, environmentId: "matchaphone-d5gjgy87ybfb50382", activationId: "test-activation", cloudbaseUid: "test-user", deviceKeyHash: "test-device", issuedAt: 1, permanent: true }, signature: "test", publicKeyId: "test" };
function relayRequest(overrides = {}) {
  return { version: 1, requestId: "client-request", operation: "chat", protocol: "openai-compatible", endpoint: "https://provider.example/v1/chat/completions", apiKey: "PRIVATE_API_KEY", method: "POST", body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "PRIVATE_PROMPT" }] }), timeoutMs: 5000, activationLicense: fakeLicense, ...overrides };
}
async function withRelay(options, callback) {
  const server = createServer({ resolver: { lookup: async () => [{ address: "8.8.8.8", family: 4 }] }, verifyLicenseImpl: () => true, logger: { info() {}, error() {} }, ...options });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port; server.unref();
  try { return await callback(`http://127.0.0.1:${port}`); }
  finally { server.closeAllConnections?.(); server.closeIdleConnections?.(); await new Promise(resolve => server.close(resolve)); }
}
async function callRelay(baseUrl, payload) {
  return fetch(baseUrl, { method: "POST", headers: { Origin: testOrigin, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
}

test("forwards JSON with protocol-owned auth and sanitized logs", async () => {
  let upstreamOptions; const logs = [];
  await withRelay({
    fetchImpl: async (_url, options) => { upstreamOptions = options; return new Response(JSON.stringify({ choices: [{ message: { content: "VISIBLE" } }] }), { status: 200, headers: { "Content-Type": "application/json" } }); },
    logger: { info(value) { logs.push(value); }, error(value) { logs.push(value); } },
  }, async baseUrl => {
    const response = await callRelay(baseUrl, relayRequest());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-upstream-status"), "200");
    assert.ok(Number(response.headers.get("x-upstream-bytes")) > 0);
    assert.match(await response.text(), /VISIBLE/);
  });
  assert.equal(upstreamOptions.headers.Authorization, "Bearer PRIVATE_API_KEY");
  assert.equal(upstreamOptions.redirect, "error");
  assert.match(String(upstreamOptions.body), /PRIVATE_PROMPT/);
  assert.doesNotMatch(logs.join("\n"), /PRIVATE_API_KEY|PRIVATE_PROMPT|provider\.example/);
});

test("preserves SSE and NDJSON response bodies", async t => {
  for (const fixture of [
    { name: "sse", contentType: "text/event-stream", body: "data: {\\\"choices\\\":[{\\\"delta\\\":{\\\"content\\\":\\\"A\\\"}}]}\\n\\ndata: [DONE]\\n\\n" },
    { name: "ndjson", contentType: "application/x-ndjson", body: "{\\\"choices\\\":[{\\\"delta\\\":{\\\"content\\\":\\\"A\\\"}}]}\\n{\\\"done\\\":true}\\n" },
  ]) await t.test(fixture.name, async () => {
    await withRelay({ fetchImpl: async () => new Response(fixture.body, { status: 200, headers: { "Content-Type": fixture.contentType } }) }, async baseUrl => {
      const response = await callRelay(baseUrl, relayRequest());
      assert.equal(response.headers.get("content-type"), fixture.contentType);
      assert.equal(await response.text(), fixture.body);
    });
  });
});

test("passes through upstream status and Retry-After", async () => {
  await withRelay({ fetchImpl: async () => new Response(JSON.stringify({ error: { code: "rate_limit" } }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "9" } }) }, async baseUrl => {
    const response = await callRelay(baseUrl, relayRequest());
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "9");
    assert.equal(response.headers.get("x-upstream-status"), "429");
  });
});

test("rejects oversized upstream responses before exposing a partial JSON body", async () => {
  await withRelay({ responseLimit: 4, fetchImpl: async () => new Response("12345", { status: 200, headers: { "Content-Type": "application/json" } }) }, async baseUrl => {
    const response = await callRelay(baseUrl, relayRequest());
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("x-relay-error-code"), "relay-response-too-large");
    assert.doesNotMatch(await response.text(), /12345/);
  });
});

test("rejects operation and upstream method mismatches without calling Provider", async () => {
  let called = false;
  await withRelay({ fetchImpl: async () => { called = true; return new Response("{}"); } }, async baseUrl => {
    const response = await callRelay(baseUrl, relayRequest({ operation: "models", method: "POST" }));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("x-relay-error-code"), "relay-invalid-request");
  });
  assert.equal(called, false);
});