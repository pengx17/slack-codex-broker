import type { ChatOutboundMessage, ChatThreadTarget, ChatTurnState } from "./chat-types.js";

export type ChatTurnProjectionStatus = "queued" | "thinking" | "running_tool" | "waiting" | "blocked" | "final" | "failed";
export type ChatTurnProjectionSlotKind = "commentary" | "tool" | "final" | "artifact";

export interface ChatTurnProjectionSlot {
  readonly kind: ChatTurnProjectionSlotKind;
  readonly title: string;
  readonly body?: string | undefined;
  readonly metadata?: Readonly<Record<string, string | number | boolean>> | undefined;
}

export interface ChatTurnProjection {
  readonly target: ChatThreadTarget;
  readonly status: ChatTurnProjectionStatus;
  readonly title: string;
  readonly summary: string;
  readonly reason?: string | undefined;
  readonly slots?: readonly ChatTurnProjectionSlot[] | undefined;
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

export function createChatTurnProjectionFromOutboundMessage(target: ChatThreadTarget, message: ChatOutboundMessage): ChatTurnProjection {
  const slot = chatTurnProjectionSlotForOutboundMessage(message);
  const status = chatTurnProjectionStatusForOutboundMessage(message, slot);
  return {
    target,
    status,
    title: chatTurnProjectionTitleFor(status),
    summary: chatTurnProjectionSummaryForOutboundMessage(status, message),
    reason: message.reason,
    slots: slot ? [slot] : undefined,
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

function chatTurnProjectionStatusForOutboundMessage(message: ChatOutboundMessage, slot: ChatTurnProjectionSlot | undefined): ChatTurnProjectionStatus {
  switch (message.kind) {
    case "wait":
      return "waiting";
    case "block":
      return "blocked";
    case "final":
      return "final";
    case "progress":
      if (slot?.kind === "tool") {
        return "running_tool";
      }
      return "thinking";
    default:
      return "thinking";
  }
}

function chatTurnProjectionSlotForOutboundMessage(message: ChatOutboundMessage): ChatTurnProjectionSlot | undefined {
  const text = message.text.trim();
  if (!text) {
    return undefined;
  }

  switch (message.kind) {
    case "final":
      return {
        kind: "final",
        title: "Final answer",
        body: text,
      };
    case "block":
      return {
        kind: "commentary",
        title: "Blocked on",
        body: text,
      };
    case "wait":
      return {
        kind: "commentary",
        title: "Waiting on",
        body: text,
      };
    case "progress":
    default:
      return createProgressSlot(text);
  }
}

function createProgressSlot(text: string): ChatTurnProjectionSlot {
  const toolName = parseToolName(text);
  if (toolName) {
    return {
      kind: "tool",
      title: `Tool: ${toolName}`,
      body: text,
      metadata: {
        toolName,
      },
    };
  }

  return {
    kind: "commentary",
    title: "Progress update",
    body: text,
  };
}

function parseToolName(text: string): string | undefined {
  const match = /^(?:tool|running tool|tool_call)\s*:\s*([A-Za-z0-9_.-]+)/iu.exec(text.trim());
  return match?.[1];
}

function chatTurnProjectionSummaryForOutboundMessage(status: ChatTurnProjectionStatus, message: ChatOutboundMessage): string {
  if (message.kind === "progress" && status !== "running_tool") {
    return "Codex shared a progress update.";
  }
  return chatTurnProjectionSummaryFor(status);
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
