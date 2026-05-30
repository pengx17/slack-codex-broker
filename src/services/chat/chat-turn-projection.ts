import type { ChatThreadTarget, ChatTurnState } from "./chat-types.js";

export type ChatTurnProjectionStatus = "queued" | "thinking" | "running_tool" | "waiting" | "blocked" | "final" | "failed";

export interface ChatTurnProjection {
  readonly target: ChatThreadTarget;
  readonly status: ChatTurnProjectionStatus;
  readonly title: string;
  readonly summary: string;
  readonly reason?: string | undefined;
}

export function createChatTurnProjection(target: ChatThreadTarget, state: ChatTurnState): ChatTurnProjection {
  const status = chatTurnProjectionStatusFor(state);
  return {
    target,
    status,
    title: chatTurnProjectionTitleFor(status),
    summary: chatTurnProjectionSummaryFor(status),
    reason: state.reason,
  };
}

function chatTurnProjectionStatusFor(state: ChatTurnState): ChatTurnProjectionStatus {
  if (state.kind === "wait") {
    return "waiting";
  }
  if (state.kind === "block") {
    return "blocked";
  }
  return "final";
}

function chatTurnProjectionTitleFor(status: ChatTurnProjectionStatus): string {
  switch (status) {
    case "queued":
      return "Codex is queued";
    case "thinking":
      return "Codex is thinking";
    case "running_tool":
      return "Codex is running a tool";
    case "waiting":
      return "Codex is waiting";
    case "blocked":
      return "Codex is blocked";
    case "failed":
      return "Codex failed";
    case "final":
      return "Codex finished";
  }
}

function chatTurnProjectionSummaryFor(status: ChatTurnProjectionStatus): string {
  switch (status) {
    case "queued":
      return "The turn is queued and will start shortly.";
    case "thinking":
      return "Codex is working through the request.";
    case "running_tool":
      return "Codex is using a tool to make progress.";
    case "waiting":
      return "Codex is waiting for another system or user input.";
    case "blocked":
      return "Codex needs attention before it can continue.";
    case "failed":
      return "The turn failed before completing.";
    case "final":
      return "The turn reached a final state.";
  }
}
