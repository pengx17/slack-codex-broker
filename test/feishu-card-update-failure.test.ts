import { describe, expect, it } from "vitest";

import { classifyFeishuCardUpdateFailure, missingFeishuCardMessageIdFailure } from "../src/services/feishu/feishu-card-update-failure.js";

describe("Feishu card update failure classification", () => {
  it("models missing message ids before calling Feishu patch APIs", () => {
    expect(missingFeishuCardMessageIdFailure()).toEqual({
      kind: "missing_message_id",
    });
  });

  it("classifies expired, permission, retryable, and unknown patch failures", () => {
    expect(classifyFeishuCardUpdateFailure(Object.assign(new Error("card expired"), { statusCode: 400 }))).toEqual({
      kind: "expired_card",
      statusCode: 400,
    });
    expect(classifyFeishuCardUpdateFailure(Object.assign(new Error("forbidden"), { status: 403 }))).toEqual({
      kind: "permission_denied",
      statusCode: 403,
    });
    expect(classifyFeishuCardUpdateFailure(Object.assign(new Error("rate limited"), { statusCode: 429 }))).toEqual({
      kind: "retryable_transport",
      statusCode: 429,
    });
    expect(classifyFeishuCardUpdateFailure(new Error("unexpected response"))).toEqual({
      kind: "unknown",
      statusCode: undefined,
    });
  });
});
