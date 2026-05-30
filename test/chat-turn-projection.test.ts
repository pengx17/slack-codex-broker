import { describe, expect, it } from "vitest";

import { createChatTurnProjection } from "../src/services/chat/chat-turn-projection.js";

describe("chat turn projection", () => {
  it("maps logical chat turn states without platform rendering details", () => {
    const target = {
      platform: "feishu" as const,
      conversationId: "oc_group",
      rootMessageId: "om_root",
    };

    expect(
      createChatTurnProjection(target, {
        kind: "wait",
        reason: "CI is still running",
      }),
    ).toEqual({
      target,
      status: "waiting",
      title: "Codex is waiting",
      summary: "Codex is waiting for another system or user input.",
      reason: "CI is still running",
    });

    expect(
      createChatTurnProjection(target, {
        kind: "block",
      }),
    ).toMatchObject({
      status: "blocked",
      title: "Codex is blocked",
    });

    expect(
      createChatTurnProjection(target, {
        kind: "final",
      }),
    ).toMatchObject({
      status: "final",
      title: "Codex finished",
    });
  });
});
