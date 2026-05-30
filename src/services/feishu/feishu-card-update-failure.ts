export type FeishuCardUpdateFailureKind = "missing_message_id" | "expired_card" | "permission_denied" | "retryable_transport" | "unknown";

export interface FeishuCardUpdateFailure {
  readonly kind: FeishuCardUpdateFailureKind;
  readonly statusCode?: number | undefined;
}

export function missingFeishuCardMessageIdFailure(): FeishuCardUpdateFailure {
  return {
    kind: "missing_message_id",
  };
}

export function classifyFeishuCardUpdateFailure(error: unknown): FeishuCardUpdateFailure {
  const statusCode = statusCodeFromError(error);
  if (statusCode === 401 || statusCode === 403) {
    return {
      kind: "permission_denied",
      statusCode,
    };
  }

  if (statusCode === 404 || errorMessageIncludes(error, ["expired", "not found", "not_found", "message_id invalid"])) {
    return {
      kind: "expired_card",
      statusCode,
    };
  }

  if (statusCode === 408 || statusCode === 409 || statusCode === 429 || (statusCode !== undefined && statusCode >= 500) || errorMessageIncludes(error, ["fetch failed", "econnreset", "etimedout", "timeout"])) {
    return {
      kind: "retryable_transport",
      statusCode,
    };
  }

  return {
    kind: "unknown",
    statusCode,
  };
}

function statusCodeFromError(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const record = error as {
    readonly status?: unknown;
    readonly statusCode?: unknown;
    readonly code?: unknown;
  };
  const value = record.statusCode ?? record.status ?? record.code;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function errorMessageIncludes(error: unknown, tokens: readonly string[]): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return tokens.some((token) => normalized.includes(token));
}
