import type { ChatTurnProjection, ChatTurnProjectionStatus } from "../chat/chat-turn-projection.js";

export function createSlackTurnStatusText(projection: ChatTurnProjection): string {
  if (projection.status === "final") {
    return "";
  }

  const status = slackStatusTextFor(projection.status);
  const slot = projection.slots?.[0];
  const detail = projection.reason?.trim() || slot?.title;
  return detail ? `${status} ${detail}` : status;
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
