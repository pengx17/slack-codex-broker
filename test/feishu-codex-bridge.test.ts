/* oxlint-disable max-lines */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { configureLogger, flushLogger } from "../src/logger.js";
import type { ChatTurnProjection } from "../src/services/chat/chat-turn-projection.js";
import type { ChatAttachment, ChatInputMessage, ChatOutboundFile, ChatPostedMessage, ChatThreadMessage, ChatThreadPage, ChatThreadQuery, ChatThreadTarget, ChatUploadedFile, ChatUserIdentity } from "../src/services/chat/chat-types.js";
import type { ChatPlatformAdapter, ChatPlatformHandlers } from "../src/services/chat/chat-platform-adapter.js";
import { FeishuCodexBridge } from "../src/services/feishu/feishu-codex-bridge.js";
import { FeishuPlatformAdapter } from "../src/services/feishu/feishu-platform-adapter.js";
import { GitHubAuthorMappingService } from "../src/services/github-author-mapping-service.js";
import { SessionManager } from "../src/services/session-manager.js";
import { StateStore } from "../src/store/state-store.js";

describe("FeishuCodexBridge", () => {
  it("starts a Feishu group mention as a persisted Codex session", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-bridge-"));
    const logDir = path.join(dataRoot, "logs");
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const sessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    await sessions.load();
    const adapter = new FakeFeishuAdapter();
    const codex = new FakeCodex();
    const bridge = new FeishuCodexBridge({
      sessions,
      adapter,
      codex: codex as never,
      groupMessageMode: "all",
    });

    await bridge.start();
    await adapter.emit({
      platform: "feishu",
      conversationId: "oc_group",
      conversationKind: "group",
      rootMessageId: "om_root",
      platformThreadId: "omt_thread",
      messageId: "om_root",
      messageCursor: "1710000000000",
      source: "bot_mention",
      sender: {
        kind: "user",
        userId: "ou_user",
      },
      text: "please check this",
    });
    await flushLogger();

    expect(
      sessions.getChatSession({
        platform: "feishu",
        conversationId: "oc_group",
        rootMessageId: "om_root",
      }),
    ).toMatchObject({
      platform: "feishu",
      conversationId: "oc_group",
      conversationKind: "group",
      rootMessageId: "om_root",
      platformThreadId: "omt_thread",
      codexThreadId: "thread-1",
      activeTurnId: undefined,
      lastObservedMessageTs: "1710000000000",
      coAuthorCandidateUserIds: ["ou_user"],
      coAuthorCandidateRevision: 1,
    });
    expect(codex.ensureThreadSessions).toEqual([
      expect.objectContaining({
        platform: "feishu",
        conversationId: "oc_group",
        rootMessageId: "om_root",
      }),
    ]);
    expect(codex.startedTurns).toEqual([
      expect.objectContaining({
        session: expect.objectContaining({
          platform: "feishu",
        }),
        inputText: expect.stringContaining("please check this"),
      }),
    ]);
    const logs = await readJsonl(path.join(logDir, "broker.jsonl"));
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "chat.session.created",
          meta: expect.objectContaining({
            platform: "feishu",
            sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
            groupMessageMode: "all",
          }),
        }),
        expect.objectContaining({
          message: "chat.turn.started",
          meta: expect.objectContaining({
            platform: "feishu",
            turnId: "turn-1",
          }),
        }),
        expect.objectContaining({
          message: "chat.turn.completed",
          meta: expect.objectContaining({
            platform: "feishu",
            turnId: "turn-1",
          }),
        }),
      ]),
    );
    const sessionKey = "feishu:b2NfZ3JvdXA:b21fcm9vdA";
    const sessionLogs = await readJsonl(path.join(logDir, "sessions", `${Buffer.from(sessionKey, "utf8").toString("base64url")}.jsonl`));
    expect(sessionLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "chat.session.created",
          meta: expect.objectContaining({
            platform: "feishu",
            sessionKey,
          }),
        }),
      ]),
    );
  });

  it("accepts a raw Feishu group mention through the adapter and creates matching session evidence", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-adapter-e2e-"));
    const logDir = path.join(dataRoot, "logs");
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const sessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    await sessions.load();
    const wsClient = new FakeFeishuWsClient();
    const codex = new FakeCodex();
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeFeishuApi(),
      wsClient,
      botIdentity: {
        openId: "ou_bot",
      },
      groupMessageMode: "all",
    });
    const bridge = new FeishuCodexBridge({
      sessions,
      adapter,
      codex: codex as never,
      groupMessageMode: "all",
    });

    await bridge.start();
    await wsClient.emit("im.message.receive_v1", {
      header: {
        event_id: "evt_adapter_mention",
      },
      event: {
        sender: {
          sender_id: {
            open_id: "ou_user",
          },
          sender_type: "user",
        },
        message: {
          chat_id: "oc_group",
          chat_type: "group",
          message_id: "om_adapter_root",
          root_id: "",
          parent_id: "",
          thread_id: "omt_adapter_thread",
          create_time: "1710000000000",
          message_type: "text",
          content: JSON.stringify({
            text: "@_user_1 ship it",
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
      },
    });
    await waitForCondition(() => codex.startedTurns.length === 1, "Feishu adapter turn start");
    await waitForCondition(() => {
      const currentSession = sessions.getChatSession({
        platform: "feishu",
        conversationId: "oc_group",
        rootMessageId: "om_adapter_root",
      });
      return currentSession?.codexThreadId === "thread-1" && currentSession.activeTurnId === undefined;
    }, "Feishu adapter turn completion");
    const session = sessions.getChatSession({
      platform: "feishu",
      conversationId: "oc_group",
      rootMessageId: "om_adapter_root",
    });
    const logPath = path.join(logDir, "broker.jsonl");
    const logs = await waitForJsonlRecords(logPath, "Feishu adapter session evidence logs", (records) =>
      records.some((record) => {
        const logRecord = record as {
          readonly message?: unknown;
          readonly meta?:
            | {
                readonly platform?: unknown;
                readonly sessionKey?: unknown;
                readonly turnId?: unknown;
                readonly batchId?: unknown;
              }
            | undefined;
        };
        return logRecord.message === "chat.turn.completed" && logRecord.meta?.platform === "feishu" && logRecord.meta.sessionKey === session?.key && logRecord.meta.turnId === "turn-1" && logRecord.meta.batchId === "om_adapter_root";
      }),
    );

    expect(session).toMatchObject({
      platform: "feishu",
      conversationId: "oc_group",
      conversationKind: "group",
      rootMessageId: "om_adapter_root",
      platformThreadId: "omt_adapter_thread",
      codexThreadId: "thread-1",
      activeTurnId: undefined,
    });
    expect(codex.startedTurns[0]?.inputText).toContain("ship it");

    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "chat.message.accepted",
          meta: expect.objectContaining({
            platform: "feishu",
            conversationId: "oc_group",
            conversationKind: "group",
            rootMessageId: "om_adapter_root",
            messageId: "om_adapter_root",
            eventId: "evt_adapter_mention",
            senderKind: "user",
            msgType: "text",
            route: "bot_mention",
          }),
        }),
        expect.objectContaining({
          message: "chat.session.created",
          meta: expect.objectContaining({
            platform: "feishu",
            sessionKey: session?.key,
            conversationId: "oc_group",
            rootMessageId: "om_adapter_root",
            messageId: "om_adapter_root",
            groupMessageMode: "all",
          }),
        }),
        expect.objectContaining({
          message: "chat.turn.started",
          meta: expect.objectContaining({
            platform: "feishu",
            sessionKey: session?.key,
            turnId: "turn-1",
            codexThreadId: "thread-1",
            messageId: "om_adapter_root",
            batchId: "om_adapter_root",
          }),
        }),
        expect.objectContaining({
          message: "chat.turn.completed",
          meta: expect.objectContaining({
            platform: "feishu",
            sessionKey: session?.key,
            turnId: "turn-1",
            codexThreadId: "thread-1",
            batchId: "om_adapter_root",
          }),
        }),
      ]),
    );
    expect(logs).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "chat.message.ignored",
          meta: expect.objectContaining({
            platform: "feishu",
            conversationId: "oc_group",
            messageId: "om_adapter_root",
          }),
        }),
      ]),
    );
  });

  it("deduplicates repeated Feishu message deliveries by conversation and message id before starting another turn", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-dedupe-"));
    const logDir = path.join(dataRoot, "logs");
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const sessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    await sessions.load();
    const adapter = new FakeFeishuAdapter();
    const codex = new FakeCodex();
    const bridge = new FeishuCodexBridge({
      sessions,
      adapter,
      codex: codex as never,
      groupMessageMode: "all",
    });
    const message: ChatInputMessage = {
      platform: "feishu",
      conversationId: "oc_group",
      conversationKind: "group",
      rootMessageId: "om_root",
      messageId: "om_duplicate",
      eventId: "evt_duplicate_1",
      source: "bot_mention",
      sender: {
        kind: "user",
        userId: "ou_user",
      },
      text: "start once",
    };

    await bridge.start();
    await adapter.emit(message);
    await adapter.emit({
      ...message,
      rootMessageId: "om_root_drifted",
    });
    await flushLogger();

    expect(codex.startedTurns).toHaveLength(1);
    expect(codex.startedTurns[0]?.inputText).toContain("start once");
    const logs = await readJsonl(path.join(logDir, "broker.jsonl"));
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "chat.message.deduped",
          meta: expect.objectContaining({
            platform: "feishu",
            conversationId: "oc_group",
            rootMessageId: "om_root_drifted",
            messageId: "om_duplicate",
            eventId: "evt_duplicate_1",
            route: "deduped",
          }),
        }),
      ]),
    );
  });

  it("ignores non-mention group messages without an active session with replay coordinates", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-no-active-"));
    const logDir = path.join(dataRoot, "logs");
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const sessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    await sessions.load();
    const adapter = new FakeFeishuAdapter();
    const codex = new FakeCodex();
    const bridge = new FeishuCodexBridge({
      sessions,
      adapter,
      codex: codex as never,
      groupMessageMode: "all",
    });

    await bridge.start();
    await adapter.emit({
      platform: "feishu",
      conversationId: "oc_group",
      conversationKind: "group",
      rootMessageId: "om_orphan",
      messageId: "om_orphan",
      eventId: "evt_orphan",
      source: "group_message",
      sender: {
        kind: "user",
        userId: "ou_user",
      },
      text: "no active session",
    });
    await flushLogger();

    expect(codex.startedTurns).toEqual([]);
    expect(codex.steers).toEqual([]);
    expect(sessions.listSessions()).toEqual([]);
    const logs = await readJsonl(path.join(logDir, "broker.jsonl"));
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "chat.message.ignored",
          meta: expect.objectContaining({
            platform: "feishu",
            conversationId: "oc_group",
            conversationKind: "group",
            rootMessageId: "om_orphan",
            messageId: "om_orphan",
            eventId: "evt_orphan",
            senderKind: "user",
            ignoredReason: "ignored_no_active_session",
            route: "ignored_no_active_session",
          }),
        }),
      ]),
    );
  });

  it("downloads Feishu image attachments into Codex image input", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-resource-"));
    const sessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    await sessions.load();
    const adapter = new FakeFeishuAdapter();
    const codex = new FakeCodex();
    const bridge = new FeishuCodexBridge({
      sessions,
      adapter,
      codex: codex as never,
      groupMessageMode: "all",
    });

    await bridge.start();
    await adapter.emit({
      platform: "feishu",
      conversationId: "oc_group",
      conversationKind: "group",
      rootMessageId: "om_image",
      messageId: "om_image",
      source: "bot_mention",
      sender: {
        kind: "user",
        userId: "ou_user",
      },
      text: "[Feishu image]",
      attachments: [
        {
          platform: "feishu",
          id: "img_v2_key",
          kind: "image",
          messageId: "om_image",
          resourceKey: "img_v2_key",
        },
      ],
    });

    expect(codex.startedTurns).toHaveLength(1);
    expect(codex.startedTurns[0]?.inputText).toContain("Feishu attachment:");
    expect(codex.startedTurns[0]?.inputText).toContain("- kind: image");
    expect(codex.startedTurns[0]?.inputText).toContain("- resource_key: img_v2_key");
    expect(codex.startedTurns[0]?.inputText).toContain("- transfer_status: downloaded_as_image_input");
    expect(codex.startedTurns[0]?.imageUrls).toEqual(["data:image/png;base64,aGVsbG8="]);
    expect(adapter.downloadedAttachments).toEqual([
      expect.objectContaining({
        id: "img_v2_key",
        kind: "image",
        resourceKey: "img_v2_key",
      }),
    ]);
  });

  it("logs Feishu image download failures with replayable session coordinates", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-download-failed-"));
    const logDir = path.join(dataRoot, "logs");
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const sessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    await sessions.load();
    const adapter = new FakeFeishuAdapter();
    adapter.downloadError = new Error("download failed");
    const codex = new FakeCodex();
    const bridge = new FeishuCodexBridge({
      sessions,
      adapter,
      codex: codex as never,
      groupMessageMode: "all",
    });

    await bridge.start();
    await adapter.emit({
      platform: "feishu",
      conversationId: "oc_group",
      conversationKind: "group",
      rootMessageId: "om_image_failed",
      messageId: "om_image_failed",
      source: "bot_mention",
      sender: {
        kind: "user",
        userId: "ou_user",
      },
      text: "[Feishu image]",
      attachments: [
        {
          platform: "feishu",
          id: "img_v2_key",
          kind: "image",
          messageId: "om_image_failed",
          resourceKey: "img_v2_key",
        },
      ],
    });
    await flushLogger();

    expect(codex.startedTurns).toHaveLength(1);
    expect(codex.startedTurns[0]?.inputText).toContain("- transfer_status: download_unavailable");
    expect(codex.startedTurns[0]?.imageUrls).toEqual([]);
    const records = await readJsonl(path.join(logDir, "broker.jsonl"));
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "log",
          level: "warn",
          message: "chat.attachment.download_failed",
          meta: expect.objectContaining({
            platform: "feishu",
            sessionKey: SessionManager.createChatKey({
              platform: "feishu",
              conversationId: "oc_group",
              rootMessageId: "om_image_failed",
            }),
            conversationId: "oc_group",
            rootMessageId: "om_image_failed",
            messageId: "om_image_failed",
            attachmentId: "img_v2_key",
            kind: "image",
            errorClass: "Error",
          }),
        }),
      ]),
    );
  });

  it("posts Feishu chat messages through the platform adapter", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-post-"));
    const logDir = path.join(dataRoot, "logs");
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const sessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    await sessions.load();
    const adapter = new FakeFeishuAdapter();
    const bridge = new FeishuCodexBridge({
      sessions,
      adapter,
      codex: new FakeCodex() as never,
      groupMessageMode: "all",
    });

    await bridge.postChatMessage({
      conversationId: "oc_group",
      rootMessageId: "om_root",
      text: "done",
      format: "text",
    });

    expect(adapter.postedMessages).toEqual([
      {
        target: {
          platform: "feishu",
          conversationId: "oc_group",
          rootMessageId: "om_root",
        },
        message: {
          text: "done",
          format: "text",
          richText: undefined,
          card: undefined,
        },
      },
    ]);
    await flushLogger();
    const logs = await readJsonl(path.join(logDir, "broker.jsonl"));
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "chat.outbound.posted",
          meta: expect.objectContaining({
            platform: "feishu",
            sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
            conversationId: "oc_group",
            rootMessageId: "om_root",
            format: "text",
          }),
        }),
      ]),
    );
  });

  it("keeps Feishu outbound success logs field-complete when the API omits message id", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-post-missing-id-"));
    const logDir = path.join(dataRoot, "logs");
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const sessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    await sessions.load();
    const adapter = new FakeFeishuAdapter();
    adapter.postedMessageId = undefined;
    const bridge = new FeishuCodexBridge({
      sessions,
      adapter,
      codex: new FakeCodex() as never,
      groupMessageMode: "all",
    });

    await bridge.postChatMessage({
      conversationId: "oc_group",
      rootMessageId: "om_root",
      text: "done",
      format: "text",
    });

    await flushLogger();
    const logs = await readJsonl(path.join(logDir, "broker.jsonl"));
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "chat.outbound.posted",
          meta: expect.objectContaining({
            platform: "feishu",
            sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
            conversationId: "oc_group",
            rootMessageId: "om_root",
            messageId: "unknown",
            format: "text",
            durationMs: 0,
          }),
        }),
      ]),
    );
    expect(JSON.stringify(logs)).not.toContain("done");
  });

  it("logs Feishu outbound failures with replay coordinates", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-post-fail-"));
    const logDir = path.join(dataRoot, "logs");
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const sessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    await sessions.load();
    const adapter = new FakeFeishuAdapter();
    adapter.postError = Object.assign(new Error("rate limited"), {
      statusCode: 429,
    });
    const bridge = new FeishuCodexBridge({
      sessions,
      adapter,
      codex: new FakeCodex() as never,
      groupMessageMode: "all",
    });

    await expect(
      bridge.postChatMessage({
        conversationId: "oc_group",
        rootMessageId: "om_root",
        text: "done",
        format: "text",
      }),
    ).rejects.toThrow("rate limited");

    await flushLogger();
    const logs = await readJsonl(path.join(logDir, "broker.jsonl"));
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warn",
          message: "chat.outbound.failed",
          meta: expect.objectContaining({
            platform: "feishu",
            sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
            conversationId: "oc_group",
            rootMessageId: "om_root",
            format: "text",
            errorClass: "Error",
            statusCode: 429,
            attempt: 1,
          }),
        }),
      ]),
    );
    expect(JSON.stringify(logs)).not.toContain("done");
  });

  it("keeps Feishu outbound failure log fields complete when no HTTP status is available", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-post-fail-unknown-"));
    const logDir = path.join(dataRoot, "logs");
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const sessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    await sessions.load();
    const adapter = new FakeFeishuAdapter();
    adapter.postError = new Error("network disappeared");
    const bridge = new FeishuCodexBridge({
      sessions,
      adapter,
      codex: new FakeCodex() as never,
      groupMessageMode: "all",
    });

    await expect(
      bridge.postChatMessage({
        conversationId: "oc_group",
        rootMessageId: "om_root",
        text: "done",
        format: "text",
      }),
    ).rejects.toThrow("network disappeared");

    await flushLogger();
    const logs = await readJsonl(path.join(logDir, "broker.jsonl"));
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warn",
          message: "chat.outbound.failed",
          meta: expect.objectContaining({
            platform: "feishu",
            sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
            conversationId: "oc_group",
            rootMessageId: "om_root",
            format: "text",
            errorClass: "Error",
            statusCode: "unknown",
            attempt: 1,
          }),
        }),
      ]),
    );
  });

  it("chunks long Feishu chat messages before posting", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-chunk-"));
    const sessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    await sessions.load();
    const adapter = new FakeFeishuAdapter();
    const bridge = new FeishuCodexBridge({
      sessions,
      adapter,
      codex: new FakeCodex() as never,
      groupMessageMode: "all",
    });

    await bridge.postChatMessage({
      conversationId: "oc_group",
      rootMessageId: "om_root",
      text: `${"a".repeat(3900)}\n${"b".repeat(3900)}`,
      format: "markdown",
    });

    expect(adapter.postedMessages).toHaveLength(2);
    expect(adapter.postedMessages[0]).toMatchObject({
      message: {
        text: "a".repeat(3900),
        format: "markdown",
      },
    });
    expect(adapter.postedMessages[1]).toMatchObject({
      message: {
        text: "b".repeat(3900),
        format: "markdown",
      },
    });
  });

  it("serializes concurrent Feishu chat messages per chat so cross-root chunks stay ordered", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-outbound-queue-"));
    const sessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    await sessions.load();
    const adapter = new FakeFeishuAdapter();
    adapter.postDelayMs = 5;
    const bridge = new FeishuCodexBridge({
      sessions,
      adapter,
      codex: new FakeCodex() as never,
      groupMessageMode: "all",
    });

    await Promise.all([
      bridge.postChatMessage({
        conversationId: "oc_group",
        rootMessageId: "om_root",
        text: `${"a".repeat(3900)}\n${"b".repeat(3900)}`,
        format: "markdown",
      }),
      bridge.postChatMessage({
        conversationId: "oc_group",
        rootMessageId: "om_other_root",
        text: `${"c".repeat(3900)}\n${"d".repeat(3900)}`,
        format: "markdown",
      }),
    ]);

    expect(adapter.maxConcurrentPosts).toBe(1);
    expect(adapter.postedMessages.map((entry) => asPostedMessageText(entry))).toEqual(["a".repeat(3900), "b".repeat(3900), "c".repeat(3900), "d".repeat(3900)]);
    expect(adapter.postedMessages.map((entry) => asPostedMessageRoot(entry))).toEqual(["om_root", "om_root", "om_other_root", "om_other_root"]);
  });

  it("uploads Feishu files through the adapter and logs replay coordinates", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-upload-"));
    const logDir = path.join(dataRoot, "logs");
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const sessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    await sessions.load();
    const adapter = new FakeFeishuAdapter();
    const bridge = new FeishuCodexBridge({
      sessions,
      adapter,
      codex: new FakeCodex() as never,
      groupMessageMode: "all",
    });

    const uploaded = await bridge.postChatFile({
      conversationId: "oc_group",
      rootMessageId: "om_root",
      contentBase64: Buffer.from("pdf").toString("base64"),
      filename: "report.pdf",
      contentType: "application/pdf",
      initialComment: "see attached",
    });
    await flushLogger();

    expect(uploaded).toMatchObject({
      platform: "feishu",
      fileId: "file_uploaded",
      name: "report.pdf",
    });
    expect(adapter.uploadedFiles).toEqual([
      {
        target: {
          platform: "feishu",
          conversationId: "oc_group",
          rootMessageId: "om_root",
        },
        file: {
          contentBase64: Buffer.from("pdf").toString("base64"),
          filename: "report.pdf",
          contentType: "application/pdf",
          initialComment: "see attached",
        },
      },
    ]);
    const logs = await readJsonl(path.join(logDir, "broker.jsonl"));
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "chat.outbound.posted",
          meta: expect.objectContaining({
            platform: "feishu",
            sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
            conversationId: "oc_group",
            rootMessageId: "om_root",
            fileId: "file_uploaded",
            format: "file",
          }),
        }),
      ]),
    );
  });

  it("logs Feishu outbound failure coordinates when file upload is unsupported", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-upload-unsupported-"));
    const logDir = path.join(dataRoot, "logs");
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const sessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    await sessions.load();
    const adapter: ChatPlatformAdapter = {
      platform: "feishu",
      start: async () => undefined,
      stop: async () => undefined,
      getBotIdentity: async () => null,
      listThreadMessages: async () => [],
      postThreadMessage: async () => ({
        platform: "feishu",
        conversationId: "oc_group",
        rootMessageId: "om_root",
        messageId: "om_reply",
      }),
      getUserIdentity: async () => null,
    };
    const bridge = new FeishuCodexBridge({
      sessions,
      adapter,
      codex: new FakeCodex() as never,
      groupMessageMode: "all",
    });

    await expect(
      bridge.postChatFile({
        conversationId: "oc_group",
        rootMessageId: "om_root",
        contentBase64: Buffer.from("pdf").toString("base64"),
        filename: "report.pdf",
        contentType: "application/pdf",
      }),
    ).rejects.toThrow("Feishu adapter does not support file upload");
    await flushLogger();

    const logs = await readJsonl(path.join(logDir, "broker.jsonl"));
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "chat.outbound.failed",
          meta: expect.objectContaining({
            platform: "feishu",
            sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
            conversationId: "oc_group",
            rootMessageId: "om_root",
            format: "file",
            errorClass: "Error",
            statusCode: "unknown",
            attempt: 1,
          }),
        }),
      ]),
    );
  });

  it("uses the adapter upload kind when logging Feishu uploaded image files", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-large-image-upload-"));
    const logDir = path.join(dataRoot, "logs");
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const sessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    await sessions.load();
    const adapter = new FakeFeishuAdapter();
    adapter.uploadKind = "file";
    const bridge = new FeishuCodexBridge({
      sessions,
      adapter,
      codex: new FakeCodex() as never,
      groupMessageMode: "all",
    });

    await bridge.postChatFile({
      conversationId: "oc_group",
      rootMessageId: "om_root",
      contentBase64: Buffer.from("large image").toString("base64"),
      filename: "large.png",
      contentType: "image/png",
    });
    await flushLogger();

    const logs = await readJsonl(path.join(logDir, "broker.jsonl"));
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "chat.outbound.posted",
          meta: expect.objectContaining({
            platform: "feishu",
            fileId: "file_uploaded",
            format: "file",
          }),
        }),
      ]),
    );
  });

  it("renders Feishu turn-state updates as static interactive cards", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-card-"));
    const sessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    await sessions.load();
    const adapter = new FakeFeishuAdapter();
    const bridge = new FeishuCodexBridge({
      sessions,
      adapter,
      codex: new FakeCodex() as never,
      groupMessageMode: "all",
    });

    await bridge.postChatMessage({
      conversationId: "oc_group",
      rootMessageId: "om_root",
      text: "Waiting for CI to finish.",
      kind: "wait",
      reason: "ci still running",
    });

    expect(adapter.postedMessages).toEqual([
      {
        target: {
          platform: "feishu",
          conversationId: "oc_group",
          rootMessageId: "om_root",
        },
        message: {
          text: "Waiting for CI to finish.",
          format: "card",
          richText: undefined,
          card: expect.objectContaining({
            config: expect.objectContaining({
              wide_screen_mode: true,
            }),
            header: expect.objectContaining({
              template: "yellow",
            }),
            elements: expect.arrayContaining([
              expect.objectContaining({
                tag: "div",
                text: expect.objectContaining({
                  tag: "lark_md",
                  content: expect.stringContaining("Waiting for CI to finish."),
                }),
              }),
              expect.objectContaining({
                tag: "note",
                elements: expect.arrayContaining([
                  expect.objectContaining({
                    content: expect.stringContaining("ci still running"),
                  }),
                ]),
              }),
            ]),
          }),
        },
      },
    ]);
  });

  it("projects Feishu progress messages into the active state card instead of posting noisy replies", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-progress-projection-"));
    const logDir = path.join(dataRoot, "logs");
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const sessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    await sessions.load();
    const adapter = new FakeFeishuAdapter();
    const bridge = new FeishuCodexBridge({
      sessions,
      adapter,
      codex: new FakeCodex() as never,
      groupMessageMode: "all",
    });

    await bridge.postChatMessage({
      conversationId: "oc_group",
      rootMessageId: "om_root",
      text: "tool: exec_command\npnpm test",
      kind: "progress",
    });
    await flushLogger();

    expect(adapter.postedMessages).toEqual([]);
    expect(adapter.postedProjections).toEqual([
      {
        target: {
          platform: "feishu",
          conversationId: "oc_group",
          rootMessageId: "om_root",
        },
        projection: expect.objectContaining({
          status: "running_tool",
          slots: [
            expect.objectContaining({
              kind: "tool",
              title: "Tool: exec_command",
            }),
          ],
        }),
      },
    ]);
    const logs = await readJsonl(path.join(logDir, "broker.jsonl"));
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "chat.outbound.posted",
          meta: expect.objectContaining({
            platform: "feishu",
            messageId: "state",
            format: "card",
          }),
        }),
      ]),
    );
  });

  it("keeps Feishu final replies readable when state-card projection fails", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-final-projection-fail-"));
    const logDir = path.join(dataRoot, "logs");
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const sessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    await sessions.load();
    const adapter = new FakeFeishuAdapter();
    adapter.projectionError = Object.assign(new Error("card expired"), {
      statusCode: 404,
    });
    const bridge = new FeishuCodexBridge({
      sessions,
      adapter,
      codex: new FakeCodex() as never,
      groupMessageMode: "all",
    });

    await expect(
      bridge.postChatMessage({
        conversationId: "oc_group",
        rootMessageId: "om_root",
        text: "Final answer is still visible.",
        kind: "final",
      }),
    ).resolves.toMatchObject({
      messageId: "om_reply",
    });
    await flushLogger();

    expect(adapter.postedMessages).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({
          text: "Final answer is still visible.",
        }),
      }),
    ]);
    expect(adapter.postedProjections).toHaveLength(1);
    const logs = await readJsonl(path.join(logDir, "broker.jsonl"));
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "chat.outbound.posted",
          meta: expect.objectContaining({
            platform: "feishu",
            messageId: "om_reply",
            format: "card",
          }),
        }),
        expect.objectContaining({
          level: "warn",
          message: "chat.outbound.failed",
          meta: expect.objectContaining({
            platform: "feishu",
            format: "card",
            statusCode: 404,
          }),
        }),
      ]),
    );
  });

  it("confirms Feishu co-authors through a card callback before resolving commit trailers", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-coauthors-"));
    const logDir = path.join(dataRoot, "logs");
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const sessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    const mappings = new GitHubAuthorMappingService({
      stateDir: path.join(dataRoot, "state"),
    });
    const coordinates = {
      platform: "feishu" as const,
      conversationId: "oc_group",
      rootMessageId: "om_root",
    };
    await sessions.load();
    await mappings.load();
    const session = await sessions.ensureChatSession(coordinates, {
      conversationKind: "group",
    });
    await sessions.addChatCoAuthorCandidates(coordinates, ["ou_user"]);
    await mappings.upsertManualMapping({
      platform: "feishu",
      userId: "ou_user",
      githubAuthor: "Alice Example <alice@example.com>",
      identity: {
        platform: "feishu",
        userId: "ou_user",
        mention: "@ou_user",
        displayName: "Alice Example",
      },
    });
    const adapter = new FakeFeishuAdapter();
    const bridge = new FeishuCodexBridge({
      sessions,
      adapter,
      codex: new FakeCodex() as never,
      groupMessageMode: "all",
      mappings,
    });

    await bridge.start();
    const blocked = await bridge.resolveCommitCoauthors({
      cwd: session.workspacePath,
      commitMessage: "feat(feishu): demo",
    });

    expect(blocked).toMatchObject({
      status: "blocked",
      errorCode: "coauthor_confirmation_required",
      sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
    });
    expect(adapter.postedMessages).toEqual([
      {
        target: {
          platform: "feishu",
          conversationId: "oc_group",
          rootMessageId: "om_root",
          platformThreadId: undefined,
        },
        message: {
          text: "Git commit paused: confirm Feishu co-authors before retrying the commit.",
          format: "card",
          card: expect.objectContaining({
            header: expect.objectContaining({
              title: expect.objectContaining({
                content: "Confirm co-authors",
              }),
            }),
            elements: expect.arrayContaining([
              expect.objectContaining({
                tag: "action",
                actions: expect.arrayContaining([
                  expect.objectContaining({
                    text: expect.objectContaining({
                      content: "Confirm all",
                    }),
                    value: expect.objectContaining({
                      kind: "coauthor_confirm_all",
                      sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
                      conversationId: "oc_group",
                      rootMessageId: "om_root",
                      candidateRevision: 1,
                    }),
                  }),
                ]),
              }),
            ]),
          }),
        },
      },
    ]);

    await adapter.emitInteractive({
      action: {
        value: JSON.stringify({
          kind: "coauthor_confirm_all",
          sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
          conversationId: "oc_group",
          rootMessageId: "om_root",
          candidateRevision: "1",
        }),
      },
    });

    const resolved = await bridge.resolveCommitCoauthors({
      cwd: session.workspacePath,
      commitMessage: "feat(feishu): demo",
      primaryAuthorEmail: "broker@example.com",
    });
    expect(resolved.status).toBe("resolved");
    expect(resolved.commitMessage).toContain("Co-authored-by: Alice Example <alice@example.com>");
    await flushLogger();
    const logs = await readJsonl(path.join(logDir, "broker.jsonl"));
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "chat.outbound.posted",
          meta: expect.objectContaining({
            platform: "feishu",
            sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
            conversationId: "oc_group",
            rootMessageId: "om_root",
            messageId: "om_reply",
            format: "card",
          }),
        }),
        expect.objectContaining({
          message: "chat.coauthor.confirmed",
          meta: expect.objectContaining({
            platform: "feishu",
            sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
            conversationId: "oc_group",
            rootMessageId: "om_root",
            candidateRevision: 1,
            confirmedCount: 1,
          }),
        }),
        expect.objectContaining({
          message: "chat.outbound.posted",
          meta: expect.objectContaining({
            platform: "feishu",
            sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
            conversationId: "oc_group",
            rootMessageId: "om_root",
            messageId: "om_reply",
            format: "text",
          }),
        }),
      ]),
    );
    expect(JSON.stringify(logs)).not.toContain("Co-authors confirmed");
  });

  it("records ordered Feishu co-author card callback evidence through the platform adapter", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-coauthors-adapter-"));
    const logDir = path.join(dataRoot, "logs");
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const sessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    const mappings = new GitHubAuthorMappingService({
      stateDir: path.join(dataRoot, "state"),
    });
    const coordinates = {
      platform: "feishu" as const,
      conversationId: "oc_group",
      rootMessageId: "om_root",
    };
    await sessions.load();
    await mappings.load();
    const session = await sessions.ensureChatSession(coordinates, {
      conversationKind: "group",
    });
    await sessions.addChatCoAuthorCandidates(coordinates, ["ou_user"]);
    await mappings.upsertManualMapping({
      platform: "feishu",
      userId: "ou_user",
      githubAuthor: "Alice Example <alice@example.com>",
      identity: {
        platform: "feishu",
        userId: "ou_user",
        mention: "@ou_user",
        displayName: "Alice Example",
      },
    });
    const wsClient = new FakeFeishuWsClient();
    const adapter = new FeishuPlatformAdapter({
      appId: "cli-test",
      appSecret: "secret-test",
      api: createFakeFeishuApi(),
      wsClient,
      botIdentity: {
        openId: "ou_bot",
      },
      groupMessageMode: "all",
    });
    const bridge = new FeishuCodexBridge({
      sessions,
      adapter,
      codex: new FakeCodex() as never,
      groupMessageMode: "all",
      mappings,
    });

    await bridge.start();
    await expect(
      bridge.resolveCommitCoauthors({
        cwd: session.workspacePath,
        commitMessage: "feat(feishu): demo",
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      errorCode: "coauthor_confirmation_required",
      sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
    });
    await wsClient.emit("card.action.trigger", {
      event_id: "evt_coauthor_confirm",
      open_message_id: "om_reply",
      action: {
        value: JSON.stringify({
          kind: "coauthor_confirm_all",
          sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
          conversationId: "oc_group",
          rootMessageId: "om_root",
          candidateRevision: "1",
        }),
      },
    });

    const logPath = path.join(logDir, "broker.jsonl");
    const logs = await waitForJsonlRecords(logPath, "ordered Feishu co-author callback evidence", (records) =>
      records.some((record) => {
        const logRecord = record as {
          readonly message?: unknown;
          readonly meta?: { readonly candidateRevision?: unknown } | undefined;
        };
        return logRecord.message === "chat.coauthor.confirmed" && logRecord.meta?.candidateRevision === 1;
      }),
    );
    const resolved = await bridge.resolveCommitCoauthors({
      cwd: session.workspacePath,
      commitMessage: "feat(feishu): demo",
      primaryAuthorEmail: "broker@example.com",
    });

    expect(resolved.status).toBe("resolved");
    const cardPostedIndex = logs.findIndex((record) =>
      isLogRecord(record, "chat.outbound.posted", {
        platform: "feishu",
        sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
        conversationId: "oc_group",
        rootMessageId: "om_root",
        messageId: "om_reply",
        format: "card",
      }),
    );
    const callbackIndex = logs.findIndex((record) =>
      isLogRecord(record, "chat.card.callback.received", {
        platform: "feishu",
        sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
        conversationId: "oc_group",
        rootMessageId: "om_root",
        eventId: "evt_coauthor_confirm",
        messageId: "om_reply",
        kind: "coauthor_confirm_all",
        candidateRevision: 1,
      }),
    );
    const confirmedIndex = logs.findIndex((record) =>
      isLogRecord(record, "chat.coauthor.confirmed", {
        platform: "feishu",
        sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
        conversationId: "oc_group",
        rootMessageId: "om_root",
        candidateRevision: 1,
        confirmedCount: 1,
      }),
    );

    expect(cardPostedIndex).toBeGreaterThanOrEqual(0);
    expect(callbackIndex).toBeGreaterThan(cardPostedIndex);
    expect(confirmedIndex).toBeGreaterThan(callbackIndex);
  });

  it("ignores Feishu co-author card callbacks whose action coordinates do not match the session", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-coauthor-coordinate-mismatch-"));
    const logDir = path.join(dataRoot, "logs");
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const sessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    const coordinates = {
      platform: "feishu" as const,
      conversationId: "oc_group",
      rootMessageId: "om_root",
    };
    await sessions.load();
    const session = await sessions.ensureChatSession(coordinates, {
      conversationKind: "group",
    });
    await sessions.addChatCoAuthorCandidates(coordinates, ["ou_user"]);
    const adapter = new FakeFeishuAdapter();
    const bridge = new FeishuCodexBridge({
      sessions,
      adapter,
      codex: new FakeCodex() as never,
      groupMessageMode: "all",
    });

    await bridge.start();
    await expect(
      bridge.resolveCommitCoauthors({
        cwd: session.workspacePath,
        commitMessage: "feat(feishu): demo",
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      errorCode: "coauthor_confirmation_required",
    });

    await adapter.emitInteractive({
      action: {
        value: JSON.stringify({
          kind: "coauthor_confirm_all",
          sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
          conversationId: "oc_other",
          rootMessageId: "om_root",
          candidateRevision: "1",
        }),
      },
    });

    await expect(
      bridge.resolveCommitCoauthors({
        cwd: session.workspacePath,
        commitMessage: "feat(feishu): demo",
        primaryAuthorEmail: "broker@example.com",
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      errorCode: "coauthor_confirmation_required",
    });
    await flushLogger();
    const logs = await readJsonl(path.join(logDir, "broker.jsonl"));
    expect(logs.some((record) => (record as { readonly message?: string }).message === "chat.coauthor.confirmed")).toBe(false);
    expect(adapter.postedMessages).toHaveLength(1);
  });

  it("allows Feishu co-author card callbacks to skip co-authors for the current revision", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-coauthor-skip-"));
    const logDir = path.join(dataRoot, "logs");
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const sessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    const coordinates = {
      platform: "feishu" as const,
      conversationId: "oc_group",
      rootMessageId: "om_root",
    };
    await sessions.load();
    const session = await sessions.ensureChatSession(coordinates, {
      conversationKind: "group",
    });
    await sessions.addChatCoAuthorCandidates(coordinates, ["ou_user"]);
    const adapter = new FakeFeishuAdapter();
    const bridge = new FeishuCodexBridge({
      sessions,
      adapter,
      codex: new FakeCodex() as never,
      groupMessageMode: "all",
    });

    await bridge.start();
    const blocked = await bridge.resolveCommitCoauthors({
      cwd: session.workspacePath,
      commitMessage: "feat(feishu): demo",
    });

    expect(blocked).toMatchObject({
      status: "blocked",
      errorCode: "coauthor_confirmation_required",
      sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
    });
    expect(adapter.postedMessages).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({
          format: "card",
          card: expect.objectContaining({
            elements: expect.arrayContaining([
              expect.objectContaining({
                tag: "action",
                actions: expect.arrayContaining([
                  expect.objectContaining({
                    text: expect.objectContaining({
                      content: "Skip co-authors",
                    }),
                    value: expect.objectContaining({
                      kind: "coauthor_skip",
                      sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
                      conversationId: "oc_group",
                      rootMessageId: "om_root",
                      candidateRevision: 1,
                    }),
                  }),
                ]),
              }),
            ]),
          }),
        }),
      }),
    ]);

    await adapter.emitInteractive({
      action: {
        value: JSON.stringify({
          kind: "coauthor_skip",
          sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
          conversationId: "oc_group",
          rootMessageId: "om_root",
          candidateRevision: "1",
        }),
      },
    });

    const resolved = await bridge.resolveCommitCoauthors({
      cwd: session.workspacePath,
      commitMessage: "feat(feishu): demo",
      primaryAuthorEmail: "broker@example.com",
    });
    expect(resolved).toEqual({
      status: "noop",
      sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
      coAuthors: [],
    });
    await flushLogger();
    const logs = await readJsonl(path.join(logDir, "broker.jsonl"));
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "chat.coauthor.confirmed",
          meta: expect.objectContaining({
            platform: "feishu",
            sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
            conversationId: "oc_group",
            rootMessageId: "om_root",
            candidateRevision: 1,
            confirmedCount: 0,
          }),
        }),
        expect.objectContaining({
          message: "chat.outbound.posted",
          meta: expect.objectContaining({
            platform: "feishu",
            sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
            conversationId: "oc_group",
            rootMessageId: "om_root",
            messageId: "om_reply",
            format: "text",
          }),
        }),
      ]),
    );
    expect(JSON.stringify(logs)).not.toContain("ou_user");
  });

  it("records Feishu chat state as a persisted turn signal", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-state-"));
    const logDir = path.join(dataRoot, "logs");
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const sessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    const coordinates = {
      platform: "feishu" as const,
      conversationId: "oc_group",
      rootMessageId: "om_root",
    };
    await sessions.load();
    await sessions.ensureChatSession(coordinates, {
      conversationKind: "group",
    });
    await sessions.setChatCodexThreadId(coordinates, "thread-1");
    await sessions.setChatActiveTurnId(coordinates, "turn-1");
    const adapter = new FakeFeishuAdapter();
    const bridge = new FeishuCodexBridge({
      sessions,
      adapter,
      codex: new FakeCodex() as never,
      groupMessageMode: "all",
    });

    await bridge.postChatState({
      conversationId: "oc_group",
      rootMessageId: "om_root",
      kind: "final",
      reason: "done",
    });
    await flushLogger();

    expect(sessions.getChatSession(coordinates)).toMatchObject({
      lastTurnSignalTurnId: "turn-1",
      lastTurnSignalKind: "final",
      lastTurnSignalReason: "done",
    });
    expect(adapter.postedStates).toEqual([
      {
        target: coordinates,
        state: {
          kind: "final",
          reason: "done",
        },
      },
    ]);
    const logs = await readJsonl(path.join(logDir, "broker.jsonl"));
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "chat.turn.completed",
          meta: expect.objectContaining({
            platform: "feishu",
            sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
            turnId: "turn-1",
            codexThreadId: "thread-1",
            durationMs: 0,
            batchId: "state",
          }),
        }),
        expect.objectContaining({
          message: "chat.outbound.posted",
          meta: expect.objectContaining({
            platform: "feishu",
            sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
            format: "card",
            messageId: "state",
          }),
        }),
      ]),
    );
  });

  it("returns Feishu bounded history page cursors through the bridge", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-history-page-"));
    const sessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    await sessions.load();
    const adapter = new FakeFeishuAdapter();
    adapter.historyPage = {
      hasMore: true,
      nextCursor: "page_next",
      messages: [
        {
          platform: "feishu",
          conversationId: "oc_group",
          conversationKind: "group",
          rootMessageId: "om_root",
          messageId: "om_history",
          messageCursor: "1710000001000",
          source: "thread_reply",
          sender: {
            kind: "user",
            userId: "ou_user",
          },
          text: "older context",
        },
      ],
    };
    const bridge = new FeishuCodexBridge({
      sessions,
      adapter,
      codex: new FakeCodex() as never,
      groupMessageMode: "all",
      historyApiMaxLimit: 10,
    });

    await expect(
      bridge.readChatThreadHistory({
        conversationId: "oc_group",
        rootMessageId: "om_root",
        beforeCursor: "page_current",
        limit: 20,
      }),
    ).resolves.toMatchObject({
      hasMore: true,
      nextCursor: "page_next",
      formattedText: expect.stringContaining("older context"),
    });
    expect(adapter.historyQueries).toEqual([
      {
        platform: "feishu",
        conversationId: "oc_group",
        rootMessageId: "om_root",
        beforeMessageId: undefined,
        beforeCursor: "page_current",
        limit: 10,
      },
    ]);
  });

  it("uses the configured Feishu initial history count when no explicit history limit is requested", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-history-default-limit-"));
    const sessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    await sessions.load();
    const adapter = new FakeFeishuAdapter();
    const bridge = new FeishuCodexBridge({
      sessions,
      adapter,
      codex: new FakeCodex() as never,
      groupMessageMode: "all",
      initialThreadHistoryCount: 6,
      historyApiMaxLimit: 10,
    });

    await bridge.readChatThreadHistory({
      conversationId: "oc_group",
      rootMessageId: "om_root",
    });

    expect(adapter.historyQueries).toEqual([
      {
        platform: "feishu",
        conversationId: "oc_group",
        rootMessageId: "om_root",
        beforeMessageId: undefined,
        beforeCursor: undefined,
        limit: 6,
      },
    ]);
  });

  it("interrupts the active Feishu turn when the same group sends stop", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-stop-"));
    const logDir = path.join(dataRoot, "logs");
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const sessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    const coordinates = {
      platform: "feishu" as const,
      conversationId: "oc_group",
      rootMessageId: "om_root",
    };
    await sessions.load();
    await sessions.ensureChatSession(coordinates, {
      conversationKind: "group",
    });
    await sessions.setChatCodexThreadId(coordinates, "thread-1");
    await sessions.setChatActiveTurnId(coordinates, "turn-1");
    const adapter = new FakeFeishuAdapter();
    const codex = new FakeCodex();
    const bridge = new FeishuCodexBridge({
      sessions,
      adapter,
      codex: codex as never,
      groupMessageMode: "all",
    });

    await bridge.start();
    await adapter.emit({
      platform: "feishu",
      conversationId: "oc_group",
      conversationKind: "group",
      rootMessageId: "om_root",
      messageId: "om_stop",
      source: "group_message",
      sender: {
        kind: "user",
        userId: "ou_user",
      },
      text: "-stop",
    });

    expect(codex.interruptedSessions).toEqual([
      expect.objectContaining({
        key: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
        activeTurnId: "turn-1",
      }),
    ]);
    expect(sessions.getChatSession(coordinates)?.activeTurnId).toBeUndefined();
    expect(adapter.postedMessages).toEqual([
      {
        target: {
          platform: "feishu",
          conversationId: "oc_group",
          rootMessageId: "om_root",
          platformThreadId: undefined,
        },
        message: {
          text: "Stopped the current run.",
        },
      },
    ]);
    await flushLogger();
    const logs = await readJsonl(path.join(logDir, "broker.jsonl"));
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "chat.outbound.posted",
          meta: expect.objectContaining({
            platform: "feishu",
            sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
            conversationId: "oc_group",
            rootMessageId: "om_root",
            messageId: "om_reply",
            format: "text",
          }),
        }),
        expect.objectContaining({
          message: "chat.turn.stopped",
          meta: expect.objectContaining({
            platform: "feishu",
            sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
            conversationId: "oc_group",
            rootMessageId: "om_root",
            messageId: "om_stop",
            turnId: "turn-1",
            hadActiveTurn: true,
          }),
        }),
      ]),
    );
  });

  it("keeps Feishu stop logs field-complete when no active turn exists", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-stop-idle-"));
    const logDir = path.join(dataRoot, "logs");
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const sessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    const coordinates = {
      platform: "feishu" as const,
      conversationId: "oc_group",
      rootMessageId: "om_root",
    };
    await sessions.load();
    await sessions.ensureChatSession(coordinates, {
      conversationKind: "group",
    });
    await sessions.setChatCodexThreadId(coordinates, "thread-1");
    const adapter = new FakeFeishuAdapter();
    const bridge = new FeishuCodexBridge({
      sessions,
      adapter,
      codex: new FakeCodex() as never,
      groupMessageMode: "all",
    });

    await bridge.start();
    await adapter.emit({
      platform: "feishu",
      conversationId: "oc_group",
      conversationKind: "group",
      rootMessageId: "om_root",
      messageId: "om_stop_idle",
      source: "group_message",
      sender: {
        kind: "user",
        userId: "ou_user",
      },
      text: "-stop",
    });

    expect(adapter.postedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: {
            text: "No active run to stop.",
          },
        }),
      ]),
    );
    await flushLogger();
    const logs = await readJsonl(path.join(logDir, "broker.jsonl"));
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "chat.turn.stopped",
          meta: expect.objectContaining({
            platform: "feishu",
            sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
            conversationId: "oc_group",
            rootMessageId: "om_root",
            messageId: "om_stop_idle",
            turnId: "none",
            hadActiveTurn: false,
          }),
        }),
      ]),
    );
  });

  it("recovers active Feishu sessions from persisted state after restart", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-restart-"));
    const logDir = path.join(dataRoot, "logs");
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const coordinates = {
      platform: "feishu" as const,
      conversationId: "oc_group",
      rootMessageId: "om_root",
    };
    const writerSessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    await writerSessions.load();
    await writerSessions.ensureChatSession(coordinates, {
      conversationKind: "group",
      platformThreadId: "omt_thread",
    });
    await writerSessions.setChatCodexThreadId(coordinates, "thread-1");
    await writerSessions.setChatActiveTurnId(coordinates, "turn-1");
    await writerSessions.setChatLastObservedMessageTs(coordinates, "1710000001000");

    const sessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    await sessions.load();
    const adapter = new FakeFeishuAdapter();
    adapter.historyMessages = [
      {
        platform: "feishu",
        conversationId: "oc_group",
        conversationKind: "group",
        rootMessageId: "om_root",
        platformThreadId: "omt_thread",
        messageId: "om_recent",
        messageCursor: "1710000002000",
        source: "thread_reply",
        sender: {
          kind: "user",
          userId: "ou_user",
        },
        text: "recent persisted context",
      },
    ];
    const codex = new FakeCodex();
    const bridge = new FeishuCodexBridge({
      sessions,
      adapter,
      codex: codex as never,
      groupMessageMode: "all",
      initialThreadHistoryCount: 12,
      historyApiMaxLimit: 15,
    });

    await bridge.start();
    await flushLogger();

    expect(adapter.historyQueries).toEqual([
      {
        platform: "feishu",
        conversationId: "oc_group",
        conversationKind: "group",
        rootMessageId: "om_root",
        platformThreadId: "omt_thread",
        limit: 12,
      },
    ]);
    const logs = await readJsonl(path.join(logDir, "broker.jsonl"));
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "chat.turn.steered",
          meta: expect.objectContaining({
            platform: "feishu",
            sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
            turnId: "turn-1",
            messageId: "om_recent",
            batchId: "history:om_recent",
            source: "history_recovery",
          }),
        }),
        expect.objectContaining({
          message: "chat.history.recovered",
          meta: expect.objectContaining({
            platform: "feishu",
            sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
            conversationId: "oc_group",
            rootMessageId: "om_root",
            messageCursor: "1710000002000",
            recoveredCount: 1,
          }),
        }),
      ]),
    );
    expect(codex.steers).toEqual([
      expect.objectContaining({
        session: expect.objectContaining({
          key: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
          activeTurnId: "turn-1",
          codexThreadId: "thread-1",
        }),
        inputText: expect.stringContaining("recent persisted context"),
      }),
    ]);
    expect(sessions.getChatSession(coordinates)?.lastObservedMessageTs).toBe("1710000002000");
    expect(sessions.hasProcessedEvent("feishu:message:oc_group:om_recent")).toBe(true);

    await adapter.emit({
      platform: "feishu",
      conversationId: "oc_group",
      conversationKind: "group",
      rootMessageId: "om_root",
      messageId: "om_followup_after_restart",
      source: "group_message",
      sender: {
        kind: "user",
        userId: "ou_user",
      },
      text: "follow-up after restart",
    });

    expect(codex.steers).toEqual([
      expect.objectContaining({
        inputText: expect.stringContaining("recent persisted context"),
      }),
      expect.objectContaining({
        session: expect.objectContaining({
          key: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
          activeTurnId: "turn-1",
          codexThreadId: "thread-1",
        }),
        inputText: expect.stringContaining("follow-up after restart"),
      }),
    ]);
  });

  it("starts a recovered Feishu turn for recently active sessions after restart", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-restart-recent-"));
    const logDir = path.join(dataRoot, "logs");
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const coordinates = {
      platform: "feishu" as const,
      conversationId: "oc_group",
      rootMessageId: "om_root",
    };
    const writerSessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    await writerSessions.load();
    await writerSessions.ensureChatSession(coordinates, {
      conversationKind: "group",
      platformThreadId: "omt_thread",
    });
    await writerSessions.setChatCodexThreadId(coordinates, "thread-1");
    await writerSessions.setChatLastObservedMessageTs(coordinates, "1710000001000");

    const sessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    await sessions.load();
    const adapter = new FakeFeishuAdapter();
    adapter.historyMessages = [
      {
        platform: "feishu",
        conversationId: "oc_group",
        conversationKind: "group",
        rootMessageId: "om_root",
        platformThreadId: "omt_thread",
        messageId: "om_anchor",
        messageCursor: "1710000001000",
        source: "thread_reply",
        sender: {
          kind: "user",
          userId: "ou_user",
        },
        text: "already observed context",
      },
      {
        platform: "feishu",
        conversationId: "oc_group",
        conversationKind: "group",
        rootMessageId: "om_root",
        platformThreadId: "omt_thread",
        messageId: "om_recent",
        messageCursor: "1710000002000",
        source: "thread_reply",
        sender: {
          kind: "user",
          userId: "ou_user",
        },
        text: "recent recovered context",
      },
    ];
    const codex = new FakeCodex();
    const bridge = new FeishuCodexBridge({
      sessions,
      adapter,
      codex: codex as never,
      groupMessageMode: "all",
    });

    await bridge.start();
    await flushLogger();

    expect(codex.startedTurns).toEqual([
      expect.objectContaining({
        session: expect.objectContaining({
          key: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
          activeTurnId: undefined,
          codexThreadId: "thread-1",
        }),
        inputText: expect.stringContaining("recent recovered context"),
      }),
    ]);
    expect(codex.startedTurns[0]?.inputText).not.toContain("already observed context");
    expect(sessions.getChatSession(coordinates)).toMatchObject({
      lastObservedMessageTs: "1710000002000",
      coAuthorCandidateUserIds: ["ou_user"],
      coAuthorCandidateRevision: 1,
    });
    expect(sessions.hasProcessedEvent("feishu:message:oc_group:om_recent")).toBe(true);
    const logs = await readJsonl(path.join(logDir, "broker.jsonl"));
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "chat.turn.started",
          meta: expect.objectContaining({
            platform: "feishu",
            sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
            turnId: "turn-1",
            codexThreadId: "thread-1",
            messageId: "om_recent",
            batchId: "history:om_recent",
            source: "history_recovery",
          }),
        }),
        expect.objectContaining({
          message: "chat.history.recovered",
          meta: expect.objectContaining({
            platform: "feishu",
            sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
            conversationId: "oc_group",
            rootMessageId: "om_root",
            messageCursor: "1710000002000",
            recoveredCount: 1,
          }),
        }),
      ]),
    );
  });

  it("marks Feishu history recovery degraded when no last observed cursor is persisted", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-restart-no-cursor-"));
    const logDir = path.join(dataRoot, "logs");
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const coordinates = {
      platform: "feishu" as const,
      conversationId: "oc_group",
      rootMessageId: "om_root",
    };
    const writerSessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    await writerSessions.load();
    await writerSessions.ensureChatSession(coordinates, {
      conversationKind: "group",
      platformThreadId: "omt_thread",
    });
    await writerSessions.setChatCodexThreadId(coordinates, "thread-1");
    await writerSessions.setChatActiveTurnId(coordinates, "turn-1");

    const sessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    await sessions.load();
    const adapter = new FakeFeishuAdapter();
    adapter.historyMessages = [
      {
        platform: "feishu",
        conversationId: "oc_group",
        conversationKind: "group",
        rootMessageId: "om_root",
        platformThreadId: "omt_thread",
        messageId: "om_recent",
        messageCursor: "1710000002000",
        source: "thread_reply",
        sender: {
          kind: "user",
          userId: "ou_user",
        },
        text: "ambiguous persisted context",
      },
    ];
    const codex = new FakeCodex();
    const bridge = new FeishuCodexBridge({
      sessions,
      adapter,
      codex: codex as never,
      groupMessageMode: "all",
    });

    await bridge.start();
    await flushLogger();

    expect(codex.steers).toEqual([]);
    const logs = await readJsonl(path.join(logDir, "broker.jsonl"));
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warn",
          message: "chat.history.recovered",
          meta: expect.objectContaining({
            platform: "feishu",
            sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
            conversationId: "oc_group",
            rootMessageId: "om_root",
            messageCursor: "1710000002000",
            recoveredCount: 0,
            degradedReason: "missing_last_observed_cursor",
          }),
        }),
      ]),
    );
  });

  it("steers non-mention group follow-ups into an active Feishu session in all mode", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-followup-"));
    const sessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    const coordinates = {
      platform: "feishu" as const,
      conversationId: "oc_group",
      rootMessageId: "om_root",
    };
    await sessions.load();
    await sessions.ensureChatSession(coordinates, {
      conversationKind: "group",
    });
    await sessions.setChatCodexThreadId(coordinates, "thread-1");
    await sessions.setChatActiveTurnId(coordinates, "turn-1");
    const adapter = new FakeFeishuAdapter();
    const codex = new FakeCodex();
    const bridge = new FeishuCodexBridge({
      sessions,
      adapter,
      codex: codex as never,
      groupMessageMode: "all",
    });

    await bridge.start();
    await adapter.emit({
      platform: "feishu",
      conversationId: "oc_group",
      conversationKind: "group",
      rootMessageId: "om_root",
      messageId: "om_followup",
      source: "group_message",
      sender: {
        kind: "user",
        userId: "ou_user",
      },
      text: "non mention follow-up",
    });

    expect(codex.steers).toEqual([
      expect.objectContaining({
        session: expect.objectContaining({
          key: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
          activeTurnId: "turn-1",
        }),
        inputText: expect.stringContaining("non mention follow-up"),
      }),
    ]);
  });

  it("steers rootless all-message group follow-ups into the active Feishu session for that group", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-rootless-followup-"));
    const logDir = path.join(dataRoot, "logs");
    configureLogger({
      logDir,
      level: "debug",
      rawSlackEvents: false,
      rawFeishuEvents: false,
      rawCodexRpc: false,
      rawHttpRequests: false,
    });
    const sessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    const coordinates = {
      platform: "feishu" as const,
      conversationId: "oc_group",
      rootMessageId: "om_root",
    };
    await sessions.load();
    await sessions.ensureChatSession(coordinates, {
      conversationKind: "group",
    });
    await sessions.setChatCodexThreadId(coordinates, "thread-1");
    await sessions.setChatActiveTurnId(coordinates, "turn-1");
    const adapter = new FakeFeishuAdapter();
    const codex = new FakeCodex();
    const bridge = new FeishuCodexBridge({
      sessions,
      adapter,
      codex: codex as never,
      groupMessageMode: "all",
    });

    await bridge.start();
    await adapter.emit({
      platform: "feishu",
      conversationId: "oc_group",
      conversationKind: "group",
      rootMessageId: "om_rootless_followup",
      messageId: "om_rootless_followup",
      source: "group_message",
      sender: {
        kind: "user",
        userId: "ou_user",
      },
      text: "rootless non mention follow-up",
    });

    expect(codex.steers).toEqual([
      expect.objectContaining({
        session: expect.objectContaining({
          key: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
          rootMessageId: "om_root",
          activeTurnId: "turn-1",
        }),
        inputText: expect.stringContaining("rootless non mention follow-up"),
      }),
    ]);
    expect(sessions.getChatSession(coordinates)).toMatchObject({
      lastObservedMessageTs: "om_rootless_followup",
    });
    expect(
      sessions.getChatSession({
        platform: "feishu",
        conversationId: "oc_group",
        rootMessageId: "om_rootless_followup",
      }),
    ).toBeUndefined();
    await flushLogger();
    const logs = await readJsonl(path.join(logDir, "broker.jsonl"));
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "chat.session.resumed",
          meta: expect.objectContaining({
            platform: "feishu",
            sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
            conversationId: "oc_group",
            rootMessageId: "om_root",
            messageId: "om_rootless_followup",
            turnId: "turn-1",
          }),
        }),
        expect.objectContaining({
          message: "chat.turn.steered",
          meta: expect.objectContaining({
            platform: "feishu",
            sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
            turnId: "turn-1",
            messageId: "om_rootless_followup",
            batchId: "om_rootless_followup",
          }),
        }),
      ]),
    );
  });

  it("does not steer non-mention group follow-ups in at_only mode", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-at-only-"));
    const sessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    const coordinates = {
      platform: "feishu" as const,
      conversationId: "oc_group",
      rootMessageId: "om_root",
    };
    await sessions.load();
    await sessions.ensureChatSession(coordinates, {
      conversationKind: "group",
    });
    await sessions.setChatCodexThreadId(coordinates, "thread-1");
    await sessions.setChatActiveTurnId(coordinates, "turn-1");
    const adapter = new FakeFeishuAdapter();
    const codex = new FakeCodex();
    const bridge = new FeishuCodexBridge({
      sessions,
      adapter,
      codex: codex as never,
      groupMessageMode: "at_only",
    });

    await bridge.start();
    await adapter.emit({
      platform: "feishu",
      conversationId: "oc_group",
      conversationKind: "group",
      rootMessageId: "om_root",
      messageId: "om_followup",
      source: "group_message",
      sender: {
        kind: "user",
        userId: "ou_user",
      },
      text: "non mention follow-up",
    });

    expect(codex.steers).toEqual([]);
  });

  it("steers platform-aware background job events into the Feishu session", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-job-event-"));
    const sessions = new SessionManager({
      stateStore: new StateStore(path.join(dataRoot, "state"), path.join(dataRoot, "sessions")),
      sessionsRoot: path.join(dataRoot, "sessions"),
    });
    await sessions.load();
    const coordinates = {
      platform: "feishu" as const,
      conversationId: "oc_group",
      rootMessageId: "om_root",
    };
    await sessions.ensureChatSession(coordinates, {
      conversationKind: "group",
    });
    await sessions.setChatCodexThreadId(coordinates, "thread-1");
    await sessions.setChatActiveTurnId(coordinates, "turn-active");
    const codex = new FakeCodex();
    const bridge = new FeishuCodexBridge({
      sessions,
      adapter: new FakeFeishuAdapter(),
      codex: codex as never,
      groupMessageMode: "all",
    });

    await bridge.acceptBackgroundJobEvent({
      conversationId: "oc_group",
      rootMessageId: "om_root",
      payload: {
        jobId: "job-1",
        jobKind: "watch_ci",
        eventKind: "state_changed",
        summary: "CI turned green.",
        detailsText: "All checks passed.",
        detailsJson: {
          conclusion: "success",
        },
      },
    });

    expect(codex.steers).toEqual([
      expect.objectContaining({
        session: expect.objectContaining({
          platform: "feishu",
          conversationId: "oc_group",
          rootMessageId: "om_root",
        }),
        inputText: expect.stringContaining("Feishu background job event:"),
      }),
    ]);
    expect(codex.steers[0]?.inputText).toContain("- job_id: job-1");
    expect(codex.steers[0]?.inputText).toContain("summary: CI turned green.");
    expect(codex.steers[0]?.inputText).toContain("details_text: All checks passed.");
    expect(codex.steers[0]?.inputText).toContain('"conclusion":"success"');
  });
});

class FakeFeishuAdapter implements ChatPlatformAdapter {
  readonly platform = "feishu" as const;
  handlers: ChatPlatformHandlers | undefined;
  readonly postedMessages: unknown[] = [];
  readonly postedStates: unknown[] = [];
  readonly postedProjections: unknown[] = [];
  readonly uploadedFiles: unknown[] = [];
  readonly downloadedAttachments: unknown[] = [];
  readonly historyQueries: unknown[] = [];
  historyMessages: readonly ChatThreadMessage[] = [];
  historyPage: ChatThreadPage | undefined;
  uploadKind: ChatUploadedFile["kind"];
  postError: unknown;
  projectionError: unknown;
  postedMessageId: string | undefined = "om_reply";
  postDelayMs = 0;
  activePosts = 0;
  maxConcurrentPosts = 0;
  downloadError: unknown;

  async start(handlers: ChatPlatformHandlers): Promise<void> {
    this.handlers = handlers;
  }

  async stop(): Promise<void> {}

  async emit(message: ChatInputMessage): Promise<void> {
    await this.handlers?.onMessage(message);
  }

  async emitInteractive(payload: unknown): Promise<void> {
    await this.handlers?.onInteractive?.(payload);
  }

  async getBotIdentity(): Promise<ChatUserIdentity | null> {
    return null;
  }

  async listThreadMessages(query: ChatThreadQuery): Promise<readonly ChatThreadMessage[]> {
    this.historyQueries.push(query);
    return this.historyMessages;
  }

  async listThreadMessagePage(query: ChatThreadQuery): Promise<ChatThreadPage> {
    this.historyQueries.push(query);
    return (
      this.historyPage ?? {
        messages: this.historyMessages,
        hasMore: false,
      }
    );
  }

  async postThreadMessage(target: ChatThreadTarget, message: unknown): Promise<ChatPostedMessage> {
    if (this.postError) {
      throw this.postError;
    }

    this.activePosts += 1;
    this.maxConcurrentPosts = Math.max(this.maxConcurrentPosts, this.activePosts);
    try {
      if (this.postDelayMs > 0) {
        await delay(this.postDelayMs);
      }
      this.postedMessages.push({ target, message });
      return {
        platform: "feishu",
        conversationId: target.conversationId,
        rootMessageId: target.rootMessageId,
        messageId: this.postedMessageId,
      };
    } finally {
      this.activePosts -= 1;
    }
  }

  async postThreadState(target: ChatThreadTarget, state: unknown): Promise<void> {
    this.postedStates.push({ target, state });
  }

  async postThreadProjection(target: ChatThreadTarget, projection: ChatTurnProjection): Promise<void> {
    this.postedProjections.push({ target, projection });
    if (this.projectionError) {
      throw this.projectionError;
    }
  }

  async uploadThreadFile(target: ChatThreadTarget, file: ChatOutboundFile): Promise<ChatUploadedFile> {
    this.uploadedFiles.push({ target, file });
    return {
      platform: "feishu",
      fileId: "file_uploaded",
      kind: this.uploadKind,
      name: file.filename,
      mimetype: file.contentType,
      size: file.contentBase64 ? Buffer.from(file.contentBase64, "base64").byteLength : undefined,
    };
  }

  async downloadAttachment(attachment: ChatAttachment): Promise<string> {
    this.downloadedAttachments.push(attachment);
    if (this.downloadError) {
      throw this.downloadError;
    }
    return "data:image/png;base64,aGVsbG8=";
  }

  async getUserIdentity(userId: string): Promise<ChatUserIdentity | null> {
    return {
      platform: "feishu",
      userId,
      mention: `@${userId}`,
    };
  }
}

function asPostedMessageText(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object" || !("message" in entry)) {
    return undefined;
  }
  const message = (entry as { message?: unknown }).message;
  if (!message || typeof message !== "object" || !("text" in message)) {
    return undefined;
  }
  return (message as { text?: string }).text;
}

function asPostedMessageRoot(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object" || !("target" in entry)) {
    return undefined;
  }
  const target = (entry as { target?: unknown }).target;
  if (!target || typeof target !== "object" || !("rootMessageId" in target)) {
    return undefined;
  }
  return (target as { rootMessageId?: string }).rootMessageId;
}

class FakeFeishuWsClient {
  dispatcher: { invoke: (data: unknown) => Promise<unknown> } | undefined;

  async start(options: { eventDispatcher: { invoke: (data: unknown) => Promise<unknown> } }): Promise<void> {
    this.dispatcher = options.eventDispatcher;
  }

  close(): void {}

  async emit(eventType: string, data: unknown): Promise<void> {
    await this.dispatcher?.invoke({
      schema: "2.0",
      header: {
        event_type: eventType,
      },
      event: data,
    });
  }
}

function createFakeFeishuApi() {
  return {
    listMessages: async () => ({
      has_more: false,
      items: [],
    }),
    replyMessage: async () => ({
      message_id: "om_reply",
    }),
    uploadMessageImage: async () => ({
      image_key: "img_uploaded",
    }),
    uploadMessageFile: async () => ({
      file_key: "file_uploaded",
    }),
    downloadMessageResourceAsDataUrl: async () => "data:text/plain;base64,aGVsbG8=",
  } as any;
}

class FakeCodex {
  readonly ensureThreadSessions: unknown[] = [];
  readonly startedTurns: Array<{ session: unknown; inputText: string; imageUrls: string[] }> = [];
  readonly steers: Array<{ session: unknown; inputText: string }> = [];
  readonly interruptedSessions: unknown[] = [];

  async ensureThread(session: unknown): Promise<string> {
    this.ensureThreadSessions.push(session);
    return "thread-1";
  }

  async startTurn(session: unknown, input: readonly { type: string; text?: string }[]) {
    this.startedTurns.push({
      session,
      inputText: input.map((item) => item.text ?? "").join("\n"),
      imageUrls: input.filter((item): item is { type: string; url: string } => item.type === "image" && "url" in item).map((item) => item.url),
    });
    return {
      turnId: "turn-1",
      completion: Promise.resolve({
        threadId: "thread-1",
        turnId: "turn-1",
        finalMessage: "",
        aborted: false,
      }),
    };
  }

  async steer(session: unknown, input: readonly { type: string; text?: string }[]) {
    this.steers.push({
      session,
      inputText: input.map((item) => item.text ?? "").join("\n"),
    });
  }

  async interrupt(session: unknown) {
    this.interruptedSessions.push(session);
  }
}

async function readJsonl(filePath: string): Promise<unknown[]> {
  const raw = await readLogFileOrBucket(filePath);
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

async function readLogFileOrBucket(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  const bucketDir = path.basename(filePath) === "broker.jsonl" ? path.join(path.dirname(filePath), "broker") : path.join(path.dirname(filePath), path.basename(filePath, ".jsonl"));
  const files = (await fs.readdir(bucketDir)).filter((file) => file.endsWith(".jsonl")).sort();
  const chunks = await Promise.all(files.map((file) => fs.readFile(path.join(bucketDir, file), "utf8")));
  return chunks.join("");
}

async function waitForJsonlRecords(filePath: string, label: string, predicate: (records: unknown[]) => boolean, timeoutMs = 5_000): Promise<unknown[]> {
  const deadline = Date.now() + timeoutMs;
  let lastRecords: unknown[] = [];

  while (Date.now() < deadline) {
    await flushLogger();
    try {
      lastRecords = await readJsonl(filePath);
      if (predicate(lastRecords)) {
        return lastRecords;
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for ${label}; saw ${lastRecords.length} JSONL records`);
}

async function waitForCondition(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for ${label}`);
}

function isLogRecord(record: unknown, message: string, meta: Record<string, unknown>): boolean {
  if (!record || typeof record !== "object") {
    return false;
  }

  const logRecord = record as {
    readonly message?: unknown;
    readonly meta?: Record<string, unknown> | undefined;
  };
  return logRecord.message === message && Object.entries(meta).every(([key, value]) => logRecord.meta?.[key] === value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error);
}
