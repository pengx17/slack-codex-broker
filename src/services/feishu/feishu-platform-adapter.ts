import fs from "node:fs/promises";
import path from "node:path";

import * as Lark from "@larksuiteoapi/node-sdk";

import { logger } from "../../logger.js";
import type { ChatPlatformAdapter, ChatPlatformHandlers } from "../chat/chat-platform-adapter.js";
import { createChatTurnProjection, type ChatTurnProjection } from "../chat/chat-turn-projection.js";
import {
  CHAT_FILE_SOURCE_REQUIREMENT_MESSAGE,
  CHAT_INLINE_FILE_CONTENT_REQUIREMENT_MESSAGE,
  CHAT_INLINE_FILE_FILENAME_REQUIREMENT_MESSAGE,
  type ChatAttachment,
  type ChatOutboundFile,
  type ChatOutboundMessage,
  type ChatPostedMessage,
  type ChatThreadMessage,
  type ChatThreadPage,
  type ChatThreadQuery,
  type ChatThreadTarget,
  type ChatTurnState,
  type ChatUploadedFile,
  type ChatUserIdentity,
} from "../chat/chat-types.js";
import type { JsonLike } from "../../types.js";
import { FeishuApi, type FeishuMessageData, createFeishuTextContent, feishuSdkDomainFromApiBaseUrl } from "./feishu-api.js";
import { classifyFeishuCardUpdateFailure, missingFeishuCardMessageIdFailure } from "./feishu-card-update-failure.js";
import { type FeishuBotIdentity, routeFeishuReceiveMessageEvent } from "./feishu-event-parser.js";
import { createFeishuTurnStateCard } from "./feishu-status-card.js";

interface FeishuWsClientLike {
  start(options: { eventDispatcher: Lark.EventDispatcher }): Promise<void>;
  close(options?: { force?: boolean }): void;
}

export class FeishuPlatformAdapter implements ChatPlatformAdapter {
  readonly platform = "feishu" as const;
  readonly #api: FeishuApi;
  readonly #wsClient: FeishuWsClientLike;
  readonly #botIdentity?: FeishuBotIdentity | undefined;
  readonly #groupMessageMode: "all" | "at_only";
  readonly #startupRequired: boolean;
  readonly #sendRateLimiter = new FeishuGroupMessageRateLimiter();
  readonly #stateCards = new Map<string, FeishuStateCardRecord>();
  readonly #stateQueues = new Map<string, Promise<void>>();
  readonly #pendingStateUpdates = new Map<string, FeishuPendingStateUpdate>();
  readonly #stateCardPatchDebounceMs: number;
  #started = false;

  constructor(options: {
    readonly appId: string;
    readonly appSecret: string;
    readonly apiBaseUrl?: string | undefined;
    readonly api?: FeishuApi | undefined;
    readonly wsClient?: FeishuWsClientLike | undefined;
    readonly botIdentity?: FeishuBotIdentity | undefined;
    readonly groupMessageMode?: "all" | "at_only" | undefined;
    readonly startupRequired?: boolean | undefined;
    readonly stateCardPatchDebounceMs?: number | undefined;
  }) {
    this.#api =
      options.api ??
      new FeishuApi({
        appId: options.appId,
        appSecret: options.appSecret,
        apiBaseUrl: options.apiBaseUrl,
      });
    this.#wsClient =
      options.wsClient ??
      new Lark.WSClient({
        appId: options.appId,
        appSecret: options.appSecret,
        domain: options.apiBaseUrl ? feishuSdkDomainFromApiBaseUrl(options.apiBaseUrl) : Lark.Domain.Feishu,
        loggerLevel: Lark.LoggerLevel.info,
      });
    this.#botIdentity = {
      appId: options.appId,
      ...options.botIdentity,
    };
    this.#groupMessageMode = options.groupMessageMode ?? "all";
    this.#startupRequired = options.startupRequired ?? true;
    this.#stateCardPatchDebounceMs = Math.max(0, options.stateCardPatchDebounceMs ?? FEISHU_STATE_CARD_PATCH_DEBOUNCE_MS);
  }

  async start(handlers: ChatPlatformHandlers): Promise<void> {
    if (this.#started) {
      return;
    }

    const startedAt = Date.now();
    logger.info("chat.platform.starting", {
      platform: "feishu",
      source: "long_connection",
      groupMessageMode: this.#groupMessageMode,
      startupRequired: this.#startupRequired,
    });

    const eventDispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: unknown) => {
        logger.raw("feishu-events", data, {
          platform: "feishu",
        });

        const routed = routeFeishuReceiveMessageEvent(data, {
          botIdentity: this.#botIdentity,
        });
        if (routed.route === "ignored") {
          logger.info("chat.message.ignored", {
            platform: "feishu",
            conversationId: routed.conversationId ?? "unknown",
            conversationKind: routed.conversationKind,
            messageId: routed.messageId ?? "unknown",
            eventId: routed.eventId ?? routed.messageId ?? "unknown",
            senderKind: routed.senderKind ?? "unknown",
            ignoredReason: routed.ignoredReason,
            route: routed.ignoredReason,
          });
          return;
        }

        logger.info("chat.message.accepted", {
          platform: "feishu",
          conversationId: routed.parsed.input.conversationId,
          conversationKind: routed.parsed.input.conversationKind,
          rootMessageId: routed.parsed.input.rootMessageId,
          messageId: routed.parsed.input.messageId,
          eventId: routed.parsed.input.eventId ?? routed.parsed.input.messageId,
          senderKind: routed.parsed.input.sender.kind,
          msgType: feishuLogMessageType(routed.parsed.input),
          fileId: retainedResourceIdForMessage(routed.parsed.input),
          route: routed.parsed.route,
          payloadRef: payloadRefForRetainedMessage(routed.parsed.input),
        });
        dispatchFeishuHandler("message", async () => {
          await handlers.onMessage(routed.parsed.input);
        });
      },
      "card.action.trigger": async (data: unknown) => {
        const callback = unwrapFeishuEvent(data);
        const eventId = readString(callback, "event_id") ?? readNestedString(data, ["header", "event_id"]);
        const messageId = readString(callback, "open_message_id") ?? readString(callback, "message_id");
        const actionValue = readFeishuCardActionValue(callback);
        const sessionKey = actionValue ? readString(actionValue, "sessionKey") : undefined;
        const conversationId = actionValue ? (readString(actionValue, "conversationId") ?? readString(actionValue, "conversation_id")) : undefined;
        const rootMessageId = actionValue ? (readString(actionValue, "rootMessageId") ?? readString(actionValue, "root_message_id")) : undefined;
        const kind = actionValue ? readKnownFeishuCardActionKind(actionValue) : undefined;
        const candidateRevision = actionValue && kind ? readNumber(actionValue, "candidateRevision") : undefined;
        const startedAt = Date.now();

        logger.info("chat.card.callback.received", {
          platform: "feishu",
          sessionKey: sessionKey ?? "unknown",
          conversationId: conversationId ?? "unknown",
          rootMessageId: rootMessageId ?? "unknown",
          eventId: eventId ?? "unknown",
          messageId: messageId ?? "unknown",
          payloadRef: `feishu-card:${eventId ?? "unknown"}`,
          ackDurationMs: Date.now() - startedAt,
          kind,
          candidateRevision,
        });
        dispatchFeishuHandler("interactive", async () => {
          await handlers.onInteractive?.(callback);
        });
      },
    });

    await this.#wsClient.start({ eventDispatcher });
    this.#started = true;
    logger.info("chat.platform.ready", {
      platform: "feishu",
      source: "long_connection",
      groupMessageMode: this.#groupMessageMode,
      durationMs: Date.now() - startedAt,
    });
    await handlers.onReady?.(this.platform);
  }

  async stop(): Promise<void> {
    if (!this.#started) {
      return;
    }

    this.#wsClient.close();
    this.#started = false;
  }

  async getBotIdentity(): Promise<ChatUserIdentity | null> {
    if (!this.#botIdentity?.openId && !this.#botIdentity?.userId && !this.#botIdentity?.unionId) {
      return null;
    }

    const userId = this.#botIdentity.openId ?? this.#botIdentity.userId ?? this.#botIdentity.unionId!;
    return {
      platform: "feishu",
      userId,
      mention: `@${userId}`,
    };
  }

  async listThreadMessages(query: ChatThreadQuery): Promise<readonly ChatThreadMessage[]> {
    return (await this.listThreadMessagePage(query)).messages;
  }

  async listThreadMessagePage(query: ChatThreadQuery): Promise<ChatThreadPage> {
    const containerIdType = query.platformThreadId ? "thread" : "chat";
    const containerId = query.platformThreadId ?? query.conversationId;
    const result = await this.#api.listMessages({
      containerIdType,
      containerId,
      pageSize: query.limit,
      pageToken: query.beforeCursor,
      sortType: "ByCreateTimeAsc",
      cardMsgContentType: "user_card_content",
    });

    const messages = (result.items ?? [])
      .filter((item) => feishuHistoryItemMatchesThreadQuery(item, query))
      .flatMap((item) => {
        const routed = routeFeishuReceiveMessageEvent(
          {
            message: feishuHistoryItemToEventMessage(item),
            sender: feishuHistoryItemToEventSender(item),
          },
          {
            botIdentity: this.#botIdentity,
          },
        );
        return routed.route === "accepted" ? [routed.parsed.input] : [];
      });

    return {
      messages,
      hasMore: Boolean(result.has_more),
      nextCursor: result.page_token,
    };
  }

  async postThreadMessage(target: ChatThreadTarget, message: ChatOutboundMessage): Promise<ChatPostedMessage> {
    const payload = toFeishuOutboundPayload(message);
    await this.#waitForGroupSendSlot(target.conversationId);
    const posted = await this.#api.replyMessage({
      messageId: target.rootMessageId,
      msgType: payload.msgType,
      content: payload.content,
      replyInThread: true,
    });

    return {
      platform: "feishu",
      conversationId: target.conversationId,
      rootMessageId: posted.root_id ?? target.rootMessageId,
      messageId: posted.message_id,
      messageCursor: posted.create_time,
      rawResponse: normalizeMessageData(posted),
    };
  }

  async postThreadState(target: ChatThreadTarget, state: ChatTurnState): Promise<void> {
    await this.postThreadProjection(target, createChatTurnProjection(target, state));
  }

  async postThreadProjection(target: ChatThreadTarget, projection: ChatTurnProjection): Promise<void> {
    await this.#scheduleStateCardWrite(target, projection);
  }

  async uploadThreadFile(target: ChatThreadTarget, file: ChatOutboundFile): Promise<ChatUploadedFile> {
    const prepared = await prepareFeishuOutboundFile(file);
    const uploadKind = feishuUploadKindFor(prepared);
    if (file.initialComment?.trim()) {
      await this.postThreadMessage(target, {
        text: file.initialComment.trim(),
      });
    }

    if (uploadKind === "image") {
      const uploaded = await this.#api.uploadMessageImage({
        bytes: prepared.bytes,
      });
      const imageKey = uploaded.image_key;
      if (!imageKey) {
        throw new Error("Feishu image upload did not return image_key");
      }
      await this.#waitForGroupSendSlot(target.conversationId);
      const posted = await this.#api.replyMessage({
        messageId: target.rootMessageId,
        msgType: "image",
        content: {
          image_key: imageKey,
        },
        replyInThread: true,
      });

      return {
        platform: "feishu",
        fileId: imageKey,
        kind: "image",
        title: file.title?.trim() || prepared.filename,
        name: prepared.filename,
        mimetype: prepared.contentType,
        size: prepared.bytes.byteLength,
        rawResponse: normalizeMessageData({
          ...posted,
          raw: {
            upload: {
              kind: "image",
              image_key: imageKey,
            },
          },
        }),
      };
    }

    const uploaded = await this.#api.uploadMessageFile({
      bytes: prepared.bytes,
      filename: prepared.filename,
      fileType: feishuFileTypeFor(prepared.filename, prepared.contentType),
    });
    const fileKey = uploaded.file_key;
    if (!fileKey) {
      throw new Error("Feishu file upload did not return file_key");
    }
    await this.#waitForGroupSendSlot(target.conversationId);
    const posted = await this.#api.replyMessage({
      messageId: target.rootMessageId,
      msgType: "file",
      content: {
        file_key: fileKey,
      },
      replyInThread: true,
    });

    return {
      platform: "feishu",
      fileId: fileKey,
      kind: "file",
      title: file.title?.trim() || prepared.filename,
      name: prepared.filename,
      mimetype: prepared.contentType,
      size: prepared.bytes.byteLength,
      rawResponse: normalizeMessageData({
        ...posted,
        raw: {
          upload: {
            kind: "file",
            file_key: fileKey,
          },
        },
      }),
    };
  }

  async downloadAttachment(attachment: ChatAttachment): Promise<string> {
    if (!attachment.messageId || !attachment.resourceKey) {
      throw new Error("Feishu attachment requires messageId and resourceKey");
    }

    const type = attachment.kind === "image" || attachment.kind === "audio" || attachment.kind === "video" ? attachment.kind : "file";

    return await this.#api.downloadMessageResourceAsDataUrl({
      messageId: attachment.messageId,
      fileKey: attachment.resourceKey,
      type,
      maxBytes: type === "image" ? FEISHU_MESSAGE_IMAGE_RESOURCE_MAX_BYTES : FEISHU_MESSAGE_FILE_RESOURCE_MAX_BYTES,
      allowedContentTypes: feishuDownloadContentTypesFor(type),
    });
  }

  async getUserIdentity(userId: string): Promise<ChatUserIdentity | null> {
    return {
      platform: "feishu",
      userId,
      mention: `@${userId}`,
    };
  }

  async #waitForGroupSendSlot(conversationId: string): Promise<void> {
    const delayMs = this.#sendRateLimiter.reserveDelay(conversationId);
    if (delayMs > 0) {
      await delay(delayMs);
    }
  }

  async #runWithStateQueue(target: ChatThreadTarget, run: () => Promise<void>): Promise<void> {
    const queueKey = feishuStateCardKey(target);
    const previous = this.#stateQueues.get(queueKey) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(run);
    this.#stateQueues.set(queueKey, current);
    try {
      await current;
    } finally {
      if (this.#stateQueues.get(queueKey) === current) {
        this.#stateQueues.delete(queueKey);
      }
    }
  }

  #scheduleStateCardWrite(target: ChatThreadTarget, projection: ChatTurnProjection): Promise<void> {
    const stateKey = feishuStateCardKey(target);
    let pending = this.#pendingStateUpdates.get(stateKey);
    if (pending?.timer) {
      clearTimeout(pending.timer);
    }

    if (!pending) {
      pending = {
        target,
        projection,
        waiters: [],
      };
      this.#pendingStateUpdates.set(stateKey, pending);
    }

    pending.target = target;
    pending.projection = projection;
    const promise = new Promise<void>((resolve, reject) => {
      pending!.waiters.push({ resolve, reject });
    });

    const flush = () => {
      void this.#flushPendingStateCardWrite(stateKey, pending);
    };
    if (this.#stateCardPatchDebounceMs === 0) {
      queueMicrotask(flush);
    } else {
      pending.timer = setTimeout(flush, this.#stateCardPatchDebounceMs);
    }

    return promise;
  }

  async #flushPendingStateCardWrite(stateKey: string, pending: FeishuPendingStateUpdate): Promise<void> {
    if (this.#pendingStateUpdates.get(stateKey) !== pending) {
      return;
    }

    this.#pendingStateUpdates.delete(stateKey);
    pending.timer = undefined;
    try {
      await this.#runWithStateQueue(pending.target, async () => {
        await this.#writeThreadStateCard(pending.target, pending.projection);
      });
      for (const waiter of pending.waiters) {
        waiter.resolve();
      }
    } catch (error) {
      for (const waiter of pending.waiters) {
        waiter.reject(error);
      }
    }
  }

  async #writeThreadStateCard(target: ChatThreadTarget, projection: ChatTurnProjection): Promise<void> {
    const card = createFeishuTurnStateCard(projection);
    const hash = stableFeishuCardHash(card);
    const stateKey = feishuStateCardKey(target);
    const existing = this.#stateCards.get(stateKey);
    if (existing?.hash === hash) {
      return;
    }

    if (existing && !existing.messageId) {
      this.#recordStateCardPatchFailure(target, missingFeishuCardMessageIdFailure());
    }

    if (existing?.messageId) {
      try {
        await this.#api.patchMessage({
          messageId: existing.messageId,
          content: card,
        });
        this.#stateCards.set(stateKey, {
          messageId: existing.messageId,
          hash,
        });
        return;
      } catch (error) {
        this.#recordStateCardPatchFailure(target, classifyFeishuCardUpdateFailure(error));
        // Fall back to a fresh state card when Feishu can no longer patch the
        // previous one. The bridge logs final delivery failure with session
        // coordinates if the fallback send also fails.
      }
    }

    await this.#waitForGroupSendSlot(target.conversationId);
    const posted = await this.#api.replyMessage({
      messageId: target.rootMessageId,
      msgType: "interactive",
      content: card,
      replyInThread: true,
    });
    this.#stateCards.set(stateKey, {
      messageId: posted.message_id,
      hash,
    });
  }

  #recordStateCardPatchFailure(target: ChatThreadTarget, failure: { readonly kind: string; readonly statusCode?: number | undefined }): void {
    logger.debug("chat.state_card.patch_failed", {
      platform: "feishu",
      conversationId: target.conversationId,
      rootMessageId: target.rootMessageId,
      failureKind: failure.kind,
      statusCode: failure.statusCode ?? "unknown",
    });
  }
}

interface FeishuStateCardRecord {
  readonly messageId?: string | undefined;
  readonly hash: string;
}

interface FeishuPendingStateUpdate {
  target: ChatThreadTarget;
  projection: ChatTurnProjection;
  timer?: ReturnType<typeof setTimeout> | undefined;
  readonly waiters: Array<{
    readonly resolve: () => void;
    readonly reject: (error: unknown) => void;
  }>;
}

export const FEISHU_GROUP_MESSAGE_MIN_INTERVAL_MS = 200;
export const FEISHU_STATE_CARD_PATCH_DEBOUNCE_MS = 100;
const FEISHU_MESSAGE_IMAGE_RESOURCE_MAX_BYTES = 10 * 1024 * 1024;
const FEISHU_MESSAGE_FILE_RESOURCE_MAX_BYTES = 30 * 1024 * 1024;

export class FeishuGroupMessageRateLimiter {
  readonly #nextSendAtByConversation = new Map<string, number>();

  constructor(private readonly minIntervalMs = FEISHU_GROUP_MESSAGE_MIN_INTERVAL_MS) {}

  reserveDelay(conversationId: string, now = Date.now()): number {
    const nextSendAt = this.#nextSendAtByConversation.get(conversationId) ?? now;
    const scheduledAt = Math.max(now, nextSendAt);
    this.#nextSendAtByConversation.set(conversationId, scheduledAt + this.minIntervalMs);
    return Math.max(0, scheduledAt - now);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function feishuStateCardKey(target: ChatThreadTarget): string {
  return `${target.conversationId}:${target.rootMessageId}`;
}

function stableFeishuCardHash(card: JsonLike): string {
  return JSON.stringify(card);
}

async function prepareFeishuOutboundFile(file: ChatOutboundFile): Promise<{
  readonly bytes: Buffer;
  readonly filename: string;
  readonly contentType?: string | undefined;
}> {
  const hasFilePath = Boolean(file.filePath?.trim());
  const hasInlineContent = Boolean(file.contentBase64?.trim());

  if (hasFilePath === hasInlineContent) {
    throw new Error(CHAT_FILE_SOURCE_REQUIREMENT_MESSAGE);
  }

  const contentType = file.contentType?.trim() || undefined;
  let filename = file.filename?.trim() || undefined;
  let bytes: Buffer;

  if (hasFilePath) {
    const filePath = file.filePath!.trim();
    bytes = await fs.readFile(filePath);
    filename ??= path.basename(filePath);
  } else {
    bytes = Buffer.from(file.contentBase64!.trim(), "base64");
    if (!filename) {
      throw new Error(CHAT_INLINE_FILE_FILENAME_REQUIREMENT_MESSAGE);
    }
  }

  if (bytes.byteLength === 0) {
    throw new Error(CHAT_INLINE_FILE_CONTENT_REQUIREMENT_MESSAGE);
  }

  if (!filename) {
    throw new Error("Unable to determine filename for Feishu upload");
  }

  return {
    bytes,
    filename,
    contentType,
  };
}

function isFeishuImageUpload(filename: string, contentType: string | undefined): boolean {
  const extension = path.extname(filename).toLowerCase();
  return Boolean(contentType?.toLowerCase().startsWith("image/")) || [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".ico", ".tiff", ".tif", ".heic"].includes(extension);
}

function feishuUploadKindFor(file: { readonly bytes: Buffer; readonly filename: string; readonly contentType?: string | undefined }): "image" | "file" {
  if (file.bytes.byteLength > FEISHU_MESSAGE_FILE_RESOURCE_MAX_BYTES) {
    throw new Error("Feishu file upload exceeds 30 MB limit");
  }

  if (!isFeishuImageUpload(file.filename, file.contentType)) {
    return "file";
  }

  return file.bytes.byteLength <= FEISHU_MESSAGE_IMAGE_RESOURCE_MAX_BYTES ? "image" : "file";
}

function feishuDownloadContentTypesFor(type: "image" | "file" | "audio" | "video"): readonly string[] | undefined {
  if (type === "image") {
    return ["image/"];
  }

  if (type === "audio") {
    return ["audio/"];
  }

  if (type === "video") {
    return ["video/"];
  }

  return undefined;
}

function feishuFileTypeFor(filename: string, contentType: string | undefined): "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream" {
  const extension = path.extname(filename).toLowerCase();
  const normalizedContentType = contentType?.toLowerCase();
  if (extension === ".opus" || normalizedContentType === "audio/opus") {
    return "opus";
  }
  if (extension === ".mp4" || normalizedContentType === "video/mp4") {
    return "mp4";
  }
  if (extension === ".pdf" || normalizedContentType === "application/pdf") {
    return "pdf";
  }
  if ([".doc", ".docx"].includes(extension)) {
    return "doc";
  }
  if ([".xls", ".xlsx"].includes(extension)) {
    return "xls";
  }
  if ([".ppt", ".pptx"].includes(extension)) {
    return "ppt";
  }
  return "stream";
}

function payloadRefForRetainedMessage(message: ChatThreadMessage): string | undefined {
  if (message.format !== "rich_text" && message.format !== "card" && (message.attachments?.length ?? 0) === 0) {
    return undefined;
  }

  return `feishu-message:${message.messageId}`;
}

function feishuLogMessageType(message: ChatThreadMessage): string {
  if (message.format === "rich_text" || message.format === "card") {
    return message.format;
  }

  const attachmentKind = message.attachments?.find((attachment) => attachment.kind === "image" || attachment.kind === "file" || attachment.kind === "audio" || attachment.kind === "video")?.kind;

  return attachmentKind ?? "text";
}

function retainedResourceIdForMessage(message: ChatThreadMessage): string | undefined {
  return message.attachments?.find((attachment) => attachment.kind === "image" || attachment.kind === "file")?.resourceKey;
}

function toFeishuOutboundPayload(message: ChatOutboundMessage): {
  readonly msgType: "text" | "post" | "interactive";
  readonly content: JsonLike;
} {
  if (message.format === "card" && message.card) {
    return {
      msgType: "interactive",
      content: message.card,
    };
  }

  if (message.format === "rich_text" && message.richText) {
    return {
      msgType: "post",
      content: message.richText,
    };
  }

  if (message.format === "markdown") {
    return {
      msgType: "post",
      content: createFeishuPostContent(message.text),
    };
  }

  return {
    msgType: "text",
    content: createFeishuTextContent(message.text),
  };
}

function createFeishuPostContent(text: string): JsonLike {
  const blocks = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  return {
    zh_cn: {
      content: (blocks.length > 0 ? blocks : [text]).map((block) => [
        {
          tag: "text",
          text: block,
        },
      ]),
    },
  };
}

function feishuHistoryItemToEventMessage(item: FeishuMessageData): Record<string, unknown> {
  return {
    chat_id: item.chat_id,
    chat_type: "group",
    message_id: item.message_id,
    root_id: item.root_id,
    parent_id: item.parent_id,
    thread_id: item.thread_id,
    create_time: item.create_time,
    message_type: item.msg_type,
    content: item.body?.content,
  };
}

function feishuHistoryItemMatchesThreadQuery(item: FeishuMessageData, query: ChatThreadQuery): boolean {
  if (query.platformThreadId) {
    return true;
  }

  return item.message_id === query.rootMessageId || item.root_id === query.rootMessageId || item.parent_id === query.rootMessageId;
}

function feishuHistoryItemToEventSender(item: FeishuMessageData): Record<string, unknown> {
  const sender = item.raw && typeof item.raw === "object" && !Array.isArray(item.raw) ? (item.raw as Record<string, JsonLike>).sender : undefined;

  if (sender && typeof sender === "object" && !Array.isArray(sender)) {
    const senderRecord = sender as Record<string, JsonLike>;
    return {
      sender_id: {
        [String(senderRecord.id_type ?? "open_id")]: senderRecord.id,
      },
      sender_type: senderRecord.sender_type,
    };
  }

  return {
    sender_id: {
      open_id: "unknown:feishu-history",
    },
    sender_type: "unknown",
  };
}

function normalizeMessageData(message: FeishuMessageData): JsonLike {
  return withoutUndefined({
    message_id: message.message_id,
    root_id: message.root_id,
    parent_id: message.parent_id,
    thread_id: message.thread_id,
    msg_type: message.msg_type,
    create_time: message.create_time,
    update_time: message.update_time,
    chat_id: message.chat_id,
    body: message.body?.content ? { content: message.body.content } : undefined,
  });
}

function dispatchFeishuHandler(handler: "message" | "interactive", run: () => Promise<void>): void {
  void Promise.resolve()
    .then(run)
    .catch((error: unknown) => {
      logger.warn("chat.handler.failed", {
        platform: "feishu",
        handler,
        errorClass: error instanceof Error ? error.name : "Error",
      });
    });
}

function unwrapFeishuEvent(data: unknown): Record<string, unknown> {
  const record = asRecord(data);
  if (!record) {
    return {};
  }

  return asRecord(record.event) ?? record;
}

function readNestedString(data: unknown, pathParts: readonly string[]): string | undefined {
  let current = data;
  for (const part of pathParts) {
    const record = asRecord(current);
    if (!record) {
      return undefined;
    }
    current = record[part];
  }

  return typeof current === "string" && current ? current : undefined;
}

function readFeishuCardActionValue(callback: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = readNestedValue(callback, ["action", "value"]);
  if (typeof value === "string" && value.trim()) {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return undefined;
    }
  }

  return asRecord(value);
}

function readKnownFeishuCardActionKind(record: Record<string, unknown>): string | undefined {
  const kind = readString(record, "kind");
  return kind === "coauthor_confirm_all" || kind === "coauthor_skip" ? kind : undefined;
}

function readNestedValue(data: unknown, pathParts: readonly string[]): unknown {
  let current = data;
  for (const part of pathParts) {
    const record = asRecord(current);
    if (!record) {
      return undefined;
    }
    current = record[part];
  }

  return current;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function withoutUndefined(value: Record<string, JsonLike | undefined>): JsonLike {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Record<string, JsonLike>;
}
