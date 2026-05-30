/* oxlint-disable max-lines */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { configureLogger, flushLogger } from "../src/logger.js";
import { CHAT_FILE_SOURCE_REQUIREMENT_MESSAGE, CHAT_INLINE_FILE_CONTENT_REQUIREMENT_MESSAGE, CHAT_INLINE_FILE_FILENAME_REQUIREMENT_MESSAGE } from "../src/services/chat/chat-types.js";
import { FEISHU_GROUP_MESSAGE_MIN_INTERVAL_MS, FEISHU_STATE_CARD_PATCH_DEBOUNCE_MS, FeishuGroupMessageRateLimiter, FeishuPlatformAdapter } from "../src/services/feishu/feishu-platform-adapter.js";

describe("FeishuPlatformAdapter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reserves per-group send slots at the Feishu 5 QPS interval", () => {
    const limiter = new FeishuGroupMessageRateLimiter();

    expect(limiter.reserveDelay("oc_group", 1_000)).toBe(0);
    expect(limiter.reserveDelay("oc_group", 1_000)).toBe(FEISHU_GROUP_MESSAGE_MIN_INTERVAL_MS);
    expect(limiter.reserveDelay("oc_group", 1_100)).toBe(300);
    expect(limiter.reserveDelay("oc_other", 1_100)).toBe(0);
    expect(limiter.reserveDelay("oc_group", 1_600)).toBe(0);
  });

  it("throttles repeated replies per Feishu group without blocking other groups", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const calls: unknown[] = [];
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeApi(calls),
      wsClient: new FakeWsClient(),
    });

    await adapter.postThreadMessage(
      {
        platform: "feishu",
        conversationId: "oc_group",
        rootMessageId: "om_root",
      },
      {
        text: "first",
      },
    );
    const second = adapter.postThreadMessage(
      {
        platform: "feishu",
        conversationId: "oc_group",
        rootMessageId: "om_root",
      },
      {
        text: "second",
      },
    );
    await adapter.postThreadMessage(
      {
        platform: "feishu",
        conversationId: "oc_other",
        rootMessageId: "om_other",
      },
      {
        text: "other",
      },
    );

    expect(postedFeishuTextCalls(calls)).toEqual(["first", "other"]);
    await vi.advanceTimersByTimeAsync(FEISHU_GROUP_MESSAGE_MIN_INTERVAL_MS - 1);
    expect(postedFeishuTextCalls(calls)).toEqual(["first", "other"]);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(postedFeishuTextCalls(calls)).toEqual(["first", "other", "second"]);
  });

  it("posts an initial Feishu turn-state card, patches later states, and skips duplicate states", async () => {
    const calls: unknown[] = [];
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeApi(calls),
      wsClient: new FakeWsClient(),
      stateCardPatchDebounceMs: 0,
    });
    const target = {
      platform: "feishu" as const,
      conversationId: "oc_group",
      rootMessageId: "om_root",
    };

    await adapter.postThreadState(target, {
      kind: "wait",
      reason: "CI is still running",
    });
    await adapter.postThreadState(target, {
      kind: "wait",
      reason: "CI is still running",
    });
    await adapter.postThreadState(target, {
      kind: "final",
      reason: "done",
    });

    expect(calls.map((call) => (call as { operation?: string }).operation)).toEqual(["replyMessage", "patchMessage"]);
    expect(calls[0]).toEqual({
      operation: "replyMessage",
      options: expect.objectContaining({
        messageId: "om_root",
        msgType: "interactive",
        replyInThread: true,
        content: expect.objectContaining({
          header: expect.objectContaining({
            template: "yellow",
            title: expect.objectContaining({
              content: "Codex is waiting",
            }),
          }),
        }),
      }),
    });
    expect(calls[1]).toEqual({
      operation: "patchMessage",
      options: expect.objectContaining({
        messageId: "om_reply",
        content: expect.objectContaining({
          header: expect.objectContaining({
            template: "green",
            title: expect.objectContaining({
              content: "Codex finished",
            }),
          }),
        }),
      }),
    });
  });

  it("renders shared progress projection slots inside the Feishu state card", async () => {
    const calls: unknown[] = [];
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeApi(calls),
      wsClient: new FakeWsClient(),
      stateCardPatchDebounceMs: 0,
    });
    const target = {
      platform: "feishu" as const,
      conversationId: "oc_group",
      rootMessageId: "om_root",
    };

    await adapter.postThreadProjection(target, {
      target,
      status: "running_tool",
      title: "Codex is running a tool",
      summary: "Codex is using a tool to make progress.",
      slots: [
        {
          kind: "tool",
          title: "Tool: exec_command",
          body: `tool: exec_command\n${"x".repeat(900)}`,
          metadata: {
            toolName: "exec_command",
          },
        },
      ],
    });

    expect(calls).toEqual([
      {
        operation: "replyMessage",
        options: expect.objectContaining({
          msgType: "interactive",
          content: expect.objectContaining({
            elements: expect.arrayContaining([
              expect.objectContaining({
                tag: "div",
                text: expect.objectContaining({
                  content: expect.stringContaining("**Tool: exec_command**"),
                }),
              }),
            ]),
          }),
        }),
      },
    ]);
    expect(JSON.stringify(calls)).toContain("...");
  });

  it("renders shared artifact projection slots inside the Feishu state card", async () => {
    const calls: unknown[] = [];
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeApi(calls),
      wsClient: new FakeWsClient(),
      stateCardPatchDebounceMs: 0,
    });
    const target = {
      platform: "feishu" as const,
      conversationId: "oc_group",
      rootMessageId: "om_root",
    };

    await adapter.postThreadProjection(target, {
      target,
      status: "thinking",
      title: "Codex shared an artifact",
      summary: "A file or artifact was uploaded to the chat.",
      slots: [
        {
          kind: "artifact",
          title: "Artifact: report.pdf",
          body: "Kind: file\nName: report.pdf\nType: application/pdf\nSize: 2.0 KiB",
          metadata: {
            fileId: "file_uploaded",
            artifactKind: "file",
          },
        },
      ],
    });

    expect(calls).toEqual([
      {
        operation: "replyMessage",
        options: expect.objectContaining({
          msgType: "interactive",
          content: expect.objectContaining({
            elements: expect.arrayContaining([
              expect.objectContaining({
                tag: "div",
                text: expect.objectContaining({
                  content: expect.stringContaining("**Artifact: report.pdf**"),
                }),
              }),
            ]),
          }),
        }),
      },
    ]);
    expect(JSON.stringify(calls)).toContain("Kind: file");
  });

  it("debounces rapid Feishu turn-state patches to the latest visible card state", async () => {
    vi.useFakeTimers();
    const calls: unknown[] = [];
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeApi(calls),
      wsClient: new FakeWsClient(),
      stateCardPatchDebounceMs: FEISHU_STATE_CARD_PATCH_DEBOUNCE_MS,
    });
    const target = {
      platform: "feishu" as const,
      conversationId: "oc_group",
      rootMessageId: "om_root",
    };

    const initial = adapter.postThreadState(target, {
      kind: "wait",
      reason: "initial queue",
    });
    await vi.advanceTimersByTimeAsync(FEISHU_STATE_CARD_PATCH_DEBOUNCE_MS);
    await initial;

    const waiting = adapter.postThreadState(target, {
      kind: "wait",
      reason: "still waiting",
    });
    const blocked = adapter.postThreadState(target, {
      kind: "block",
      reason: "needs approval",
    });
    const final = adapter.postThreadState(target, {
      kind: "final",
      reason: "done",
    });

    await vi.advanceTimersByTimeAsync(FEISHU_STATE_CARD_PATCH_DEBOUNCE_MS - 1);
    expect(calls.map((call) => (call as { operation?: string }).operation)).toEqual(["replyMessage"]);

    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([waiting, blocked, final]);

    expect(calls.map((call) => (call as { operation?: string }).operation)).toEqual(["replyMessage", "patchMessage"]);
    expect(calls[1]).toEqual({
      operation: "patchMessage",
      options: expect.objectContaining({
        messageId: "om_reply",
        content: expect.objectContaining({
          header: expect.objectContaining({
            template: "green",
            title: expect.objectContaining({
              content: "Codex finished",
            }),
          }),
        }),
      }),
    });
  });

  it("serializes slow Feishu turn-state patches so the final visible state wins", async () => {
    let releaseFirstPatch: (() => void) | undefined;
    const firstPatchBlocker = new Promise<void>((resolve) => {
      releaseFirstPatch = resolve;
    });
    const calls: unknown[] = [];
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeApi(calls, {
        firstPatchBlocker,
      }),
      wsClient: new FakeWsClient(),
      stateCardPatchDebounceMs: 0,
    });
    const target = {
      platform: "feishu" as const,
      conversationId: "oc_group",
      rootMessageId: "om_root",
    };

    await adapter.postThreadState(target, {
      kind: "wait",
      reason: "initial queue",
    });

    const blocked = adapter.postThreadState(target, {
      kind: "block",
      reason: "needs approval",
    });
    await flushAsyncHandlers();
    expect(calls.map((call) => (call as { operation?: string }).operation)).toEqual(["replyMessage", "patchMessage"]);

    const final = adapter.postThreadState(target, {
      kind: "final",
      reason: "done",
    });
    await flushAsyncHandlers();
    expect(calls.map((call) => (call as { operation?: string }).operation)).toEqual(["replyMessage", "patchMessage"]);

    releaseFirstPatch?.();
    await Promise.all([blocked, final]);

    expect(calls.map((call) => (call as { operation?: string }).operation)).toEqual(["replyMessage", "patchMessage", "patchMessage"]);
    expect(calls[2]).toEqual({
      operation: "patchMessage",
      options: expect.objectContaining({
        content: expect.objectContaining({
          header: expect.objectContaining({
            template: "green",
            title: expect.objectContaining({
              content: "Codex finished",
            }),
          }),
        }),
      }),
    });
  });

  it("falls back to a fresh Feishu turn-state card when patching the previous card fails", async () => {
    const calls: unknown[] = [];
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeApi(calls, {
        patchMessageError: new Error("expired card"),
      }),
      wsClient: new FakeWsClient(),
      stateCardPatchDebounceMs: 0,
    });
    const target = {
      platform: "feishu" as const,
      conversationId: "oc_group",
      rootMessageId: "om_root",
    };

    await adapter.postThreadState(target, {
      kind: "wait",
      reason: "CI is still running",
    });
    await adapter.postThreadState(target, {
      kind: "final",
      reason: "done",
    });

    expect(calls.map((call) => (call as { operation?: string }).operation)).toEqual(["replyMessage", "patchMessage", "replyMessage"]);
  });

  it("lists Feishu history with thread containers, page cursors, and raw card content", async () => {
    const calls: unknown[] = [];
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeApi(calls, {
        listMessages: {
          has_more: true,
          page_token: "page_after_history",
          items: [
            {
              message_id: "om_history",
              root_id: "om_root",
              parent_id: "om_root",
              thread_id: "omt_thread",
              msg_type: "interactive",
              create_time: "1710000001000",
              chat_id: "oc_group",
              body: {
                content: JSON.stringify({
                  title: "Recovered card",
                }),
              },
              raw: {
                sender: {
                  id_type: "open_id",
                  id: "ou_user",
                  sender_type: "user",
                },
              },
            },
          ],
        },
      }),
      wsClient: new FakeWsClient(),
    });

    await expect(
      adapter.listThreadMessagePage({
        platform: "feishu",
        conversationId: "oc_group",
        conversationKind: "group",
        rootMessageId: "om_root",
        platformThreadId: "omt_thread",
        beforeCursor: "page_next",
        limit: 20,
      }),
    ).resolves.toEqual({
      hasMore: true,
      nextCursor: "page_after_history",
      messages: [
        expect.objectContaining({
          platform: "feishu",
          conversationId: "oc_group",
          rootMessageId: "om_root",
          platformThreadId: "omt_thread",
          messageId: "om_history",
          messageCursor: "1710000001000",
          source: "thread_reply",
          format: "card",
          text: "[Feishu card: Recovered card]",
        }),
      ],
    });

    expect(calls).toEqual([
      {
        operation: "listMessages",
        options: {
          containerIdType: "thread",
          containerId: "omt_thread",
          pageSize: 20,
          pageToken: "page_next",
          sortType: "ByCreateTimeAsc",
          cardMsgContentType: "user_card_content",
        },
      },
    ]);
  });

  it("filters chat-wide Feishu history to the requested root when no thread id is available", async () => {
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeApi([], {
        listMessages: {
          has_more: false,
          items: [
            {
              message_id: "om_root",
              msg_type: "text",
              create_time: "1710000000000",
              chat_id: "oc_group",
              body: {
                content: JSON.stringify({
                  text: "root message",
                }),
              },
              raw: {
                sender: {
                  id_type: "open_id",
                  id: "ou_user",
                  sender_type: "user",
                },
              },
            },
            {
              message_id: "om_reply",
              root_id: "om_root",
              parent_id: "om_root",
              msg_type: "text",
              create_time: "1710000001000",
              chat_id: "oc_group",
              body: {
                content: JSON.stringify({
                  text: "same root reply",
                }),
              },
              raw: {
                sender: {
                  id_type: "open_id",
                  id: "ou_user",
                  sender_type: "user",
                },
              },
            },
            {
              message_id: "om_other",
              root_id: "om_other",
              parent_id: "om_other",
              msg_type: "text",
              create_time: "1710000002000",
              chat_id: "oc_group",
              body: {
                content: JSON.stringify({
                  text: "other root",
                }),
              },
              raw: {
                sender: {
                  id_type: "open_id",
                  id: "ou_user",
                  sender_type: "user",
                },
              },
            },
          ],
        },
      }),
      wsClient: new FakeWsClient(),
    });

    await expect(
      adapter.listThreadMessagePage({
        platform: "feishu",
        conversationId: "oc_group",
        conversationKind: "group",
        rootMessageId: "om_root",
        limit: 20,
      }),
    ).resolves.toMatchObject({
      messages: [expect.objectContaining({ messageId: "om_root" }), expect.objectContaining({ messageId: "om_reply" })],
    });
  });

  it("starts a long-connection dispatcher and forwards group mention events", async () => {
    const wsClient = new FakeWsClient();
    const seen: unknown[] = [];
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeApi(),
      wsClient,
      botIdentity: {
        openId: "ou_bot",
      },
    });

    await adapter.start({
      onMessage: async (message) => {
        seen.push(message);
      },
    });

    await wsClient.emit("im.message.receive_v1", {
      sender: {
        sender_id: {
          open_id: "ou_user",
        },
        sender_type: "user",
      },
      message: {
        chat_id: "oc_group",
        chat_type: "group",
        message_id: "om_msg",
        message_type: "text",
        content: JSON.stringify({
          text: "@_user_1 hello",
        }),
        mentions: [
          {
            key: "@_user_1",
            id: {
              open_id: "ou_bot",
            },
            name: "Codex",
          },
        ],
      },
    });
    await flushAsyncHandlers();

    expect(seen).toEqual([
      expect.objectContaining({
        platform: "feishu",
        conversationId: "oc_group",
        rootMessageId: "om_msg",
        messageId: "om_msg",
        source: "bot_mention",
      }),
    ]);
  });

  it("returns from Feishu message dispatch before slow Codex work finishes", async () => {
    const wsClient = new FakeWsClient();
    let releaseHandler: (() => void) | undefined;
    let handlerStarted = false;
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeApi(),
      wsClient,
      botIdentity: {
        openId: "ou_bot",
      },
    });

    await adapter.start({
      onMessage: async () => {
        handlerStarted = true;
        await new Promise<void>((resolve) => {
          releaseHandler = resolve;
        });
      },
    });

    await expect(
      Promise.race([
        wsClient
          .emit("im.message.receive_v1", {
            sender: {
              sender_id: {
                open_id: "ou_user",
              },
              sender_type: "user",
            },
            message: {
              chat_id: "oc_group",
              chat_type: "group",
              message_id: "om_slow",
              message_type: "text",
              content: JSON.stringify({
                text: "@_user_1 slow work",
              }),
              mentions: [
                {
                  key: "@_user_1",
                  id: {
                    open_id: "ou_bot",
                  },
                  name: "Codex",
                },
              ],
            },
          })
          .then(() => "dispatched"),
        delay(50).then(() => "blocked"),
      ]),
    ).resolves.toBe("dispatched");

    await flushAsyncHandlers();
    expect(handlerStarted).toBe(true);
    releaseHandler?.();
  });

  it("logs detached Feishu handler failures without leaking message text", async () => {
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-handler-failed-"));
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const wsClient = new FakeWsClient();
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeApi(),
      wsClient,
    });

    await adapter.start({
      onMessage: async () => {
        throw new Error("SENTINEL_HANDLER_BODY");
      },
    });

    await wsClient.emit("im.message.receive_v1", {
      sender: {
        sender_id: {
          open_id: "ou_user",
        },
        sender_type: "user",
      },
      message: {
        chat_id: "oc_group",
        chat_type: "group",
        message_id: "om_handler_failed",
        message_type: "text",
        content: JSON.stringify({
          text: "SENTINEL_MESSAGE_BODY",
        }),
      },
    });
    await flushAsyncHandlers();
    await flushLogger();

    const records = await readJsonl(path.join(logDir, "broker.jsonl"));
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "chat.handler.failed",
          meta: expect.objectContaining({
            platform: "feishu",
            handler: "message",
            errorClass: "Error",
          }),
        }),
      ]),
    );
    expect(JSON.stringify(records)).not.toContain("SENTINEL_HANDLER_BODY");
    expect(JSON.stringify(records)).not.toContain("SENTINEL_MESSAGE_BODY");
  });

  it("logs ignored private chats without leaking message bodies", async () => {
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-adapter-logs-"));
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const wsClient = new FakeWsClient();
    const seen: unknown[] = [];
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeApi(),
      wsClient,
      botIdentity: {
        openId: "ou_bot",
      },
      groupMessageMode: "all",
    });

    await adapter.start({
      onMessage: async (message) => {
        seen.push(message);
      },
    });

    await wsClient.emit("im.message.receive_v1", {
      sender: {
        sender_id: {
          open_id: "ou_user",
        },
        sender_type: "user",
      },
      message: {
        chat_id: "oc_private",
        chat_type: "p2p",
        message_id: "om_private",
        message_type: "text",
        content: JSON.stringify({
          text: "SENTINEL_PRIVATE_BODY",
        }),
      },
    });
    await flushAsyncHandlers();
    await flushLogger();

    expect(seen).toEqual([]);
    const records = await readJsonl(path.join(logDir, "broker.jsonl"));
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "log",
          level: "info",
          message: "chat.platform.starting",
          meta: expect.objectContaining({
            platform: "feishu",
            source: "long_connection",
            groupMessageMode: "all",
            startupRequired: true,
          }),
        }),
        expect.objectContaining({
          type: "log",
          level: "info",
          message: "chat.platform.ready",
          meta: expect.objectContaining({
            platform: "feishu",
            source: "long_connection",
            groupMessageMode: "all",
          }),
        }),
        expect.objectContaining({
          type: "log",
          level: "info",
          message: "chat.message.ignored",
          meta: expect.objectContaining({
            platform: "feishu",
            conversationId: "oc_private",
            conversationKind: "direct",
            messageId: "om_private",
            eventId: "om_private",
            senderKind: "user",
            ignoredReason: "ignored_private_chat",
            route: "ignored_private_chat",
          }),
        }),
      ]),
    );
    expect(JSON.stringify(records)).not.toContain("SENTINEL_PRIVATE_BODY");
  });

  it("logs ignored bot sender messages without dispatching them", async () => {
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-adapter-bot-logs-"));
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const wsClient = new FakeWsClient();
    const seen: unknown[] = [];
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeApi(),
      wsClient,
      groupMessageMode: "all",
    });

    await adapter.start({
      onMessage: async (message) => {
        seen.push(message);
      },
    });

    await wsClient.emit("im.message.receive_v1", {
      sender: {
        sender_id: {
          open_id: "ou_any_bot",
        },
        sender_type: "bot",
      },
      message: {
        chat_id: "oc_group",
        chat_type: "group",
        message_id: "om_bot",
        message_type: "text",
        content: JSON.stringify({
          text: "SENTINEL_BOT_BODY",
        }),
      },
    });
    await flushAsyncHandlers();
    await flushLogger();

    expect(seen).toEqual([]);
    const records = await readJsonl(path.join(logDir, "broker.jsonl"));
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "log",
          level: "info",
          message: "chat.message.ignored",
          meta: expect.objectContaining({
            platform: "feishu",
            conversationId: "oc_group",
            conversationKind: "group",
            messageId: "om_bot",
            eventId: "om_bot",
            senderKind: "bot",
            ignoredReason: "ignored_self",
            route: "ignored_self",
          }),
        }),
      ]),
    );
    expect(JSON.stringify(records)).not.toContain("SENTINEL_BOT_BODY");
  });

  it("logs ignored configured bot identity messages without dispatching them", async () => {
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-adapter-self-identity-logs-"));
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const wsClient = new FakeWsClient();
    const seen: unknown[] = [];
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeApi(),
      wsClient,
      botIdentity: {
        userId: "bot-user-id",
      },
      groupMessageMode: "all",
    });

    await adapter.start({
      onMessage: async (message) => {
        seen.push(message);
      },
    });

    await wsClient.emit("im.message.receive_v1", {
      sender: {
        sender_id: {
          open_id: "ou_different_sender",
          user_id: "bot-user-id",
        },
        sender_type: "user",
      },
      message: {
        chat_id: "oc_group",
        chat_type: "group",
        message_id: "om_bot_user",
        message_type: "text",
        content: JSON.stringify({
          text: "SENTINEL_SELF_IDENTITY_BODY",
        }),
      },
    });
    await flushAsyncHandlers();
    await flushLogger();

    expect(seen).toEqual([]);
    const records = await readJsonl(path.join(logDir, "broker.jsonl"));
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "log",
          level: "info",
          message: "chat.message.ignored",
          meta: expect.objectContaining({
            platform: "feishu",
            conversationId: "oc_group",
            conversationKind: "group",
            messageId: "om_bot_user",
            eventId: "om_bot_user",
            senderKind: "user",
            ignoredReason: "ignored_self",
            route: "ignored_self",
          }),
        }),
      ]),
    );
    expect(JSON.stringify(records)).not.toContain("SENTINEL_SELF_IDENTITY_BODY");
  });

  it("logs ignored app sender messages without dispatching them", async () => {
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-adapter-app-logs-"));
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const wsClient = new FakeWsClient();
    const seen: unknown[] = [];
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeApi(),
      wsClient,
      groupMessageMode: "all",
    });

    await adapter.start({
      onMessage: async (message) => {
        seen.push(message);
      },
    });

    await wsClient.emit("im.message.receive_v1", {
      sender: {
        sender_id: {
          app_id: "cli-test",
        },
        sender_type: "app",
      },
      message: {
        chat_id: "oc_group",
        chat_type: "group",
        message_id: "om_app",
        message_type: "text",
        content: JSON.stringify({
          text: "SENTINEL_APP_BODY",
        }),
      },
    });
    await flushAsyncHandlers();
    await flushLogger();

    expect(seen).toEqual([]);
    const records = await readJsonl(path.join(logDir, "broker.jsonl"));
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "log",
          level: "info",
          message: "chat.message.ignored",
          meta: expect.objectContaining({
            platform: "feishu",
            conversationId: "oc_group",
            conversationKind: "group",
            messageId: "om_app",
            eventId: "om_app",
            senderKind: "app",
            ignoredReason: "ignored_self",
            route: "ignored_self",
          }),
        }),
      ]),
    );
    expect(JSON.stringify(records)).not.toContain("SENTINEL_APP_BODY");
  });

  it("logs invalid Feishu events with required ignored fields", async () => {
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-adapter-invalid-logs-"));
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const wsClient = new FakeWsClient();
    const seen: unknown[] = [];
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeApi(),
      wsClient,
      groupMessageMode: "all",
    });

    await adapter.start({
      onMessage: async (message) => {
        seen.push(message);
      },
    });

    await wsClient.emit("im.message.receive_v1", {
      header: {
        event_id: "evt_invalid",
      },
      event: {
        message: {
          content: JSON.stringify({
            text: "SENTINEL_INVALID_BODY",
          }),
        },
      },
    });
    await flushAsyncHandlers();
    await flushLogger();

    expect(seen).toEqual([]);
    const records = await readJsonl(path.join(logDir, "broker.jsonl"));
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "log",
          level: "info",
          message: "chat.message.ignored",
          meta: expect.objectContaining({
            platform: "feishu",
            conversationId: "unknown",
            conversationKind: "unknown",
            messageId: "unknown",
            eventId: "evt_invalid",
            senderKind: "unknown",
            ignoredReason: "ignored_invalid_event",
            route: "ignored_invalid_event",
          }),
        }),
      ]),
    );
    expect(JSON.stringify(records)).not.toContain("SENTINEL_INVALID_BODY");
  });

  it("logs retained Feishu rich payloads by reference without copying bodies", async () => {
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-adapter-rich-logs-"));
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const wsClient = new FakeWsClient();
    const seen: unknown[] = [];
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeApi(),
      wsClient,
    });

    await adapter.start({
      onMessage: async (message) => {
        seen.push(message);
      },
    });

    await wsClient.emit("im.message.receive_v1", {
      sender: {
        sender_id: {
          open_id: "ou_user",
        },
        sender_type: "user",
      },
      message: {
        chat_id: "oc_group",
        chat_type: "group",
        message_id: "om_rich",
        message_type: "post",
        content: JSON.stringify({
          title: "Status",
          content: [[{ tag: "text", text: "RICH_SENTINEL_BODY" }]],
        }),
      },
    });
    await flushLogger();

    expect(seen).toEqual([
      expect.objectContaining({
        format: "rich_text",
        rawMessage: expect.objectContaining({
          message_id: "om_rich",
        }),
      }),
    ]);
    const records = await readJsonl(path.join(logDir, "broker.jsonl"));
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "log",
          level: "info",
          message: "chat.message.accepted",
          meta: expect.objectContaining({
            platform: "feishu",
            conversationId: "oc_group",
            conversationKind: "group",
            messageId: "om_rich",
            eventId: "om_rich",
            msgType: "rich_text",
            route: "group_message",
            payloadRef: "feishu-message:om_rich",
          }),
        }),
      ]),
    );
    expect(JSON.stringify(records)).not.toContain("RICH_SENTINEL_BODY");
  });

  it("logs Feishu image and file messages as resource msgTypes with retained payload references", async () => {
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-adapter-resource-logs-"));
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const wsClient = new FakeWsClient();
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeApi(),
      wsClient,
    });

    await adapter.start({
      onMessage: async () => {},
    });

    await wsClient.emit("im.message.receive_v1", {
      sender: {
        sender_id: {
          open_id: "ou_user",
        },
        sender_type: "user",
      },
      message: {
        chat_id: "oc_group",
        chat_type: "group",
        message_id: "om_image",
        message_type: "image",
        content: JSON.stringify({
          image_key: "img_v2_key",
        }),
      },
    });
    await wsClient.emit("im.message.receive_v1", {
      sender: {
        sender_id: {
          open_id: "ou_user",
        },
        sender_type: "user",
      },
      message: {
        chat_id: "oc_group",
        chat_type: "group",
        message_id: "om_file",
        message_type: "file",
        content: JSON.stringify({
          file_key: "file_v2_key",
          file_name: "report.pdf",
        }),
      },
    });
    await flushAsyncHandlers();
    await flushLogger();

    const records = await readJsonl(path.join(logDir, "broker.jsonl"));
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "log",
          level: "info",
          message: "chat.message.accepted",
          meta: expect.objectContaining({
            platform: "feishu",
            messageId: "om_image",
            msgType: "image",
            fileId: "img_v2_key",
            payloadRef: "feishu-message:om_image",
          }),
        }),
        expect.objectContaining({
          type: "log",
          level: "info",
          message: "chat.message.accepted",
          meta: expect.objectContaining({
            platform: "feishu",
            messageId: "om_file",
            msgType: "file",
            fileId: "file_v2_key",
            payloadRef: "feishu-message:om_file",
          }),
        }),
      ]),
    );
  });

  it("writes raw Feishu events only when the raw stream is explicitly enabled", async () => {
    const disabledLogDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-raw-disabled-"));
    configureLogger({
      logDir: disabledLogDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const disabledWsClient = new FakeWsClient();
    const disabledAdapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeApi(),
      wsClient: disabledWsClient,
    });
    await disabledAdapter.start({
      onMessage: async () => {},
    });

    await disabledWsClient.emit("im.message.receive_v1", {
      sender: {
        sender_id: {
          open_id: "ou_user",
        },
        sender_type: "user",
      },
      message: {
        chat_id: "oc_group",
        chat_type: "group",
        message_id: "om_raw_disabled",
        message_type: "text",
        content: JSON.stringify({
          text: "RAW_DISABLED_SENTINEL",
        }),
      },
    });
    await flushLogger();

    await expect(fs.readFile(path.join(disabledLogDir, "raw", "feishu-events.jsonl"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const enabledLogDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-raw-enabled-"));
    configureLogger({
      logDir: enabledLogDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: true,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const enabledWsClient = new FakeWsClient();
    const enabledAdapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeApi(),
      wsClient: enabledWsClient,
    });
    await enabledAdapter.start({
      onMessage: async () => {},
    });

    await enabledWsClient.emit("im.message.receive_v1", {
      sender: {
        sender_id: {
          open_id: "ou_user",
        },
        sender_type: "user",
      },
      message: {
        chat_id: "oc_group",
        chat_type: "group",
        message_id: "om_raw_enabled",
        message_type: "text",
        content: JSON.stringify({
          text: "RAW_ENABLED_SENTINEL",
        }),
      },
    });
    await flushLogger();

    const rawRecords = await readJsonl(path.join(enabledLogDir, "raw", "feishu-events.jsonl"));
    expect(rawRecords).toEqual([
      expect.objectContaining({
        type: "raw",
        stream: "feishu-events",
        payload: expect.objectContaining({
          event_type: "im.message.receive_v1",
          message: expect.objectContaining({
            message_id: "om_raw_enabled",
          }),
        }),
        meta: {
          platform: "feishu",
        },
      }),
    ]);
    expect(JSON.stringify(rawRecords)).toContain("RAW_ENABLED_SENTINEL");
  });

  it("posts Feishu replies using the root message id", async () => {
    const calls: unknown[] = [];
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeApi(calls),
      wsClient: new FakeWsClient(),
    });

    const posted = await adapter.postThreadMessage(
      {
        platform: "feishu",
        conversationId: "oc_group",
        rootMessageId: "om_root",
      },
      {
        text: "done",
      },
    );

    expect(posted).toMatchObject({
      platform: "feishu",
      conversationId: "oc_group",
      rootMessageId: "om_root",
      messageId: "om_reply",
    });
    expect(calls).toEqual([
      {
        operation: "replyMessage",
        options: {
          messageId: "om_root",
          msgType: "text",
          content: {
            text: "done",
          },
          replyInThread: true,
        },
      },
    ]);
  });

  it("converts markdown replies into Feishu post messages", async () => {
    const calls: unknown[] = [];
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeApi(calls),
      wsClient: new FakeWsClient(),
    });

    await adapter.postThreadMessage(
      {
        platform: "feishu",
        conversationId: "oc_group",
        rootMessageId: "om_root",
      },
      {
        text: "Build passed\n\n- tests green",
        format: "markdown",
      },
    );

    expect(calls).toEqual([
      {
        operation: "replyMessage",
        options: {
          messageId: "om_root",
          msgType: "post",
          content: {
            zh_cn: {
              content: [[{ tag: "text", text: "Build passed" }], [{ tag: "text", text: "- tests green" }]],
            },
          },
          replyInThread: true,
        },
      },
    ]);
  });

  it("uploads images before replying with Feishu image messages", async () => {
    const calls: unknown[] = [];
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeApi(calls),
      wsClient: new FakeWsClient(),
    });

    const uploaded = await adapter.uploadThreadFile(
      {
        platform: "feishu",
        conversationId: "oc_group",
        rootMessageId: "om_root",
      },
      {
        contentBase64: Buffer.from("png").toString("base64"),
        filename: "chart.png",
        contentType: "image/png",
        title: "chart",
        initialComment: "see attached",
      },
    );

    expect(uploaded).toMatchObject({
      platform: "feishu",
      fileId: "img_uploaded",
      title: "chart",
      name: "chart.png",
      mimetype: "image/png",
      size: 3,
    });
    expect(calls).toEqual([
      {
        operation: "replyMessage",
        options: {
          messageId: "om_root",
          msgType: "text",
          content: {
            text: "see attached",
          },
          replyInThread: true,
        },
      },
      {
        operation: "uploadMessageImage",
        options: {
          bytes: Buffer.from("png"),
        },
      },
      {
        operation: "replyMessage",
        options: {
          messageId: "om_root",
          msgType: "image",
          content: {
            image_key: "img_uploaded",
          },
          replyInThread: true,
        },
      },
    ]);
  });

  it("uploads generic files before replying with Feishu file messages", async () => {
    const calls: unknown[] = [];
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeApi(calls),
      wsClient: new FakeWsClient(),
    });

    const uploaded = await adapter.uploadThreadFile(
      {
        platform: "feishu",
        conversationId: "oc_group",
        rootMessageId: "om_root",
      },
      {
        contentBase64: Buffer.from("pdf").toString("base64"),
        filename: "report.pdf",
        contentType: "application/pdf",
      },
    );

    expect(uploaded).toMatchObject({
      platform: "feishu",
      fileId: "file_uploaded",
      title: "report.pdf",
      name: "report.pdf",
      mimetype: "application/pdf",
      size: 3,
    });
    expect(calls).toEqual([
      {
        operation: "uploadMessageFile",
        options: {
          bytes: Buffer.from("pdf"),
          filename: "report.pdf",
          fileType: "pdf",
        },
      },
      {
        operation: "replyMessage",
        options: {
          messageId: "om_root",
          msgType: "file",
          content: {
            file_key: "file_uploaded",
          },
          replyInThread: true,
        },
      },
    ]);
  });

  it("describes canonical and alias file source names when Feishu file source is ambiguous", async () => {
    const calls: unknown[] = [];
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeApi(calls),
      wsClient: new FakeWsClient(),
    });

    await expect(
      adapter.uploadThreadFile(
        {
          platform: "feishu",
          conversationId: "oc_group",
          rootMessageId: "om_root",
        },
        {},
      ),
    ).rejects.toThrow(CHAT_FILE_SOURCE_REQUIREMENT_MESSAGE);
    await expect(
      adapter.uploadThreadFile(
        {
          platform: "feishu",
          conversationId: "oc_group",
          rootMessageId: "om_root",
        },
        {
          filePath: "/tmp/report.txt",
          contentBase64: Buffer.from("pdf").toString("base64"),
          filename: "report.pdf",
        },
      ),
    ).rejects.toThrow(CHAT_FILE_SOURCE_REQUIREMENT_MESSAGE);

    expect(calls).toEqual([]);
  });

  it("describes canonical inline content names when Feishu inline file filename is missing", async () => {
    const calls: unknown[] = [];
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeApi(calls),
      wsClient: new FakeWsClient(),
    });

    await expect(
      adapter.uploadThreadFile(
        {
          platform: "feishu",
          conversationId: "oc_group",
          rootMessageId: "om_root",
        },
        {
          contentBase64: Buffer.from("pdf").toString("base64"),
        },
      ),
    ).rejects.toThrow(CHAT_INLINE_FILE_FILENAME_REQUIREMENT_MESSAGE);

    expect(calls).toEqual([]);
  });

  it("describes canonical inline content names when Feishu inline file content is invalid", async () => {
    const calls: unknown[] = [];
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeApi(calls),
      wsClient: new FakeWsClient(),
    });

    await expect(
      adapter.uploadThreadFile(
        {
          platform: "feishu",
          conversationId: "oc_group",
          rootMessageId: "om_root",
        },
        {
          contentBase64: "!!!!",
          filename: "report.pdf",
        },
      ),
    ).rejects.toThrow(CHAT_INLINE_FILE_CONTENT_REQUIREMENT_MESSAGE);

    expect(calls).toEqual([]);
  });

  it("falls back to file upload for images above the Feishu message-image limit", async () => {
    const calls: unknown[] = [];
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeApi(calls),
      wsClient: new FakeWsClient(),
    });
    const largeImage = Buffer.alloc(10 * 1024 * 1024 + 1);

    const uploaded = await adapter.uploadThreadFile(
      {
        platform: "feishu",
        conversationId: "oc_group",
        rootMessageId: "om_root",
      },
      {
        contentBase64: largeImage.toString("base64"),
        filename: "large.png",
        contentType: "image/png",
      },
    );

    expect(uploaded).toMatchObject({
      platform: "feishu",
      fileId: "file_uploaded",
      kind: "file",
      name: "large.png",
      mimetype: "image/png",
      size: largeImage.byteLength,
    });
    expect(calls).toEqual([
      expect.objectContaining({
        operation: "uploadMessageFile",
        options: expect.objectContaining({
          filename: "large.png",
          fileType: "stream",
        }),
      }),
      expect.objectContaining({
        operation: "replyMessage",
        options: expect.objectContaining({
          messageId: "om_root",
          msgType: "file",
          content: {
            file_key: "file_uploaded",
          },
          replyInThread: true,
        }),
      }),
    ]);
  });

  it("rejects files above the Feishu upload limit before posting or uploading", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-oversize-upload-"));
    const filePath = path.join(tempDir, "too-large.pdf");
    await fs.writeFile(filePath, Buffer.alloc(30 * 1024 * 1024 + 1));
    const calls: unknown[] = [];
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeApi(calls),
      wsClient: new FakeWsClient(),
    });

    await expect(
      adapter.uploadThreadFile(
        {
          platform: "feishu",
          conversationId: "oc_group",
          rootMessageId: "om_root",
        },
        {
          filePath,
          filename: "too-large.pdf",
          contentType: "application/pdf",
          initialComment: "this should not post before validation",
        },
      ),
    ).rejects.toThrow("Feishu file upload exceeds 30 MB limit");
    expect(calls).toEqual([]);
  });

  it("downloads Feishu resources with kind-specific size and type restrictions", async () => {
    const calls: unknown[] = [];
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeApi(calls),
      wsClient: new FakeWsClient(),
    });

    await expect(
      adapter.downloadAttachment({
        platform: "feishu",
        id: "img_v2_key",
        kind: "image",
        messageId: "om_image",
        resourceKey: "img_v2_key",
      }),
    ).resolves.toBe("data:image/png;base64,aGVsbG8=");
    await expect(
      adapter.downloadAttachment({
        platform: "feishu",
        id: "file_v2_key",
        kind: "file",
        messageId: "om_file",
        resourceKey: "file_v2_key",
      }),
    ).resolves.toBe("data:image/png;base64,aGVsbG8=");

    expect(calls).toEqual([
      {
        operation: "downloadMessageResourceAsDataUrl",
        options: {
          messageId: "om_image",
          fileKey: "img_v2_key",
          type: "image",
          maxBytes: 10 * 1024 * 1024,
          allowedContentTypes: ["image/"],
        },
      },
      {
        operation: "downloadMessageResourceAsDataUrl",
        options: {
          messageId: "om_file",
          fileKey: "file_v2_key",
          type: "file",
          maxBytes: 30 * 1024 * 1024,
          allowedContentTypes: undefined,
        },
      },
    ]);
  });

  it("routes Feishu card callbacks through the interactive handler", async () => {
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-card-callback-"));
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const wsClient = new FakeWsClient();
    const callbacks: unknown[] = [];
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeApi(),
      wsClient,
    });

    await adapter.start({
      onMessage: async () => {},
      onInteractive: async (payload) => {
        callbacks.push(payload);
      },
    });

    await wsClient.emit("card.action.trigger", {
      event_id: "evt_card_1",
      token: "callback-token",
      open_id: "ou_user",
      open_message_id: "om_card",
      action: {
        value: {
          sessionKey: "feishu:b2M:b20",
          conversationId: "oc",
          rootMessageId: "om",
        },
      },
    });
    await flushAsyncHandlers();
    await flushLogger();

    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]).toMatchObject({
      event_id: "evt_card_1",
      open_message_id: "om_card",
    });
    const records = await readJsonl(path.join(logDir, "broker.jsonl"));
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "chat.card.callback.received",
          meta: expect.objectContaining({
            platform: "feishu",
            conversationId: "oc",
            rootMessageId: "om",
            eventId: "evt_card_1",
            messageId: "om_card",
          }),
        }),
      ]),
    );
    expect(JSON.stringify(records)).not.toContain("callback-token");
  });

  it("logs Feishu card callback session keys when action values arrive as JSON strings", async () => {
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-card-callback-string-value-"));
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const wsClient = new FakeWsClient();
    const callbacks: unknown[] = [];
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeApi(),
      wsClient,
    });

    await adapter.start({
      onMessage: async () => {},
      onInteractive: async (payload) => {
        callbacks.push(payload);
      },
    });

    await wsClient.emit("card.action.trigger", {
      event_id: "evt_card_string_value",
      open_message_id: "om_card",
      action: {
        value: JSON.stringify({
          sessionKey: "feishu:b2M:b20",
          conversationId: "oc",
          rootMessageId: "om",
          candidateRevision: 2,
          kind: "coauthor_confirm_all",
        }),
      },
    });
    await flushAsyncHandlers();
    await flushLogger();

    expect(callbacks).toHaveLength(1);
    const records = await readJsonl(path.join(logDir, "broker.jsonl"));
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "chat.card.callback.received",
          meta: expect.objectContaining({
            platform: "feishu",
            sessionKey: "feishu:b2M:b20",
            conversationId: "oc",
            rootMessageId: "om",
            eventId: "evt_card_string_value",
            messageId: "om_card",
            payloadRef: "feishu-card:evt_card_string_value",
            kind: "coauthor_confirm_all",
            candidateRevision: 2,
          }),
        }),
      ]),
    );
  });

  it("logs malformed Feishu card callbacks with required fields", async () => {
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-card-callback-invalid-"));
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const wsClient = new FakeWsClient();
    const callbacks: unknown[] = [];
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeApi(),
      wsClient,
    });

    await adapter.start({
      onMessage: async () => {},
      onInteractive: async (payload) => {
        callbacks.push(payload);
      },
    });

    await wsClient.emit("card.action.trigger", {
      token: "SENTINEL_CALLBACK_TOKEN",
      action: {
        value: {},
      },
    });
    await flushAsyncHandlers();
    await flushLogger();

    expect(callbacks).toHaveLength(1);
    const records = await readJsonl(path.join(logDir, "broker.jsonl"));
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "chat.card.callback.received",
          meta: expect.objectContaining({
            platform: "feishu",
            sessionKey: "unknown",
            conversationId: "unknown",
            rootMessageId: "unknown",
            eventId: "unknown",
            messageId: "unknown",
            payloadRef: "feishu-card:unknown",
            ackDurationMs: expect.any(Number),
          }),
        }),
      ]),
    );
    expect(JSON.stringify(records)).not.toContain("SENTINEL_CALLBACK_TOKEN");
  });

  it("returns from Feishu card callback dispatch before slow interactive work finishes", async () => {
    const wsClient = new FakeWsClient();
    let releaseHandler: (() => void) | undefined;
    let handlerStarted = false;
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeApi(),
      wsClient,
    });

    await adapter.start({
      onMessage: async () => {},
      onInteractive: async () => {
        handlerStarted = true;
        await new Promise<void>((resolve) => {
          releaseHandler = resolve;
        });
      },
    });

    await expect(
      Promise.race([
        wsClient
          .emit("card.action.trigger", {
            event_id: "evt_card_slow",
            open_message_id: "om_card",
            action: {
              value: {
                sessionKey: "feishu:b2M:b20",
                conversationId: "oc",
                rootMessageId: "om",
              },
            },
          })
          .then(() => "dispatched"),
        delay(50).then(() => "blocked"),
      ]),
    ).resolves.toBe("dispatched");

    await flushAsyncHandlers();
    expect(handlerStarted).toBe(true);
    releaseHandler?.();
  });
});

async function readJsonl(filePath: string): Promise<unknown[]> {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

class FakeWsClient {
  dispatcher: { invoke: (data: unknown) => Promise<unknown> } | undefined;
  closed = false;

  async start(options: { eventDispatcher: { invoke: (data: unknown) => Promise<unknown> } }) {
    this.dispatcher = options.eventDispatcher;
  }

  close() {
    this.closed = true;
  }

  async emit(eventType: string, data: unknown) {
    await this.dispatcher?.invoke({
      schema: "2.0",
      header: {
        event_type: eventType,
      },
      event: data,
    });
  }
}

function flushAsyncHandlers(): Promise<void> {
  return delay(0);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function postedFeishuTextCalls(calls: readonly unknown[]): string[] {
  return calls
    .map((call) => call as { readonly operation?: string; readonly options?: { readonly content?: { readonly text?: string } } })
    .filter((call) => call.operation === "replyMessage")
    .map((call) => call.options?.content?.text)
    .filter((text): text is string => Boolean(text));
}

function createFakeApi(
  calls: unknown[] = [],
  options?: {
    readonly listMessages?: unknown;
    readonly patchMessageError?: unknown;
    readonly firstPatchBlocker?: Promise<void> | undefined;
  },
) {
  let patchCount = 0;
  return {
    replyMessage: async (options: unknown) => {
      calls.push({ operation: "replyMessage", options });
      return {
        message_id: "om_reply",
        root_id: "om_root",
        create_time: "1710000000000",
      };
    },
    patchMessage: async (payload: unknown) => {
      calls.push({ operation: "patchMessage", options: payload });
      patchCount += 1;
      if (patchCount === 1 && options?.firstPatchBlocker) {
        await options.firstPatchBlocker;
      }
      if (options?.patchMessageError) {
        throw options.patchMessageError;
      }
      return {
        message_id: "om_reply",
        root_id: "om_root",
        create_time: "1710000000000",
      };
    },
    listMessages: async (payload: unknown) => {
      calls.push({ operation: "listMessages", options: payload });
      return (
        options?.listMessages ?? {
          has_more: false,
          items: [],
        }
      );
    },
    uploadMessageImage: async (options: unknown) => {
      calls.push({ operation: "uploadMessageImage", options });
      return {
        image_key: "img_uploaded",
      };
    },
    uploadMessageFile: async (options: unknown) => {
      calls.push({ operation: "uploadMessageFile", options });
      return {
        file_key: "file_uploaded",
      };
    },
    downloadMessageResourceAsDataUrl: async (options: unknown) => {
      calls.push({ operation: "downloadMessageResourceAsDataUrl", options });
      return "data:image/png;base64,aGVsbG8=";
    },
  } as any;
}
