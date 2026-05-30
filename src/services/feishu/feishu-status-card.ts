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

  for (const slot of projection.slots ?? []) {
    elements.push({
      tag: "hr",
    });
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: feishuProjectionSlotMarkdown(slot),
      },
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

function feishuProjectionSlotMarkdown(slot: NonNullable<ChatTurnProjection["slots"]>[number]): string {
  const title = `**${slot.title}**`;
  const body = slot.body?.trim();
  if (!body) {
    return title;
  }

  if (slot.kind === "tool") {
    return `${title}\n${truncateFeishuSlotBody(body)}`;
  }

  return `${title}\n${body}`;
}

function truncateFeishuSlotBody(body: string): string {
  const normalized = body.trim();
  if (normalized.length <= 700) {
    return normalized;
  }
  return `${normalized.slice(0, 700).trimEnd()}\n...`;
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
