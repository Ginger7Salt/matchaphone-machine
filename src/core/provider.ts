import type { ChatItem } from "./context";
import type { ApiErrorInfo, ApiErrorKind, ChatProviderCallPurpose, ChatProviderTailKind, ChatProviderTransportMode, ChatReplyWireFormat, ProviderSettings, ReplyBubbleCountDiagnostics } from "./types";
import {
  parseStructuredJson,
  parseStructuredJsonWithMeta,
  replyProtocolPresenceOf,
  StructuredJsonError,
  type StructuredJsonDiagnostics,
  type StructuredJsonParseStatus,
  type StructuredJsonResult,
} from "./structuredJson";

export type ProviderErrorKind = ApiErrorKind | "aborted";
export interface ProviderErrorMetadata {
  httpStatus?: number;
  retryAfterSeconds?: number;
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
  wireFormat?: ChatReplyWireFormat;
  transportMarkedIncomplete?: boolean;
  protocolValidationReached?: boolean;
  transportMode?: ChatProviderTransportMode;
  receivedChars?: number;
  receivedBytes?: number;
  declaredContentLength?: number;
  contentLengthMatched?: boolean;
  completeVisibleFieldRecovered?: boolean;
  tailKind?: ChatProviderTailKind;
  finishReason?: string;
  failureStage?: "provider-parse" | "role-protocol" | "inner-voice" | "bubble-count" | "persistence";
  countMode?: ReplyBubbleCountDiagnostics["countMode"];
  allowedMin?: number;
  allowedMax?: number;
  preferredCount?: number;
  rawMessageCount?: number;
  finalMessageCount?: number;
  countResolution?: ReplyBubbleCountDiagnostics["countResolution"];
  countCompliant?: boolean;
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
  wireFormat?: ChatReplyWireFormat;
  transportMarkedIncomplete?: boolean;
  protocolValidationReached?: boolean;
  transportMode?: ChatProviderTransportMode;
  receivedChars?: number;
  receivedBytes?: number;
  declaredContentLength?: number;
  contentLengthMatched?: boolean;
  completeVisibleFieldRecovered?: boolean;
  tailKind?: ChatProviderTailKind;
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
  | "wireFormat"
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
    wireFormat: diagnostics.wireFormat,
    transportMarkedIncomplete: diagnostics.transportMarkedIncomplete,
    protocolValidationReached: diagnostics.protocolValidationReached,
  };
}
function replyRowLike(value: unknown) {
  if (typeof value === "string") return Boolean(value.trim());
  if (!isRecord(value)) return false;
  return ["content", "message", "reply"].some((key) => typeof value[key] === "string");
}
function directMeetRoundText(value: unknown) {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.segments)) return undefined;
  const hasDialogue = value.segments.some((segment) =>
    isRecord(segment) && segment.type === "dialogue" && typeof segment.characterId === "string" && typeof segment.text === "string" && Boolean(segment.text.trim()),
  );
  if (!hasDialogue) return undefined;
  return safeJson(value);
}
function meetRoundValueOf(value: unknown): unknown {
  if (directMeetRoundText(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = meetRoundValueOf(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const key of ["data", "result", "response", "body", "payload", "output"]) {
    const nested = value[key];
    if (typeof nested === "string") {
      const parsed = parseNestedString(nested);
      if (parsed !== undefined) {
        const found = meetRoundValueOf(parsed);
        if (found !== undefined) return found;
      }
    } else {
      const found = meetRoundValueOf(nested);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}
function directRoleProtocolText(value: unknown) {
  if (Array.isArray(value)) {
    if (!value.length || !value.every(replyRowLike)) return undefined;
    return safeJson(value);
  }
  if (!isRecord(value)) return undefined;
  const presence = replyProtocolPresenceOf(value);
  if (presence.wireFormat) return safeJson(value);
  if (presence.hasInnerVoice && ["content", "message", "reply"].some((key) => value[key] !== undefined))
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
  const meetRound = meetRoundValueOf(value);
  if (meetRound) {
    addCandidate(paths, (path || "$") + ".meetRound");
    return safeJson(meetRound);
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
  if (directMeetRoundText(row)) return "meet-round-object";
  const protocol = replyProtocolPresenceOf(row);
  if (protocol.wireFormat === "compact") return "direct-role-compact";
  if (protocol.hasMessages) return "direct-role-json";
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
  if (!isRecord(value) || replyProtocolPresenceOf(value).hasMessages) return undefined;
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
interface ResponseTransportMetadata {
  transportMode: ChatProviderTransportMode;
  receivedChars: number;
  receivedBytes: number;
  declaredContentLength?: number;
  contentLengthMatched?: boolean;
  transportMarkedIncomplete?: boolean;
  tailKind: ChatProviderTailKind;
}
interface JsonStringToken {
  value: string;
  end: number;
}
interface CompleteVisibleFieldRecovery {
  text: string;
  path: string;
  diagnostics: StructuredJsonDiagnostics;
}
function responseTailKind(input: string): ChatProviderTailKind {
  const tail = input.trimEnd().at(-1);
  if (tail === '"' || tail === "'") return "quote";
  if (tail === "}") return "object-close";
  if (tail === "]") return "array-close";
  if (tail === ",") return "comma";
  if (tail === ":") return "colon";
  if (tail === "\\") return "escape";
  return "other";
}
function byteLengthOf(value: string) {
  return new TextEncoder().encode(value).byteLength;
}
function declaredContentLengthOf(response: Response) {
  const raw = response.headers.get("Content-Length");
  if (!raw || !/^\d+$/.test(raw.trim())) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}
function transportMetadataOf(
  response: Response,
  raw: string,
  transportMode: ChatProviderTransportMode,
  receivedBytes = byteLengthOf(raw),
): ResponseTransportMetadata {
  const declaredContentLength = declaredContentLengthOf(response);
  const encoded = response.headers.get("Content-Encoding");
  const contentLengthMatched =
    declaredContentLength === undefined || (encoded && encoded.toLowerCase() !== "identity")
      ? undefined
      : declaredContentLength === receivedBytes;
  return {
    transportMode,
    receivedChars: raw.length,
    receivedBytes,
    declaredContentLength,
    contentLengthMatched,
    transportMarkedIncomplete: contentLengthMatched === false,
    tailKind: responseTailKind(raw),
  };
}
function readJsonStringToken(input: string, start: number): JsonStringToken | undefined {
  if (input[start] !== '"') return undefined;
  let escaped = false;
  for (let index = start + 1; index < input.length; index += 1) {
    const char = input[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char !== '"') continue;
    const encoded = input.slice(start, index + 1);
    try {
      const value = JSON.parse(encoded) as unknown;
      return typeof value === "string" ? { value, end: index + 1 } : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
function nextNonWhitespace(input: string, start: number) {
  let index = start;
  while (index < input.length && /\s/.test(input[index]!)) index += 1;
  return index;
}
function completeRolePayloadOf(input: string): { text: string; diagnostics: StructuredJsonDiagnostics } | undefined {
  let value: unknown = input;
  let diagnostics: StructuredJsonDiagnostics | undefined;
  for (let depth = 0; depth < 5 && typeof value === "string"; depth += 1) {
    try {
      const parsed = parseStructuredJsonWithMeta(value);
      value = parsed.value;
      diagnostics = parsed.diagnostics;
    } catch {
      return undefined;
    }
  }
  const presence = replyProtocolPresenceOf(value);
  if (!isRecord(value) || !presence.hasMessages || !presence.hasInnerVoice || !diagnostics) return undefined;
  const text = safeJson(value);
  return text ? { text, diagnostics } : undefined;
}
function knownBrokenEnvelopePath(raw: string, keyStart: number, key: string) {
  const prefix = raw.slice(0, keyStart);
  const lower = prefix.toLowerCase();
  const hasDirectMessages = /"messages"\s*:/.test(prefix);
  if (key === "content") {
    const lastMessage = Math.max(lower.lastIndexOf('"message"'), lower.lastIndexOf('"delta"'));
    const lastHidden = Math.max(lower.lastIndexOf('"reasoning"'), lower.lastIndexOf('"analysis"'), lower.lastIndexOf('"thinking"'));
    if (lastMessage >= 0 && lastMessage > lastHidden && (!hasDirectMessages || lower.includes('"choices"'))) {
      return lower.includes('"choices"') ? "choices[].message.content" : "message.content";
    }
    return undefined;
  }
  if (key === "output_text") return "output[].content[].output_text";
  if (key === "text") {
    if (lower.includes('"candidates"') && lower.includes('"parts"')) return "candidates[].content.parts[].text";
    if (lower.includes('"type"') && lower.includes("output_text")) return "output[].content[].text";
    if (lower.includes('"content"') && lower.includes('"type"') && lower.includes('"text"')) return "content[].text";
    return undefined;
  }
  if (["reply", "completion", "generated_text", "answer", "response_text"].includes(key)) return key;
  return undefined;
}
function recoverCompleteVisibleField(raw: string): CompleteVisibleFieldRecovery | undefined {
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== '"') continue;
    const keyToken = readJsonStringToken(raw, index);
    if (!keyToken) continue;
    const colon = nextNonWhitespace(raw, keyToken.end);
    if (raw[colon] !== ":") {
      index = keyToken.end - 1;
      continue;
    }
    const path = knownBrokenEnvelopePath(raw, index, keyToken.value);
    const valueStart = nextNonWhitespace(raw, colon + 1);
    if (!path || raw[valueStart] !== '"') {
      index = keyToken.end - 1;
      continue;
    }
    const valueToken = readJsonStringToken(raw, valueStart);
    if (!valueToken) return undefined;
    const complete = completeRolePayloadOf(valueToken.value);
    if (complete) return { ...complete, path };
    index = valueToken.end - 1;
  }
  return undefined;
}
function hasUnterminatedKnownVisibleField(raw: string) {
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== '"') continue;
    const keyToken = readJsonStringToken(raw, index);
    if (!keyToken) continue;
    const colon = nextNonWhitespace(raw, keyToken.end);
    if (raw[colon] !== ":") {
      index = keyToken.end - 1;
      continue;
    }
    const path = knownBrokenEnvelopePath(raw, index, keyToken.value);
    const valueStart = nextNonWhitespace(raw, colon + 1);
    if (!path || raw[valueStart] !== '"') {
      index = keyToken.end - 1;
      continue;
    }
    const valueToken = readJsonStringToken(raw, valueStart);
    if (!valueToken) return true;
    index = valueToken.end - 1;
  }
  return false;
}
function transportMetaFields(meta?: Partial<ResponseTransportMetadata>) {
  if (!meta) return {};
  return {
    transportMode: meta.transportMode,
    receivedChars: meta.receivedChars,
    receivedBytes: meta.receivedBytes,
    declaredContentLength: meta.declaredContentLength,
    contentLengthMatched: meta.contentLengthMatched,
    transportMarkedIncomplete: meta.transportMarkedIncomplete,
    tailKind: meta.tailKind,
  };
}
function looksLikeKnownEnvelope(input: string) {
  return /"(?:choices|candidates|output|message|response|result|data|payload)"\s*:/.test(input);
}
const MAX_STREAM_CARRY_CHARS = 8_000_000;
function parseSseOrNdjson(
  raw: string,
  mode: "sse" | "ndjson",
  contentType?: string,
  secrets: string[] = [],
  transportMeta?: ResponseTransportMetadata,
  onVisibleChunk?: (value: string) => void,
): ProviderChatResult | undefined {
  const chunks: string[] = [];
  let finishReason: string | undefined;
  let outputTokens: number | undefined;
  let doneMarker = false;
  let parsedCount = 0;
  let malformedCount = 0;
  let carry = "";
  const visibleCandidatePaths: string[] = [];
  const signals: ExtractionSignals = { reasoning: false, tool: false };
  const parsePayload = (text: string): "parsed" | "done" | "invalid" => {
    const payload = text.trim();
    if (!payload) return "parsed";
    if (payload === "[DONE]") {
      doneMarker = true;
      return "done";
    }
    try {
      const value = JSON.parse(payload) as unknown;
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
          ...transportMetaFields(transportMeta),
        });
      }
      const visible = visibleTextOf(value, `${mode}[${parsedCount - 1}]`, 0, visibleCandidatePaths, signals);
      if (visible) chunks.push(visible);
      finishReason = finishReasonOf(value) ?? finishReason;
      outputTokens = outputTokensOf(value) ?? outputTokens;
      return "parsed";
    } catch (error) {
      if (error instanceof ProviderResponseParseError) throw error;
      return "invalid";
    }
  };
  const appendCarry = (fragment: string) => {
    if (carry.length + fragment.length > MAX_STREAM_CARRY_CHARS) {
      malformedCount += 1;
      carry = fragment.length <= MAX_STREAM_CARRY_CHARS ? fragment : "";
      return;
    }
    carry += fragment;
  };
  const consumeFragment = (fragment: string) => {
    if (!fragment) return;
    if (carry) {
      const joined = carry + fragment;
      const joinedResult = parsePayload(joined);
      if (joinedResult !== "invalid") {
        carry = "";
        return;
      }
      const joinedWithLineBreak = carry + "\n" + fragment;
      if (joinedWithLineBreak !== joined) {
        const lineResult = parsePayload(joinedWithLineBreak);
        if (lineResult !== "invalid") {
          carry = "";
          return;
        }
      }
      const standalone = parsePayload(fragment);
      if (standalone !== "invalid") {
        malformedCount += 1;
        carry = "";
        return;
      }
      appendCarry(fragment);
      return;
    }
    if (parsePayload(fragment) === "invalid") appendCarry(fragment);
  };
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  if (mode === "sse") {
    for (const original of lines) {
      if (!original) continue;
      if (/^(?:event:|id:|retry:|:)/.test(original)) continue;
      if (original.startsWith("data:")) {
        consumeFragment(original.slice(5).replace(/^ /, ""));
        continue;
      }
      if (carry) consumeFragment(original);
    }
  } else {
    for (const line of lines) if (line.trim()) consumeFragment(line);
  }
  if (carry) {
    if (parsePayload(carry) === "invalid") malformedCount += 1;
    carry = "";
  }
  if (!parsedCount || !chunks.length) return undefined;
  const combined = chunks.join("");
  try {
    const normalized = parseChatResponse(
      combined,
      "application/json",
      secrets,
      transportMeta ? { ...transportMeta, transportMode: mode } : undefined,
    );
    chunks.forEach((chunk) => onVisibleChunk?.(chunk));
    return {
      ...normalized,
      finishReason: finishReason ?? normalized.finishReason,
      truncated: truncatedOf(finishReason ?? normalized.finishReason),
      responseShape: mode,
      rawLength: raw.length,
      outputTokens: outputTokens ?? normalized.outputTokens,
      transportMode: mode,
      receivedChars: transportMeta?.receivedChars ?? raw.length,
      receivedBytes: transportMeta?.receivedBytes ?? byteLengthOf(raw),
      declaredContentLength: transportMeta?.declaredContentLength,
      contentLengthMatched: transportMeta?.contentLengthMatched,
      tailKind: transportMeta?.tailKind ?? responseTailKind(raw),
    };
  } catch (error) {
    if (error instanceof ProviderResponseParseError) {
      throw new ProviderResponseParseError(error.kind, error.message, {
        ...error.meta,
        providerCode:
          error.meta.providerCode === "truncated_json" && transportMeta?.contentLengthMatched === false
            ? "transport_truncated"
            : error.meta.providerCode,
        responseShape: `${mode}:${error.meta.responseShape ?? "invalid"}`,
        rawLength: raw.length,
        contentType,
        finishReason,
        detail: malformedCount
          ? `${error.meta.detail ?? error.message}；另有 ${malformedCount} 个无法解析的流事件`
          : error.meta.detail,
        ...transportMetaFields(transportMeta ? { ...transportMeta, transportMode: mode } : undefined),
      });
    }
    throw error;
  }
}
function parseChatResponse(
  raw: string,
  contentType?: string,
  secrets: string[] = [],
  transportMeta: ResponseTransportMetadata = {
    transportMode: "non-stream",
    receivedChars: raw.length,
    receivedBytes: byteLengthOf(raw),
    tailKind: responseTailKind(raw),
  },
): ProviderChatResult {
  const trimmed = raw.replace(/^\uFEFF/, "").trim();
  const baseMeta = { rawLength: raw.length, contentType, ...transportMetaFields(transportMeta) };
  if (!trimmed)
    throw new ProviderResponseParseError("format", "服务返回了空响应", {
      providerCode: "empty_response",
      detail: "HTTP 请求成功，但响应正文为空",
      responseShape: "empty",
      visibleCandidatePaths: [],
      failureStage: "provider-parse",
      ...baseMeta,
    });
  if (/text\/html/i.test(contentType ?? "") || /^\s*(?:<!doctype\s+html|<html\b|<body\b)/i.test(trimmed))
    throw new ProviderResponseParseError("format", "服务返回了网页而不是 API 数据", {
      providerCode: "html_response",
      detail: "接口返回了 HTML、登录页或网关页面",
      responseShape: "html",
      visibleCandidatePaths: [],
      failureStage: "provider-parse",
      ...baseMeta,
    });
  if (/^\s*(?:data|event):/m.test(trimmed)) {
    const streamed = parseSseOrNdjson(trimmed, "sse", contentType, secrets, { ...transportMeta, transportMode: "sse" });
    if (streamed) return streamed;
  }
  const ndjsonLines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (ndjsonLines.length > 1 && ndjsonLines.every((line) => {
    try { JSON.parse(line); return true; } catch { return false; }
  })) {
    const ndjson = parseSseOrNdjson(trimmed, "ndjson", contentType, secrets, { ...transportMeta, transportMode: "ndjson" });
    if (ndjson) return ndjson;
  }

  let data: unknown;
  let structuredDiagnostics: StructuredJsonDiagnostics | undefined;
  try {
    const parsed = parseStructuredJsonWithMeta(trimmed, {
      transportMarkedIncomplete: transportMeta.transportMarkedIncomplete,
    });
    data = parsed.value;
    structuredDiagnostics = parsed.diagnostics;
  } catch (error) {
    const looksStructured = /^[\[{]/.test(trimmed) || /^```/i.test(trimmed);
    if (!looksStructured) {
      return {
        text: trimmed,
        truncated: false,
        responseShape: "plain-text",
        rawLength: raw.length,
        ...transportMetaFields(transportMeta),
      };
    }
    const structuredError = error instanceof StructuredJsonError ? error : undefined;
    const recovered = looksLikeKnownEnvelope(trimmed) ? recoverCompleteVisibleField(trimmed) : undefined;
    if (recovered) {
      return {
        text: recovered.text,
        truncated: false,
        responseShape: `recovered-envelope:${recovered.path}`,
        rawLength: raw.length,
        completeVisibleFieldRecovered: true,
        ...structuredDiagnosticMeta(recovered.diagnostics),
        ...transportMetaFields(transportMeta),
      };
    }
    const diagnostics = structuredError?.diagnostics;
    const transportTruncated = transportMeta.transportMarkedIncomplete === true;
    const incomplete = structuredError?.reason === "incomplete";
    const malformedEnvelope = looksLikeKnownEnvelope(trimmed) && !transportTruncated && !incomplete;
    const providerCode = transportTruncated
      ? "transport_truncated"
      : incomplete
        ? "truncated_json"
        : malformedEnvelope
          ? "malformed_envelope"
          : "invalid_json";
    const message = transportTruncated || incomplete
      ? "服务返回内容被截断或结构不完整"
      : malformedEnvelope
        ? "服务返回的 API 外壳损坏，无法恢复完整正文"
        : "服务返回的数据格式无法识别";
    throw new ProviderResponseParseError("format", message, {
      providerCode,
      detail: transportTruncated
        ? "实际接收长度与服务声明长度不一致，且未恢复到完整角色数据"
        : incomplete
          ? "响应在字符串、字段或明确的 EOF 不完整标记处中断，无法恢复完整角色数据"
          : malformedEnvelope
            ? "响应包含已知 API 外壳字段，但外壳无法解析且没有完整可解码的角色正文字段"
            : "响应看起来是结构化数据，但无法通过确定性 JSON 修复",
      responseShape: transportTruncated ? "transport-truncated" : incomplete ? "truncated-json" : malformedEnvelope ? "malformed-envelope" : "malformed-json",
      visibleCandidatePaths: [],
      failureStage: "provider-parse",
      ...structuredDiagnosticMeta(diagnostics),
      ...baseMeta,
    });
  }
  if (
    structuredDiagnostics?.parseStatus === "repaired-json" &&
    looksLikeKnownEnvelope(trimmed) &&
    hasUnterminatedKnownVisibleField(trimmed)
  ) {
    throw new ProviderResponseParseError("format", "服务返回内容被截断或结构不完整", {
      providerCode: transportMeta.transportMarkedIncomplete ? "transport_truncated" : "truncated_json",
      detail: "已知 API 正文字段的 JSON 字符串在结束引号前中断",
      responseShape: "truncated-visible-field",
      visibleCandidatePaths: [],
      failureStage: "provider-parse",
      ...structuredDiagnosticMeta({ ...structuredDiagnostics, parseStatus: "truncated-json", unterminatedString: true }),
      ...baseMeta,
    });
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
    const detail = parsed.message || "服务返回了错误结果";
    throw new ProviderResponseParseError(kindOfSuccessfulError(wrappedError.error), detail, {
      providerCode: parsed.providerCode ?? "provider_error",
      providerType: parsed.providerType,
      param: parsed.param,
      detail,
      responseShape: `${responseShape}:error@${wrappedError.path}`,
      visibleCandidatePaths,
      ...structuredDiagnosticMeta(structuredDiagnostics),
      ...baseMeta,
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
      visibleCandidatePaths,
      failureStage: "provider-parse",
      ...structuredDiagnosticMeta(structuredDiagnostics),
      ...baseMeta,
    });
  }
  const finishReason = finishReasonOf(data);
  const completeVisibleRole = completeRolePayloadOf(text);
  const visibleFieldRecovered = Boolean(
    completeVisibleRole &&
      structuredDiagnostics?.parseStatus === "repaired-json" &&
      structuredDiagnostics.outerContainerClosed === false,
  );
  return {
    text: completeVisibleRole?.text ?? text,
    finishReason,
    truncated: truncatedOf(finishReason),
    responseShape: visibleFieldRecovered
      ? `recovered-envelope:${visibleCandidatePaths[0] ?? responseShape}`
      : responseShape,
    rawLength: raw.length,
    outputTokens: outputTokensOf(data),
    completeVisibleFieldRecovered: visibleFieldRecovered || undefined,
    ...structuredDiagnosticMeta(signals.structuredDiagnostics ?? structuredDiagnostics ?? completeVisibleRole?.diagnostics),
    hasMessages: completeVisibleRole ? true : (signals.structuredDiagnostics ?? structuredDiagnostics)?.hasMessages,
    hasInnerVoice: completeVisibleRole ? true : (signals.structuredDiagnostics ?? structuredDiagnostics)?.hasInnerVoice,
    wireFormat: (completeVisibleRole?.diagnostics ?? signals.structuredDiagnostics ?? structuredDiagnostics)?.wireFormat,
    protocolValidationReached: Boolean(
      completeVisibleRole || (signals.structuredDiagnostics ?? structuredDiagnostics)?.wireFormat,
    ),
    ...transportMetaFields(transportMeta),
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
  if (providerCode === "bubble_count_out_of_range") return "角色回复数量超出已设置范围，且无法安全调整";
  if (providerCode === "transport_truncated") return "服务返回内容在传输过程中被截断";
  if (providerCode === "malformed_envelope") return "服务返回的 API 外壳损坏";
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
  if (providerCode === "bubble_count_out_of_range") return ["可点击重试。", "自动模式允许自然生成 1–8 条，只有精确模式才要求严格数量。", "不会为了凑数添加或删除正文。"];
  if (providerCode === "transport_truncated")
    return ["重新生成完整回复。", "检查中转服务的流式传输或响应长度限制。", "若问题持续，请复制脱敏诊断信息。"];
  if (providerCode === "malformed_envelope")
    return ["重新生成完整回复。", "检查中转是否破坏了 OpenAI 兼容响应外壳。", "若问题持续，请复制脱敏诊断信息。"];
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
    retryAfterSeconds: meta.retryAfterSeconds,
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
    wireFormat: meta.wireFormat,
    transportMarkedIncomplete: meta.transportMarkedIncomplete,
    protocolValidationReached: meta.protocolValidationReached,
    transportMode: meta.transportMode,
    receivedChars: meta.receivedChars,
    receivedBytes: meta.receivedBytes,
    declaredContentLength: meta.declaredContentLength,
    contentLengthMatched: meta.contentLengthMatched,
    completeVisibleFieldRecovered: meta.completeVisibleFieldRecovered,
    tailKind: meta.tailKind,
    finishReason: meta.finishReason,
    failureStage: meta.failureStage,
    countMode: meta.countMode,
    allowedMin: meta.allowedMin,
    allowedMax: meta.allowedMax,
    preferredCount: meta.preferredCount,
    rawMessageCount: meta.rawMessageCount,
    finalMessageCount: meta.finalMessageCount,
    countResolution: meta.countResolution,
    countCompliant: meta.countCompliant,
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

function retryAfterSecondsOf(value: string | null) {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.ceil(numeric);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1000));
}

export class OpenAIProvider {
  constructor(private settings: ProviderSettings) {}
  private base() { return this.settings.baseUrl.replace(/\/$/, ""); }
  private failure(kind: ApiErrorKind, message: string, partial = "", meta: ProviderErrorMetadata = {}) {
    return new ProviderError(kind, message, partial, createApiErrorInfo(kind, meta));
  }
  private mapStatus(status: number, text = "", retryAfterSeconds?: number) {
    const parsed = parsedErrorBody(text, [this.settings.apiKey]);
    const kind: ApiErrorKind = status === 401 || status === 403 ? "auth" : status === 404 ? "model" : status === 408 ? "timeout" : status === 429 ? "rate" : status >= 500 ? "server" : "format";
    const fallback = status === 401 || status === 403 ? "API Key 无效或无权限" : status === 404 ? "接口或模型不存在" : status === 408 ? "请求超时" : status === 429 ? "调用频率或额度已达上限" : status >= 500 ? `服务暂时不可用 (${status})` : `请求失败 (${status})`;
    const detail = parsed.message && parsed.message !== "error" ? parsed.message : fallback;
    return this.failure(kind, detail, "", { httpStatus: status, retryAfterSeconds, providerCode: parsed.providerCode, providerType: parsed.providerType, param: parsed.param, detail });
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
        return urls.length
          ? { ...message, content: [{ type: "text", text: message.content }, ...urls.map((url) => ({ type: "image_url", image_url: { url } }))] }
          : message;
      });
      const response = await fetch(this.base() + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + this.settings.apiKey },
        body: JSON.stringify({
          model: this.settings.model,
          messages: payloadMessages,
          temperature: opts.temperature ?? this.settings.temperature,
          stream,
        }),
        signal: controller.signal,
      });
      if (!response.ok)
        throw this.mapStatus(
          response.status,
          await response.text(),
          retryAfterSecondsOf(response.headers.get("Retry-After")),
        );
      const contentType = response.headers.get("Content-Type") ?? undefined;
      const parseOrThrow = (raw: string, meta: ResponseTransportMetadata) => {
        try {
          return parseChatResponse(raw, contentType, [this.settings.apiKey], meta);
        } catch (error) {
          if (error instanceof ProviderResponseParseError)
            throw this.failure(error.kind, error.message, "", error.meta);
          throw this.failure("format", "服务返回的数据格式无法识别，缺少可用正文", "", {
            providerCode: "invalid_response",
            detail: `响应结构无法提取正文；长度 ${raw.length}`,
            responseShape: "unknown",
            rawLength: raw.length,
            contentType,
            visibleCandidatePaths: [],
            failureStage: "provider-parse",
            ...transportMetaFields(meta),
          });
        }
      };
      if (!stream) {
        const raw = await response.text();
        const result = parseOrThrow(raw, transportMetadataOf(response, raw, "non-stream"));
        out = result.text;
        opts.onToken?.(result.text);
        return result;
      }
      if (!response.body)
        throw this.failure("format", "服务没有返回数据流", "", {
          providerCode: "missing_stream_body",
          transportMode: "sse",
        });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let raw = "";
      let receivedBytes = 0;
      while (true) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch {
          const meta = transportMetadataOf(response, raw, "sse", receivedBytes);
          throw this.failure("interrupted", "数据流意外中断", "", {
            providerCode: "transport_truncated",
            detail: "流式传输在完整角色协议形成前中断",
            responseShape: "interrupted-stream",
            rawLength: raw.length,
            contentType,
            failureStage: "provider-parse",
            ...transportMetaFields({ ...meta, transportMarkedIncomplete: true }),
          });
        }
        if (chunk.done) break;
        receivedBytes += chunk.value.byteLength;
        raw += decoder.decode(chunk.value, { stream: true });
      }
      raw += decoder.decode();
      const trimmedStream = raw.replace(/^\uFEFF/, "").trim();
      const contentTypeValue = (contentType ?? "").toLowerCase();
      const hasSseLines = /^\s*(?:data|event):/m.test(trimmedStream);
      const looksJsonDocument = /^[\[{"']/.test(trimmedStream);
      const looksSse = hasSseLines || (/text\/event-stream/.test(contentTypeValue) && !looksJsonDocument);
      const looksNdjson = /(?:application\/(?:x-)?ndjson|json-seq)/.test(contentTypeValue);
      let result: ProviderChatResult | undefined;
      if (looksSse) {
        const meta = transportMetadataOf(response, raw, "sse", receivedBytes);
        try {
          result = parseSseOrNdjson(raw, "sse", contentType, [this.settings.apiKey], meta, opts.onToken);
        } catch (error) {
          if (error instanceof ProviderResponseParseError)
            throw this.failure(error.kind, error.message, "", error.meta);
          throw error;
        }
      } else if (looksNdjson) {
        const meta = transportMetadataOf(response, raw, "ndjson", receivedBytes);
        try {
          result = parseSseOrNdjson(raw, "ndjson", contentType, [this.settings.apiKey], meta, opts.onToken);
        } catch (error) {
          if (error instanceof ProviderResponseParseError)
            throw this.failure(error.kind, error.message, "", error.meta);
          throw error;
        }
      } else {
        result = parseOrThrow(raw, transportMetadataOf(response, raw, "json-fallback", receivedBytes));
      }
      if (!result)
        throw this.failure("format", "数据流已结束，但没有生成完整正文", "", {
          providerCode: "empty_stream",
          detail: "流式响应中没有可解析的可见正文事件",
          responseShape: looksSse ? "sse-empty" : looksNdjson ? "ndjson-empty" : "stream-empty",
          rawLength: raw.length,
          contentType,
          failureStage: "provider-parse",
          ...transportMetaFields(
            transportMetadataOf(
              response,
              raw,
              looksSse ? "sse" : looksNdjson ? "ndjson" : "json-fallback",
              receivedBytes,
            ),
          ),
        });
      out = result.text;
      if (!looksSse && !looksNdjson) opts.onToken?.(result.text);
      return result;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (controller.signal.aborted) {
        if (controller.signal.reason === "timeout")
          throw this.failure("timeout", "请求超时", "", { providerCode: "request_timeout" });
        throw new ProviderError("aborted", "生成已停止", "");
      }
      if (error instanceof TypeError)
        throw this.failure("cors", "网络或跨域请求失败，请确认 API 支持浏览器 CORS", "", {
          providerCode: "cors_or_fetch_failed",
          detail: error.message,
        });
      throw this.failure("network", error instanceof Error ? error.message : "网络请求失败", "", {
        providerCode: "network_error",
        detail: error instanceof Error ? error.message : undefined,
      });
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
      if (!response.ok)
        throw this.mapStatus(
          response.status,
          await response.text(),
          retryAfterSecondsOf(response.headers.get("Retry-After")),
        );
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



