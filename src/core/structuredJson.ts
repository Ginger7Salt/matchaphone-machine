import { jsonrepair } from "jsonrepair";

export type StructuredJsonParseStatus =
  | "strict-json"
  | "repaired-json"
  | "unrecoverable-json"
  | "truncated-json";

export interface StructuredJsonDiagnostics {
  parseStatus: StructuredJsonParseStatus;
  strictParseSucceeded: boolean;
  repairAttempted: boolean;
  repairedParseSucceeded: boolean;
  transportMarkedIncomplete: boolean;
  protocolValidationReached: boolean;
  outerContainerClosed: boolean;
  unterminatedString: boolean;
  hasMessages: boolean;
  hasInnerVoice: boolean;
}

export interface StructuredJsonResult<T = unknown> {
  value: T;
  normalizedText: string;
  diagnostics: StructuredJsonDiagnostics;
}

export interface StructuredJsonParseOptions {
  transportMarkedIncomplete?: boolean;
}

export class StructuredJsonError extends Error {
  constructor(
    public readonly reason: "empty" | "invalid" | "incomplete",
    message = "模型返回的数据格式不正确",
    public readonly diagnostics?: StructuredJsonDiagnostics,
  ) {
    super(message);
    this.name = "StructuredJsonError";
  }
}

function stripReasoningAndFences(input: string) {
  let text = input.replace(/^\uFEFF/, "").trim();
  text = text.replace(/<(?:think|analysis)>[\s\S]*?<\/(?:think|analysis)>/gi, "").trim();
  const fence = text.match(/```(?:json|javascript|js)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) text = fence[1].trim();
  return text;
}

interface ContainerScan {
  outerContainerClosed: boolean;
  unterminatedString: boolean;
  mismatchedContainer: boolean;
  openContainers: number;
  trailingIncompleteToken: boolean;
}

function scanContainers(input: string): ContainerScan {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let quote = "";
  let mismatchedContainer = false;
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "“" || char === "‘") {
      inString = true;
      quote = char === "“" ? "”" : char === "‘" ? "’" : char;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }
    if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (stack.pop() !== expected) mismatchedContainer = true;
    }
  }
  const trailing = input.trimEnd().at(-1) ?? "";
  return {
    outerContainerClosed: stack.length === 0 && !mismatchedContainer && !inString,
    unterminatedString: inString,
    mismatchedContainer,
    openContainers: stack.length,
    trailingIncompleteToken: trailing === ":" || trailing === "," || trailing === "\\",
  };
}

function flagsOf(value: unknown) {
  const row = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
  return {
    hasMessages: Boolean(row && Array.isArray(row.messages)),
    hasInnerVoice: Boolean(row && row.innerVoice && typeof row.innerVoice === "object"),
  };
}

function diagnosticsOf(
  status: StructuredJsonParseStatus,
  scan: ContainerScan,
  value?: unknown,
  repairAttempted = false,
  repairedParseSucceeded = false,
  options: StructuredJsonParseOptions = {},
): StructuredJsonDiagnostics {
  return {
    parseStatus: status,
    strictParseSucceeded: status === "strict-json",
    repairAttempted,
    repairedParseSucceeded,
    transportMarkedIncomplete: Boolean(options.transportMarkedIncomplete),
    protocolValidationReached: false,
    outerContainerClosed: scan.outerContainerClosed,
    unterminatedString: scan.unterminatedString,
    ...flagsOf(value),
  };
}

function firstStructuralSuffix(input: string) {
  const objectIndex = input.indexOf("{");
  const arrayIndex = input.indexOf("[");
  const indexes = [objectIndex, arrayIndex].filter((index) => index >= 0);
  if (!indexes.length) return undefined;
  return input.slice(Math.min(...indexes));
}

function completeRootCandidate(input: string) {
  const suffix = firstStructuralSuffix(input);
  if (!suffix) return undefined;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < suffix.length; index++) {
    const char = suffix[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }
    if (char !== "}" && char !== "]") continue;
    const expected = char === "}" ? "{" : "[";
    if (stack.pop() !== expected) return undefined;
    if (!stack.length) return suffix.slice(0, index + 1);
  }
  return undefined;
}

function nativeCandidatesOf(cleaned: string) {
  return [...new Set([cleaned, completeRootCandidate(cleaned)].filter((value): value is string => Boolean(value)))];
}

function repairCandidatesOf(cleaned: string) {
  const suffix = firstStructuralSuffix(cleaned);
  return [...new Set([suffix, cleaned].filter((value): value is string => Boolean(value)))];
}

function nativeParse(value: string) {
  try {
    return { ok: true as const, value: JSON.parse(value) as unknown };
  } catch {
    return { ok: false as const };
  }
}

function incompleteAfterRepairFailure(scan: ContainerScan, input: string, options: StructuredJsonParseOptions) {
  if (options.transportMarkedIncomplete) return true;
  if (scan.trailingIncompleteToken) return true;
  if (scan.unterminatedString && !/[}\]]\s*$/.test(input)) return true;
  // Open containers alone are ambiguous when malformed quotes confused the scanner.
  // Treat them as truncation only when transport or an EOF token/string proves content ended early.
  return false;
}

export function parseStructuredJsonWithMeta<T = unknown>(
  input: string,
  options: StructuredJsonParseOptions = {},
): StructuredJsonResult<T> {
  const cleaned = stripReasoningAndFences(input);
  const scan = scanContainers(cleaned);
  if (!cleaned)
    throw new StructuredJsonError(
      "empty",
      "模型没有返回可用数据",
      diagnosticsOf("unrecoverable-json", scan, undefined, false, false, options),
    );

  for (const candidate of nativeCandidatesOf(cleaned)) {
    const parsed = nativeParse(candidate);
    if (parsed.ok)
      return {
        value: parsed.value as T,
        normalizedText: JSON.stringify(parsed.value),
        diagnostics: diagnosticsOf("strict-json", scanContainers(candidate), parsed.value, false, false, options),
      };
  }

  const repairCandidates = repairCandidatesOf(cleaned).filter((candidate) => {
    const first = candidate.trimStart()[0];
    return first === "{" || first === "[" || first === '"';
  });
  for (const candidate of repairCandidates) {
    try {
      const repaired = jsonrepair(candidate);
      const parsed = nativeParse(repaired);
      if (!parsed.ok) continue;
      const parsedFlags = flagsOf(parsed.value);
      const roleProtocolCandidate = /(?:^|[,{\s])(?:["']?messages["']?|["']?innerVoice["']?)\s*:/i.test(candidate);
      const repairedProtocolComplete = parsedFlags.hasMessages && parsedFlags.hasInnerVoice;
      if (roleProtocolCandidate && !repairedProtocolComplete && incompleteAfterRepairFailure(scanContainers(candidate), candidate, options))
        continue;
      return {
        value: parsed.value as T,
        normalizedText: JSON.stringify(parsed.value),
        diagnostics: diagnosticsOf("repaired-json", scan, parsed.value, true, true, options),
      };
    } catch {
      // Try the next deterministic candidate before classifying the response.
    }
  }

  const incomplete = incompleteAfterRepairFailure(scan, cleaned, options);
  throw new StructuredJsonError(
    incomplete ? "incomplete" : "invalid",
    incomplete
      ? "模型返回内容被截断，无法恢复完整结构"
      : "模型返回的数据格式不正确，请重试",
    diagnosticsOf(
      incomplete ? "truncated-json" : "unrecoverable-json",
      scan,
      undefined,
      repairCandidates.length > 0,
      false,
      options,
    ),
  );
}

export function parseStructuredJson<T = unknown>(input: string, options: StructuredJsonParseOptions = {}): T {
  return parseStructuredJsonWithMeta<T>(input, options).value;
}

export function extractStructuredJsonText(input: string) {
  const cleaned = stripReasoningAndFences(input);
  return completeRootCandidate(cleaned) ?? firstStructuralSuffix(cleaned) ?? cleaned;
}
