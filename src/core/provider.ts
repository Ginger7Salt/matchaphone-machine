import type { ChatItem } from "./context";
import type { ApiErrorInfo, ApiErrorKind, ChatProviderCallPurpose, ProviderSettings } from "./types";
import {
  parseStructuredJson,
  parseStructuredJsonWithMeta,
  StructuredJsonError,
  type StructuredJsonDiagnostics,
  type StructuredJsonParseStatus,
  type StructuredJsonResult,
} from "./structuredJson";

export type ProviderErrorKind = ApiErrorKind | "aborted";
export interface ProviderErrorMetadata {
  httpStatus?: number;
  providerCode?: string;
  providerType?: string;
  param?: string;
  detail?: string;
  responseShape?: string;
  rawLength?: number;
  contentType?: string;
  visibleCandidatePaths?: string[];
  parseStatus?: StructuredJsonParseStatus;
  strictParseSucceeded?: boolean;
  repairAttempted?: boolean;
  repairedParseSucceeded?: boolean;
  outerContainerClosed?: boolean;
  unterminatedString?: boolean;
  hasMessages?: boolean;
  hasInnerVoice?: boolean;
  transportMarkedIncomplete?: boolean;
  protocolValidationReached?: boolean;
  failureStage?: "provider-parse" | "role-protocol" | "inner-voice" | "persistence";
}
export interface ProviderChatResult {
  text: string;
  finishReason?: string;
  truncated: boolean;
  responseShape: string;
  rawLength: number;
  outputTokens?: number;
  parseStatus?: StructuredJsonParseStatus;
  strictParseSucceeded?: boolean;
  repairAttempted?: boolean;
  repairedParseSucceeded?: boolean;
  outerContainerClosed?: boolean;
  unterminatedString?: boolean;
  hasMessages?: boolean;
  hasInnerVoice?: boolean;
  transportMarkedIncomplete?: boolean;
  protocolValidationReached?: boolean;
}
export interface ProviderChatOptions {
  signal?: AbortSignal;
  onToken?: (value: string) => void;
  stream?: boolean;
  temperature?: number;
  /** null disables the provider-owned timeout while preserving caller cancellation. */
  timeoutMs?: number | null;
}
export type ProviderChatInvoker = (
  settings: ProviderSettings,
  messages: ChatItem[],
  options: ProviderChatOptions,
  purpose: ChatProviderCallPurpose,
) => Promise<ProviderChatResult>;
export class ProviderError extends Error {
  constructor(
    public kind: ProviderErrorKind,
    message: string,
    public partial = "",
    public apiError?: ApiErrorInfo,
  ) {
    super(message);
  }
}

const MAX_ERROR_DETAIL = 800;
const WRAPPER_KEYS = ["data", "result", "response", "body", "payload"] as const;
const TEXT_KEYS = [
  "content",
  "reply",
  "output_text",
  "text",
  "completion",
  "generated_text",
  "answer",
  "response_text",
] as const;
const HIDDEN_TYPES = new Set(["reasoning", "analysis", "thinking"]);
const TOOL_TYPES = new Set(["tool_call", "tool_calls", "function_call", "function"]);
type JsonRecord = Record<string, unknown>;
interface ExtractionSignals {
  reasoning: boolean;
  tool: boolean;
  refusal?: string;
  structuredDiagnostics?: StructuredJsonDiagnostics;
}
class ProviderResponseParseError extends Error {
  constructor(
    public readonly kind: ApiErrorKind,
    message: string,
    public readonly meta: ProviderErrorMetadata,
  ) {
    super(message);
    this.name = "ProviderResponseParseError";
  }
}
function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function cleanScalar(value: unknown, max = 160) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : undefined;
}
export function sanitizeApiErrorText(value: unknown, secrets: string[] = []) {
  let text = (typeof value === "string" ? value : JSON.stringify(value ?? "")).slice(0, 4000);
  for (const secret of secrets)
    if (secret && secret.length >= 6) text = text.split(secret).join("[REDACTED]");
  return text
    .replace(/("(?:messages|prompt|input|system_prompt)"\s*:\s*)(?:\[[\s\S]{0,2500}?\]|"[^"]{0,2500}")/gi, '$1"[REDACTED]"')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_API_KEY]")
    .replace(/((?:api[-_ ]?key|authorization)\s*[:=]\s*)[^\s,;"']+/gi, "$1[REDACTED]")
    .replace(/<[^>]{1,200}>/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ERROR_DETAIL);
}
function parseNestedStringWithMeta(value: string): StructuredJsonResult | undefined {
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("[") && !trimmed.startsWith('"') && !trimmed.startsWith("```")))
    return undefined;
  try {
    const parsed = parseStructuredJsonWithMeta(trimmed);
    return parsed.value === value ? undefined : parsed;
  } catch {
    return undefined;
  }
}
function parseNestedString(value: string): unknown {
  return parseNestedStringWithMeta(value)?.value;
}
function safeJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
function structuredDiagnosticMeta(
  diagnostics?: StructuredJsonDiagnostics,
): Pick<
  ProviderErrorMetadata,
  | "parseStatus"
  | "strictParseSucceeded"
  | "repairAttempted"
  | "repairedParseSucceeded"
  | "outerContainerClosed"
  | "unterminatedString"
  | "hasMessages"
  | "hasInnerVoice"
  | "transportMarkedIncomplete"
  | "protocolValidationReached"
> {
  if (!diagnostics) return {};
  return {
    parseStatus: diagnostics.parseStatus,
    strictParseSucceeded: diagnostics.strictParseSucceeded,
    repairAttempted: diagnostics.repairAttempted,
    repairedParseSucceeded: diagnostics.repairedParseSucceeded,
    outerContainerClosed: diagnostics.outerContainerClosed,
    unterminatedString: diagnostics.unterminatedString,
    hasMessages: diagnostics.hasMessages,
    hasInnerVoice: diagnostics.hasInnerVoice,
    transportMarkedIncomplete: diagnostics.transportMarkedIncomplete,
    protocolValidationReached: diagnostics.protocolValidationReached,
  };
}
function replyRowLike(value: unknown) {
  if (typeof value === "string") return Boolean(value.trim());
  if (!isRecord(value)) return false;
  return ["content", "message", "reply"].some((key) => typeof value[key] === "string");
}
function directRoleProtocolText(value: unknown) {
  if (Array.isArray(value)) {
    if (!value.length || !value.every(replyRowLike)) return undefined;
    return safeJson(value);
  }
  if (!isRecord(value)) return undefined;
  if (Array.isArray(value.messages)) return safeJson(value);
  if (value.innerVoice !== undefined && ["content", "message", "reply"].some((key) => value[key] !== undefined))
    return safeJson(value);
  return undefined;
}
function addCandidate(paths: string[], path: string) {
  if (path && !paths.includes(path) && paths.length < 24) paths.push(path);
}
function visibleArrayText(
  value: unknown[],
  path: string,
  depth: number,
  paths: string[],
  signals: ExtractionSignals,
) {
  const parts: string[] = [];
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (typeof item === "string") {
      if (item.trim()) {
        addCandidate(paths, itemPath);
        parts.push(item);
      }
      return;
    }
    if (!isRecord(item)) return;
    const type = cleanScalar(item.type, 80)?.toLowerCase();
    if (type && HIDDEN_TYPES.has(type)) {
      signals.reasoning = true;
      return;
    }
    if (type && TOOL_TYPES.has(type)) {
      signals.tool = true;
      return;
    }
    if (type === "refusal") {
      signals.refusal = cleanScalar(item.refusal ?? item.text ?? item.content, MAX_ERROR_DETAIL) ?? signals.refusal;
      return;
    }
    const text =
      typeof item.text === "string"
        ? item.text
        : isRecord(item.text) && typeof item.text.value === "string"
          ? item.text.value
          : typeof item.output_text === "string"
            ? item.output_text
            : typeof item.content === "string"
              ? item.content
              : visibleTextOf(item, itemPath, depth + 1, paths, signals);
    if (text?.trim()) {
      addCandidate(paths, `${itemPath}.${typeof item.text === "string" ? "text" : typeof item.output_text === "string" ? "output_text" : "content"}`);
      parts.push(text);
    }
  });
  return parts.length ? parts.join("") : undefined;
}
function choiceText(
  choice: unknown,
  path = "choices[0]",
  paths: string[] = [],
  signals: ExtractionSignals = { reasoning: false, tool: false },
) {
  if (!isRecord(choice)) return undefined;
  const message = isRecord(choice.message) ? choice.message : undefined;
  const delta = isRecord(choice.delta) ? choice.delta : undefined;
  if (typeof message?.refusal === "string" && message.refusal.trim()) signals.refusal = message.refusal;
  if (message?.reasoning_content !== undefined || choice.reasoning_content !== undefined) signals.reasoning = true;
  if (message?.tool_calls !== undefined || message?.function_call !== undefined || choice.tool_calls !== undefined) signals.tool = true;
  const candidates: Array<[unknown, string]> = [
    [message?.content, `${path}.message.content`],
    [delta?.content, `${path}.delta.content`],
    [choice.text, `${path}.text`],
  ];
  for (const [candidate, candidatePath] of candidates) {
    const text =
      typeof candidate === "string"
        ? candidate.trim() || undefined
        : Array.isArray(candidate)
          ? visibleArrayText(candidate, candidatePath, 0, paths, signals)
          : undefined;
    if (text) {
      addCandidate(paths, candidatePath);
      return text;
    }
  }
  return undefined;
}
function visibleTextOf(
  value: unknown,
  path: string,
  depth: number,
  paths: string[],
  signals: ExtractionSignals,
): string | undefined {
  if (depth > 12) return undefined;
  if (typeof value === "string") {
    const nested = parseNestedStringWithMeta(value);
    if (nested !== undefined) {
      signals.structuredDiagnostics = nested.diagnostics;
      return visibleTextOf(nested.value, `${path}.json`, depth + 1, paths, signals);
    }
    if (value.trim()) {
      addCandidate(paths, path);
      return value;
    }
    return undefined;
  }
  const protocol = directRoleProtocolText(value);
  if (protocol) {
    addCandidate(paths, path || "$direct");
    return protocol;
  }
  if (Array.isArray(value)) return visibleArrayText(value, path, depth + 1, paths, signals);
  if (!isRecord(value)) return undefined;
  if (value.error !== undefined && !Array.isArray(value.messages)) return undefined;
  if (value.reasoning_content !== undefined || value.reasoning !== undefined || value.analysis !== undefined || value.thinking !== undefined)
    signals.reasoning = true;
  if (value.tool_calls !== undefined || value.function_call !== undefined || value.tool_call !== undefined) signals.tool = true;
  if (typeof value.refusal === "string" && value.refusal.trim()) signals.refusal = value.refusal;
  const promptFeedback = isRecord(value.promptFeedback) ? value.promptFeedback : undefined;
  const blockReason = cleanScalar(promptFeedback?.blockReason ?? value.block_reason ?? value.blockReason, MAX_ERROR_DETAIL);
  if (blockReason) signals.refusal = blockReason;

  if (Array.isArray(value.choices)) {
    for (let index = 0; index < value.choices.length; index++) {
      const text = choiceText(value.choices[index], `${path ? `${path}.` : ""}choices[${index}]`, paths, signals);
      if (text) return text;
    }
  }
  if (Array.isArray(value.output)) {
    const text = visibleArrayText(value.output, `${path ? `${path}.` : ""}output`, depth + 1, paths, signals);
    if (text) return text;
  } else if (typeof value.output === "string") {
    const text = visibleTextOf(value.output, `${path ? `${path}.` : ""}output`, depth + 1, paths, signals);
    if (text) return text;
  }
  if (Array.isArray(value.candidates)) {
    for (let index = 0; index < value.candidates.length; index++) {
      const candidate = value.candidates[index];
      if (!isRecord(candidate)) continue;
      const content = isRecord(candidate.content) ? candidate.content : undefined;
      const parts = Array.isArray(content?.parts) ? content.parts : Array.isArray(candidate.parts) ? candidate.parts : undefined;
      if (!parts) continue;
      const text = visibleArrayText(parts, `${path ? `${path}.` : ""}candidates[${index}].content.parts`, depth + 1, paths, signals);
      if (text) return text;
    }
  }
  if (isRecord(value.message)) {
    const messagePath = `${path ? `${path}.` : ""}message`;
    const message = value.message;
    if (typeof message.refusal === "string" && message.refusal.trim()) signals.refusal = message.refusal;
    if (message.reasoning_content !== undefined || message.reasoning !== undefined) signals.reasoning = true;
    if (message.tool_calls !== undefined || message.function_call !== undefined) signals.tool = true;
    const content = message.content;
    const text =
      typeof content === "string"
        ? content.trim() || undefined
        : Array.isArray(content)
          ? visibleArrayText(content, `${messagePath}.content`, depth + 1, paths, signals)
          : undefined;
    if (text) {
      addCandidate(paths, `${messagePath}.content`);
      return text;
    }
  } else if (typeof value.message === "string" && value.message.trim()) {
    addCandidate(paths, `${path ? `${path}.` : ""}message`);
    return value.message.trim();
  }
  for (const key of TEXT_KEYS) {
    const candidate = value[key];
    if (candidate === undefined) continue;
    const text =
      typeof candidate === "string"
        ? visibleTextOf(candidate, `${path ? `${path}.` : ""}${key}`, depth + 1, paths, signals)
        : Array.isArray(candidate)
          ? visibleArrayText(candidate, `${path ? `${path}.` : ""}${key}`, depth + 1, paths, signals)
          : undefined;
    if (text) return text;
  }
  for (const key of WRAPPER_KEYS) {
    const wrapped = value[key];
    if (wrapped === undefined) continue;
    const text = visibleTextOf(wrapped, `${path ? `${path}.` : ""}${key}`, depth + 1, paths, signals);
    if (text) return text;
  }
  return undefined;
}
function finishReasonOf(value: unknown, depth = 0): string | undefined {
  if (depth > 8 || !value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = finishReasonOf(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  const row = value as JsonRecord;
  const direct = cleanScalar(row.finish_reason ?? row.finishReason ?? row.stop_reason ?? row.stopReason ?? row.status, 120);
  if (direct) return direct;
  const incomplete = row.incomplete_details;
  if (isRecord(incomplete)) {
    const reason = cleanScalar(incomplete.reason, 120);
    if (reason) return reason;
  }
  for (const key of [...WRAPPER_KEYS, "choices", "output", "candidates"]) {
    const found = finishReasonOf(row[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}
function outputTokensOf(value: unknown, depth = 0): number | undefined {
  if (depth > 8 || !value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = outputTokensOf(item, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const row = value as JsonRecord;
  const usage = isRecord(row.usage) ? row.usage : undefined;
  const candidate = usage?.completion_tokens ?? usage?.output_tokens ?? row.completion_tokens ?? row.output_tokens;
  if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  for (const key of WRAPPER_KEYS) {
    const found = outputTokensOf(row[key], depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}
function responseShapeOf(value: unknown): string {
  if (Array.isArray(value)) return directRoleProtocolText(value) ? "direct-role-array" : "array";
  if (!value || typeof value !== "object") return typeof value;
  const row = value as JsonRecord;
  if (Array.isArray(row.messages)) return "direct-role-json";
  if (Array.isArray(row.choices)) return "choices";
  if (Array.isArray(row.output)) return "responses-output";
  for (const key of WRAPPER_KEYS) if (row[key] !== undefined) return `wrapper:${key}`;
  if (Array.isArray(row.candidates)) return "gemini-candidates";
  if (Array.isArray(row.content)) return "content-array";
  if (isRecord(row.message)) return "message-object";
  return `object:${Object.keys(row).slice(0, 8).sort().join(",")}`;
}
function truncatedOf(reason?: string) {
  return Boolean(reason && /length|max[_ -]?tokens?|context|incomplete|truncat/i.test(reason));
}
function errorRecordOf(value: unknown): JsonRecord | undefined {
  if (!isRecord(value) || Array.isArray(value.messages)) return undefined;
  if (isRecord(value.error)) return value.error;
  if (typeof value.error === "string") return { message: value.error };
  const status = cleanScalar(value.status, 60)?.toLowerCase();
  if (status === "error" || status === "failed" || value.success === false || value.ok === false) return value;
  return undefined;
}
function wrappedErrorOf(value: unknown, path = "", depth = 0): { error: JsonRecord; path: string } | undefined {
  if (depth > 8) return undefined;
  const direct = errorRecordOf(value);
  if (direct) return { error: direct, path: path || "$" };
  if (!isRecord(value)) return undefined;
  for (const key of WRAPPER_KEYS) {
    const wrapped = value[key];
    if (wrapped === undefined) continue;
    const nested = typeof wrapped === "string" ? parseNestedString(wrapped) ?? wrapped : wrapped;
    const found = wrappedErrorOf(nested, `${path ? `${path}.` : ""}${key}`, depth + 1);
    if (found) return found;
  }
  return undefined;
}
function kindOfSuccessfulError(value: JsonRecord): ApiErrorKind {
  const text = [value.code, value.type, value.message, value.detail].map((item) => cleanScalar(item, 240)).filter(Boolean).join(" ");
  if (/auth|unauthor|forbidden|api.?key|permission/i.test(text)) return "auth";
  if (/rate|quota|billing|credit|limit/i.test(text)) return "rate";
  if (/model|not.?found/i.test(text)) return "model";
  if (/timeout|timed.?out/i.test(text)) return "timeout";
  if (/server|gateway|unavailable|overload/i.test(text)) return "server";
  return "format";
}
function parseSseOrNdjson(raw: string, mode: "sse" | "ndjson", contentType?: string): ProviderChatResult | undefined {
  const chunks: string[] = [];
  let finishReason: string | undefined;
  let outputTokens: number | undefined;
  const visibleCandidatePaths: string[] = [];
  const signals: ExtractionSignals = { reasoning: false, tool: false };
  const rows = raw.replace(/\r\n/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean);
  let parsedCount = 0;
  for (const row of rows) {
    if (mode === "sse" && !row.startsWith("data:")) continue;
    const text = mode === "sse" ? row.slice(5).trim() : row;
    if (!text || text === "[DONE]") continue;
    try {
      const value = JSON.parse(text) as unknown;
      parsedCount += 1;
      const error = errorRecordOf(value);
      if (error) {
        const detail = cleanScalar(error.message ?? error.detail, MAX_ERROR_DETAIL) ?? "服务返回了错误结果";
        throw new ProviderResponseParseError(kindOfSuccessfulError(error), detail, {
          providerCode: cleanScalar(error.code, 120) ?? "provider_error",
          providerType: cleanScalar(error.type, 120),
          detail,
          responseShape: `${mode}-error`,
          rawLength: raw.length,
          contentType,
          visibleCandidatePaths,
        });
      }
      const visible = visibleTextOf(value, `${mode}[${parsedCount - 1}]`, 0, visibleCandidatePaths, signals);
      if (visible) chunks.push(visible);
      finishReason = finishReasonOf(value) ?? finishReason;
      outputTokens = outputTokensOf(value) ?? outputTokens;
    } catch (error) {
      if (error instanceof ProviderResponseParseError) throw error;
    }
  }
  if (!parsedCount || !chunks.length) return undefined;
  return {
    text: chunks.join(""),
    finishReason,
    truncated: truncatedOf(finishReason),
    responseShape: mode,
    rawLength: raw.length,
    outputTokens,
  };
}
function parseChatResponse(raw: string, contentType?: string, secrets: string[] = []): ProviderChatResult {
  const trimmed = raw.replace(/^\uFEFF/, "").trim();
  if (!trimmed)
    throw new ProviderResponseParseError("format", "服务返回了空响应", {
      providerCode: "empty_response",
      detail: "HTTP 请求成功，但响应正文为空",
      responseShape: "empty",
      rawLength: raw.length,
      contentType,
      visibleCandidatePaths: [],
    });
  if (/text\/html/i.test(contentType ?? "") || /^\s*(?:<!doctype\s+html|<html\b|<body\b)/i.test(trimmed))
    throw new ProviderResponseParseError("format", "服务返回了网页而不是 API 数据", {
      providerCode: "html_response",
      detail: "接口返回了 HTML、登录页或网关页面",
      responseShape: "html",
      rawLength: raw.length,
      contentType,
      visibleCandidatePaths: [],
    });
  if (/^\s*(?:data|event):/m.test(trimmed)) {
    const streamed = parseSseOrNdjson(trimmed, "sse", contentType);
    if (streamed) return streamed;
  }
  const ndjsonLines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (ndjsonLines.length > 1 && ndjsonLines.every((line) => {
    try { JSON.parse(line); return true; } catch { return false; }
  })) {
    const ndjson = parseSseOrNdjson(trimmed, "ndjson", contentType);
    if (ndjson) return ndjson;
  }

  let data: unknown;
  let structuredDiagnostics: StructuredJsonDiagnostics | undefined;
  try {
    const parsed = parseStructuredJsonWithMeta(trimmed);
    data = parsed.value;
    structuredDiagnostics = parsed.diagnostics;
  } catch (error) {
    const looksStructured = /^[\[{]/.test(trimmed) || /^```/i.test(trimmed);
    if (!looksStructured) {
      return { text: trimmed, truncated: false, responseShape: "plain-text", rawLength: raw.length };
    }
    const structuredError = error instanceof StructuredJsonError ? error : undefined;
    const truncated = structuredError?.reason === "incomplete";
    throw new ProviderResponseParseError(
      "format",
      truncated ? "服务返回内容被截断或结构不完整" : "服务返回的数据格式无法识别",
      {
        providerCode: truncated ? "truncated_json" : "invalid_json",
        detail: truncated
          ? "响应在字符串、字段或容器结束前中断，无法恢复完整角色数据"
          : "响应看起来是结构化数据，但无法通过确定性 JSON 修复",
        responseShape: truncated ? "truncated-json" : "malformed-json",
        rawLength: raw.length,
        contentType,
        visibleCandidatePaths: [],
        failureStage: "provider-parse",
        ...structuredDiagnosticMeta(structuredError?.diagnostics),
      },
    );
  }
  for (let depth = 0; depth < 5 && typeof data === "string"; depth++) {
    const nested = parseNestedStringWithMeta(data);
    if (nested === undefined) break;
    data = nested.value;
    structuredDiagnostics = nested.diagnostics;
  }
  const responseShape = responseShapeOf(data);
  const visibleCandidatePaths: string[] = [];
  const wrappedError = wrappedErrorOf(data);
  if (wrappedError) {
    const parsed = parsedErrorBody(safeJson({ error: wrappedError.error }) ?? "", secrets);
    const detail = parsed.message || "\u670d\u52a1\u8fd4\u56de\u4e86\u9519\u8bef\u7ed3\u679c";
    throw new ProviderResponseParseError(kindOfSuccessfulError(wrappedError.error), detail, {
      providerCode: parsed.providerCode ?? "provider_error",
      providerType: parsed.providerType,
      param: parsed.param,
      detail,
      responseShape: `${responseShape}:error@${wrappedError.path}`,
      rawLength: raw.length,
      contentType,
      visibleCandidatePaths,
      ...structuredDiagnosticMeta(structuredDiagnostics),
    });
  }
  const signals: ExtractionSignals = { reasoning: false, tool: false };
  const text = visibleTextOf(data, "", 0, visibleCandidatePaths, signals);
  if (!text) {
    const providerCode = signals.refusal ? "provider_refusal" : signals.reasoning ? "reasoning_only" : signals.tool ? "tool_only_response" : "invalid_response";
    const detail = signals.refusal
      ? sanitizeApiErrorText(signals.refusal, secrets) || "服务拒绝了本次请求"
      : signals.reasoning
        ? "服务只返回了推理内容，没有返回可见正文"
        : signals.tool
          ? "服务只返回了工具调用，没有返回可见正文"
          : `响应结构无法提取正文；长度 ${raw.length}`;
    throw new ProviderResponseParseError("format", detail, {
      providerCode,
      detail,
      responseShape,
      rawLength: raw.length,
      contentType,
      visibleCandidatePaths,
      failureStage: "provider-parse",
      ...structuredDiagnosticMeta(structuredDiagnostics),
    });
  }
  const finishReason = finishReasonOf(data);
  return {
    text,
    finishReason,
    truncated: truncatedOf(finishReason),
    responseShape,
    rawLength: raw.length,
    outputTokens: outputTokensOf(data),
    ...structuredDiagnosticMeta(signals.structuredDiagnostics ?? structuredDiagnostics),
  };
}

function parsedErrorBody(text: string, secrets: string[]) {
  let value: unknown;
  try { value = JSON.parse(text); } catch { value = undefined; }
  const root = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  const nested = root?.error && typeof root.error === "object" ? (root.error as Record<string, unknown>) : undefined;
  const source = nested ?? root;
  const message = cleanScalar(source?.message ?? source?.detail ?? root?.message ?? root?.detail, MAX_ERROR_DETAIL);
  const providerCode = sanitizeApiErrorText(cleanScalar(source?.code ?? root?.code, 120) ?? "", secrets) || undefined;
  const providerType = sanitizeApiErrorText(cleanScalar(source?.type ?? root?.type, 120) ?? "", secrets) || undefined;
  const param = sanitizeApiErrorText(cleanScalar(source?.param ?? root?.param, 120) ?? "", secrets) || undefined;
  const fallback = sanitizeApiErrorText(text, secrets);
  return { message: sanitizeApiErrorText(message ?? fallback, secrets), providerCode, providerType, param };
}
function meaningOf(kind: ApiErrorKind, status?: number, providerCode?: string) {
  if (providerCode === "truncated_json") return "服务返回内容被截断或结构不完整";
  if (providerCode === "missing_messages") return "角色回复缺少完整正文消息";
  if (providerCode === "missing_inner_voice") return "角色回复缺少完整心声";
  if (providerCode === "invalid_role_protocol") return "服务返回的 JSON 未通过角色回复协议校验";
  if (status === 400 || status === 413 || status === 422) return "请求参数、上下文长度或服务兼容格式不正确";
  if (kind === "auth") return "API Key 无效、已过期或当前账户没有访问权限";
  if (kind === "model") return "接口地址或模型名称不存在";
  if (kind === "rate") return "调用频率受限，或账户余额与额度不足";
  if (kind === "timeout") return "API 请求在设定时间内没有完成";
  if (kind === "cors") return "浏览器无法跨域访问当前 API 服务";
  if (kind === "network") return "无法连接 API 服务，可能是网络、DNS、证书或代理问题";
  if (kind === "server") return "API 服务端暂时异常";
  if (kind === "interrupted") return "API 返回过程在完成前中断";
  return "API 返回的数据无法按兼容格式识别";
}
function troubleshootingOf(kind: ApiErrorKind, status?: number, providerCode?: string) {
  if (providerCode === "truncated_json")
    return ["重新生成完整回复。", "检查服务商是否提前结束输出或截断响应。", "若问题持续，请复制脱敏诊断信息。"];
  if (providerCode === "missing_messages")
    return ["重新生成完整回复。", "服务返回的 JSON 缺少非空 messages 数组。", "若问题持续，请复制脱敏诊断信息。"];
  if (providerCode === "missing_inner_voice")
    return ["重新生成完整回复。", "服务返回的 JSON 缺少完整心声结构。", "若问题持续，请复制脱敏诊断信息。"];
  if (providerCode === "invalid_role_protocol")
    return ["重新生成完整回复。", "服务已返回 JSON，但未满足角色回复协议。", "若问题持续，请复制脱敏诊断信息。"];
  if (status === 400 || status === 413 || status === 422)
    return ["确认当前模型支持聊天补全接口和所发送的消息格式。", "若挂载了大量世界书或历史消息，请减少上下文后重试。", "确认中转服务兼容 OpenAI /chat/completions 请求格式。"]; 
  if (kind === "auth") return ["重新检查并保存 API Key。", "确认该 Key 有权访问当前模型。", "检查 Base URL 是否属于该 API Key 对应的服务商。"]; 
  if (kind === "model") return ["重新拉取模型列表或核对模型名称。", "检查 Base URL 是否重复或遗漏 /v1。", "确认服务商支持 /chat/completions。"]; 
  if (kind === "rate") return ["检查账户余额、额度和账单状态。", "稍后重试并减少并发请求。", "确认模型是否有独立速率限制。"]; 
  if (kind === "timeout") return ["确认网络和 API 服务状态。", "稍后重试。", "减少过长的上下文内容。"]; 
  if (kind === "cors") return ["更换明确支持浏览器 CORS 的 API 服务。", "检查服务端是否允许当前网站域名。", "不要在浏览器中关闭安全限制。"]; 
  if (kind === "server") return ["稍后重试。", "查看服务商状态页或中转日志。", "必要时切换其他模型。"]; 
  if (kind === "interrupted") return ["重新生成本轮回复。", "检查网络是否切换或 PWA 是否被系统挂起。", "必要时关闭流式响应。"]; 
  return ["重试本轮生成。", "确认中转返回 OpenAI 兼容 JSON。", "若问题持续，请复制脱敏诊断信息。"]; 
}
export function createApiErrorInfo(kind: ApiErrorKind, meta: ProviderErrorMetadata = {}): ApiErrorInfo {
  return {
    source: "api",
    kind,
    httpStatus: meta.httpStatus,
    providerCode: meta.providerCode,
    providerType: meta.providerType,
    param: meta.param,
    meaning: meaningOf(kind, meta.httpStatus, meta.providerCode),
    detail: meta.detail,
    responseShape: meta.responseShape,
    rawLength: meta.rawLength,
    contentType: meta.contentType,
    visibleCandidatePaths: meta.visibleCandidatePaths,
    parseStatus: meta.parseStatus,
    strictParseSucceeded: meta.strictParseSucceeded,
    repairAttempted: meta.repairAttempted,
    repairedParseSucceeded: meta.repairedParseSucceeded,
    outerContainerClosed: meta.outerContainerClosed,
    unterminatedString: meta.unterminatedString,
    hasMessages: meta.hasMessages,
    hasInnerVoice: meta.hasInnerVoice,
    transportMarkedIncomplete: meta.transportMarkedIncomplete,
    protocolValidationReached: meta.protocolValidationReached,
    failureStage: meta.failureStage,
    troubleshooting: troubleshootingOf(kind, meta.httpStatus, meta.providerCode),
  };
}
export function apiErrorInfoOf(error: unknown) {
  return error instanceof ProviderError ? error.apiError : undefined;
}
export function isContextOverflowError(error: unknown) {
  if (!(error instanceof ProviderError)) return false;
  const info = error.apiError;
  const text = [error.message, info?.detail, info?.providerCode, info?.providerType, info?.param].filter(Boolean).join(" ");
  return Boolean((info?.httpStatus === 400 || info?.httpStatus === 413 || info?.httpStatus === 422) && /context|token|length|too long|maximum|上下文|长度|超出/i.test(text));
}

export class OpenAIProvider {
  constructor(private settings: ProviderSettings) {}
  private base() { return this.settings.baseUrl.replace(/\/$/, ""); }
  private failure(kind: ApiErrorKind, message: string, partial = "", meta: ProviderErrorMetadata = {}) {
    return new ProviderError(kind, message, partial, createApiErrorInfo(kind, meta));
  }
  private mapStatus(status: number, text = "") {
    const parsed = parsedErrorBody(text, [this.settings.apiKey]);
    const kind: ApiErrorKind = status === 401 || status === 403 ? "auth" : status === 404 ? "model" : status === 408 ? "timeout" : status === 429 ? "rate" : status >= 500 ? "server" : "format";
    const fallback = status === 401 || status === 403 ? "API Key 无效或无权限" : status === 404 ? "接口或模型不存在" : status === 408 ? "请求超时" : status === 429 ? "调用频率或额度已达上限" : status >= 500 ? `服务暂时不可用 (${status})` : `请求失败 (${status})`;
    const detail = parsed.message && parsed.message !== "error" ? parsed.message : fallback;
    return this.failure(kind, detail, "", { httpStatus: status, providerCode: parsed.providerCode, providerType: parsed.providerType, param: parsed.param, detail });
  }
  async chatWithMeta(messages: ChatItem[], opts: ProviderChatOptions = {}): Promise<ProviderChatResult> {
    const controller = new AbortController();
    const timeoutMs = opts.timeoutMs === undefined ? this.settings.timeoutMs : opts.timeoutMs;
    const timer = timeoutMs === null ? undefined : setTimeout(() => controller.abort("timeout"), timeoutMs);
    const abort = () => controller.abort("user");
    opts.signal?.addEventListener("abort", abort, { once: true });
    const stream = opts.stream ?? this.settings.stream;
    let out = "";
    try {
      const payloadMessages = messages.map(({ imageUrl, imageUrls, ...message }) => {
        const urls = [...(imageUrls ?? []), ...(imageUrl ? [imageUrl] : [])];
        return urls.length ? { ...message, content: [{ type: "text", text: message.content }, ...urls.map((url) => ({ type: "image_url", image_url: { url } }))] } : message;
      });
      const response = await fetch(this.base() + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + this.settings.apiKey },
        body: JSON.stringify({ model: this.settings.model, messages: payloadMessages, temperature: opts.temperature ?? this.settings.temperature, stream }),
        signal: controller.signal,
      });
      if (!response.ok) throw this.mapStatus(response.status, await response.text());
      if (!stream) {
        const raw = await response.text();
        const contentType = response.headers.get("Content-Type") ?? undefined;
        let result: ProviderChatResult;
        try {
          result = parseChatResponse(raw, contentType, [this.settings.apiKey]);
        } catch (error) {
          if (error instanceof ProviderResponseParseError)
            throw this.failure(error.kind, error.message, "", error.meta);
          throw this.failure("format", "\u670d\u52a1\u8fd4\u56de\u7684\u6570\u636e\u683c\u5f0f\u65e0\u6cd5\u8bc6\u522b\uff0c\u7f3a\u5c11\u53ef\u7528\u6b63\u6587", "", {
            providerCode: "invalid_response",
            detail: `\u54cd\u5e94\u7ed3\u6784\u65e0\u6cd5\u63d0\u53d6\u6b63\u6587\uff1b\u957f\u5ea6 ${raw.length}`,
            responseShape: "unknown",
            rawLength: raw.length,
            contentType,
            visibleCandidatePaths: [],
          });
        }
        opts.onToken?.(result.text);
        return result;
      }
      if (!response.body) throw this.failure("format", "服务没有返回数据流", "", { providerCode: "missing_stream_body" });
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = "", doneMarker = false, finishReason: string | undefined, outputTokens: number | undefined;
      while (true) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try { chunk = await reader.read(); }
        catch { throw this.failure("interrupted", "数据流意外中断", out, { providerCode: "stream_interrupted" }); }
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
        let split: number;
        while ((split = buffer.indexOf("\n\n")) >= 0) {
          const event = buffer.slice(0, split); buffer = buffer.slice(split + 2);
          for (const line of event.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const raw = line.slice(5).trim();
            if (!raw) continue;
            if (raw === "[DONE]") { doneMarker = true; continue; }
            try {
              const value = JSON.parse(raw) as unknown;
              const paths: string[] = [];
              const signals: ExtractionSignals = { reasoning: false, tool: false };
              const token = visibleTextOf(value, "stream", 0, paths, signals) ?? "";
              finishReason = finishReasonOf(value) ?? finishReason;
              outputTokens = outputTokensOf(value) ?? outputTokens;
              if (token) { out += token; opts.onToken?.(token); }
            } catch {}
          }
        }
      }
      if (!out) throw this.failure("format", "数据流已结束，但没有生成正文", "", { providerCode: "empty_stream" });
      if (!doneMarker && !finishReason) throw this.failure("interrupted", "数据流在完成前中断", out, { providerCode: "missing_done_marker" });
      return { text: out, finishReason, truncated: truncatedOf(finishReason), responseShape: "stream", rawLength: out.length, outputTokens };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (controller.signal.aborted) {
        if (controller.signal.reason === "timeout") throw this.failure("timeout", "请求超时", out, { providerCode: "request_timeout" });
        throw new ProviderError("aborted", "生成已停止", out);
      }
      if (error instanceof TypeError) throw this.failure("cors", "网络或跨域请求失败，请确认 API 支持浏览器 CORS", out, { providerCode: "cors_or_fetch_failed", detail: error.message });
      throw this.failure("network", error instanceof Error ? error.message : "网络请求失败", out, { providerCode: "network_error", detail: error instanceof Error ? error.message : undefined });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
    }
  }
  async chat(messages: ChatItem[], opts: ProviderChatOptions = {}) {
    return (await this.chatWithMeta(messages, opts)).text;
  }
  async models() {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort("timeout"), this.settings.timeoutMs);
    try {
      const response = await fetch(this.base() + "/models", { headers: { Authorization: "Bearer " + this.settings.apiKey }, signal: controller.signal });
      if (!response.ok) throw this.mapStatus(response.status, await response.text());
      let data: unknown;
      try { data = parseStructuredJson(await response.text()); }
      catch { throw this.failure("format", "服务返回了无法识别的模型列表", "", { providerCode: "invalid_json" }); }
      const raw = (data as { data?: unknown })?.data;
      if (!Array.isArray(raw)) throw this.failure("format", "服务返回了无法识别的模型列表", "", { providerCode: "invalid_model_list" });
      const ids = raw.map((item) => (item as { id?: unknown }).id).filter((id): id is string => typeof id === "string");
      return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (controller.signal.aborted) throw this.failure("timeout", "请求超时", "", { providerCode: "request_timeout" });
      if (error instanceof TypeError) throw this.failure("cors", "网络或跨域请求失败，请确认 API 支持浏览器 CORS", "", { providerCode: "cors_or_fetch_failed", detail: error.message });
      throw this.failure("network", error instanceof Error ? error.message : "拉取模型失败", "", { providerCode: "network_error", detail: error instanceof Error ? error.message : undefined });
    } finally { clearTimeout(timer); }
  }
  async test() { return this.chat([{ role: "user", content: "只回复 OK" }], { stream: false }); }
}



