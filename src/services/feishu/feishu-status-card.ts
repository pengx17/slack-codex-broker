import type { JsonLike } from "../../types.js";
import type { ChatTurnProjection, ChatTurnProjectionStatus } from "../chat/chat-turn-projection.js";

export function createFeishuTurnStateCard(projection: ChatTurnProjection): JsonLike {
  const elements: JsonLike[] = [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: `**${projection.title}**\n${projection.summary}`,
      },
    },
  ];

  if (projection.reason?.trim()) {
    elements.push({
      tag: "note",
      elements: [
        {
          tag: "plain_text",
          content: projection.reason.trim(),
        },
      ],
    });
  }

  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: feishuCardTemplateFor(projection.status),
      title: {
        tag: "plain_text",
        content: projection.title,
      },
    },
    elements,
  };
}

function feishuCardTemplateFor(status: ChatTurnProjectionStatus): string {
  switch (status) {
    case "queued":
    case "thinking":
    case "running_tool":
      return "blue";
    case "waiting":
      return "yellow";
    case "blocked":
    case "failed":
      return "red";
    case "final":
      return "green";
  }
}
