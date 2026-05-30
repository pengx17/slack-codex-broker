import type { ChatTurnProjection, ChatTurnProjectionStatus } from "../chat/chat-turn-projection.js";

export function createSlackTurnStatusText(projection: ChatTurnProjection): string {
  if (projection.status === "final") {
    return "";
  }

  const status = slackStatusTextFor(projection.status);
  return projection.reason?.trim() ? `${status} ${projection.reason.trim()}` : status;
}

function slackStatusTextFor(status: ChatTurnProjectionStatus): string {
  switch (status) {
    case "queued":
      return "Queued...";
    case "thinking":
      return "Thinking...";
    case "running_tool":
      return "Running a tool...";
    case "waiting":
      return "Waiting...";
    case "blocked":
      return "Blocked...";
    case "failed":
      return "Failed";
    case "final":
      return "";
  }
}
