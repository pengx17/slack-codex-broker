/* oxlint-disable max-lines */
import { logger } from "../../logger.js";
import type { ChatAttachment, ChatInputMessage, ChatOutboundFile, ChatOutboundMessage, ChatPostedMessage, ChatThreadPage, ChatThreadMessage, ChatThreadTarget, ChatUploadedFile } from "../chat/chat-types.js";
import type { ChatPlatformAdapter } from "../chat/chat-platform-adapter.js";
import { createChatTurnProjectionFromOutboundMessage } from "../chat/chat-turn-projection.js";
import type { CodexBroker } from "../codex/codex-broker.js";
import type { CodexInputItem } from "../codex/app-server-client.js";
import { type ChatSessionCoordinates } from "../chat/chat-session-key.js";
import { appendCoAuthorTrailers } from "../git/github-author-utils.js";
import { GitHubAuthorMappingService } from "../github-author-mapping-service.js";
import { SessionManager } from "../session-manager.js";
import type { BackgroundJobEventPayload, GitHubAuthorMappingRecord, JsonLike, SlackSessionRecord } from "../../types.js";

const COAUTHOR_PROMPT_COOLDOWN_MS = 5 * 60 * 1_000;
const FEISHU_RECENT_SESSION_RECOVERY_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1_000;
const DEFAULT_FEISHU_INITIAL_THREAD_HISTORY_COUNT = 8;
const DEFAULT_FEISHU_HISTORY_API_MAX_LIMIT = 50;

type FeishuPostChatMessageOptions = {
  readonly conversationId: string;
  readonly rootMessageId: string;
  readonly text: string;
  readonly format?: ChatOutboundMessage["format"] | undefined;
  readonly kind?: ChatOutboundMessage["kind"] | undefined;
  readonly reason?: ChatOutboundMessage["reason"] | undefined;
  readonly richText?: ChatOutboundMessage["richText"] | undefined;
  readonly card?: ChatOutboundMessage["card"] | undefined;
};

export class FeishuCodexBridge {
  readonly #sessions: SessionManager;
  readonly #adapter: ChatPlatformAdapter;
  readonly #codex: CodexBroker;
  readonly #groupMessageMode: "all" | "at_only";
  readonly #initialThreadHistoryCount: number;
  readonly #historyApiMaxLimit: number;
  readonly #mappings?: GitHubAuthorMappingService | undefined;
  readonly #outboundQueues = new Map<string, Promise<void>>();
  #started = false;

  constructor(options: {
    readonly sessions: SessionManager;
    readonly adapter: ChatPlatformAdapter;
    readonly codex: CodexBroker;
    readonly groupMessageMode: "all" | "at_only";
    readonly initialThreadHistoryCount?: number | undefined;
    readonly historyApiMaxLimit?: number | undefined;
    readonly mappings?: GitHubAuthorMappingService | undefined;
  }) {
    this.#sessions = options.sessions;
    this.#adapter = options.adapter;
    this.#codex = options.codex;
    this.#groupMessageMode = options.groupMessageMode;
    this.#initialThreadHistoryCount = options.initialThreadHistoryCount ?? DEFAULT_FEISHU_INITIAL_THREAD_HISTORY_COUNT;
    this.#historyApiMaxLimit = options.historyApiMaxLimit ?? DEFAULT_FEISHU_HISTORY_API_MAX_LIMIT;
    this.#mappings = options.mappings;
  }

  async start(): Promise<void> {
    if (this.#started) {
      return;
    }

    await this.#adapter.start({
      onMessage: async (message) => {
        await this.#handleMessage(message);
      },
      onInteractive: async (payload) => {
        await this.#handleInteractivePayload(payload);
      },
    });
    this.#started = true;
    await this.#recoverActiveSessions();
  }

  async stop(): Promise<void> {
    if (!this.#started) {
      return;
    }

    await this.#adapter.stop();
    this.#started = false;
  }

  async postChatMessage(options: FeishuPostChatMessageOptions): Promise<ChatPostedMessage> {
    const target = {
      platform: "feishu" as const,
      conversationId: options.conversationId,
      rootMessageId: options.rootMessageId,
    };

    return await this.#runWithOutboundQueue(target, async () => {
      const projection = createChatTurnProjectionFromOutboundMessage(target, {
        text: options.text,
        format: options.format,
        kind: options.kind,
        reason: options.reason,
        richText: options.richText,
        card: options.card,
      });
      if (options.kind === "progress" && this.#adapter.postThreadProjection) {
        await this.#adapter.postThreadProjection(target, projection);
        logger.info("chat.outbound.posted", {
          platform: "feishu",
          sessionKey: this.#sessionKeyFor(target),
          conversationId: options.conversationId,
          rootMessageId: options.rootMessageId,
          messageId: "state",
          format: "card",
          durationMs: 0,
        });
        return {
          platform: "feishu",
          conversationId: target.conversationId,
          rootMessageId: target.rootMessageId,
          messageId: "state",
        };
      }

      const chunks = chunkFeishuOutboundText(options.text);
      let posted: ChatPostedMessage | undefined;

      for (const [index, chunk] of chunks.entries()) {
        const outbound = createFeishuOutboundMessage(options, chunk);
        posted = await this.#postLoggedThreadMessage(target, outbound, {
          attempt: index + 1,
          chunkIndex: index + 1,
          chunkCount: chunks.length,
        });
      }

      if (!posted) {
        throw new Error("Feishu outbound message did not produce a post result");
      }

      if (options.kind && this.#adapter.postThreadProjection) {
        try {
          await this.#adapter.postThreadProjection(target, projection);
          logger.info("chat.outbound.posted", {
            platform: "feishu",
            sessionKey: this.#sessionKeyFor(target),
            conversationId: options.conversationId,
            rootMessageId: options.rootMessageId,
            messageId: "state",
            format: "card",
            durationMs: 0,
          });
        } catch (error) {
          logger.warn("chat.outbound.failed", {
            platform: "feishu",
            sessionKey: this.#sessionKeyFor(target),
            conversationId: options.conversationId,
            rootMessageId: options.rootMessageId,
            format: "card",
            errorClass: error instanceof Error ? error.name : "Error",
            statusCode: statusCodeFromError(error) ?? "unknown",
            attempt: 1,
          });
        }
      }

      return posted;
    });
  }

  async postChatState(options: { readonly conversationId: string; readonly rootMessageId: string; readonly kind: "wait" | "block" | "final"; readonly reason?: string | undefined }): Promise<void> {
    const coordinates = {
      platform: "feishu",
      conversationId: options.conversationId,
      rootMessageId: options.rootMessageId,
    } as const;
    const session = this.#sessions.getChatSession(coordinates);
    if (!session) {
      throw new Error(`Unknown session for Feishu state update: ${options.conversationId}:${options.rootMessageId}`);
    }

    const updated = await this.#sessions.recordChatTurnSignal(coordinates, {
      turnId: session.activeTurnId,
      kind: options.kind,
      reason: options.reason,
      occurredAt: new Date().toISOString(),
    });
    logger.info("chat.turn.completed", {
      platform: "feishu",
      sessionKey: updated.key,
      turnId: updated.lastTurnSignalTurnId ?? "none",
      codexThreadId: updated.codexThreadId ?? "none",
      durationMs: 0,
      batchId: "state",
      status: options.kind,
      reason: options.reason,
    });

    const postThreadState = this.#adapter.postThreadState?.bind(this.#adapter);
    if (!postThreadState) {
      return;
    }

    await this.#runWithOutboundQueue(coordinates, async () => {
      try {
        await postThreadState(coordinates, {
          kind: options.kind,
          reason: options.reason,
        });
        logger.info("chat.outbound.posted", {
          platform: "feishu",
          sessionKey: updated.key,
          conversationId: options.conversationId,
          rootMessageId: options.rootMessageId,
          messageId: "state",
          format: "card",
          durationMs: 0,
        });
      } catch (error) {
        logger.warn("chat.outbound.failed", {
          platform: "feishu",
          sessionKey: updated.key,
          conversationId: options.conversationId,
          rootMessageId: options.rootMessageId,
          format: "card",
          errorClass: error instanceof Error ? error.name : "Error",
          statusCode: statusCodeFromError(error) ?? "unknown",
          attempt: 1,
        });
        throw error;
      }
    });
  }

  async postChatFile(
    options: {
      readonly conversationId: string;
      readonly rootMessageId: string;
    } & ChatOutboundFile,
  ): Promise<ChatUploadedFile> {
    const target = {
      platform: "feishu" as const,
      conversationId: options.conversationId,
      rootMessageId: options.rootMessageId,
    };

    return await this.#runWithOutboundQueue(target, async () => {
      try {
        const uploadThreadFile = this.#adapter.uploadThreadFile?.bind(this.#adapter);
        if (!uploadThreadFile) {
          throw new Error("Feishu adapter does not support file upload");
        }

        const uploaded = await uploadThreadFile(target, {
          filePath: options.filePath,
          contentBase64: options.contentBase64,
          filename: options.filename,
          title: options.title,
          initialComment: options.initialComment,
          altText: options.altText,
          snippetType: options.snippetType,
          contentType: options.contentType,
        });
        logger.info("chat.outbound.posted", {
          platform: "feishu",
          sessionKey: this.#sessionKeyFor(target),
          conversationId: options.conversationId,
          rootMessageId: options.rootMessageId,
          fileId: uploaded.fileId,
          format: uploaded.kind ?? (uploaded.mimetype?.startsWith("image/") ? "image" : "file"),
          durationMs: 0,
        });
        return uploaded;
      } catch (error) {
        logger.warn("chat.outbound.failed", {
          platform: "feishu",
          sessionKey: this.#sessionKeyFor(target),
          conversationId: options.conversationId,
          rootMessageId: options.rootMessageId,
          format: "file",
          errorClass: error instanceof Error ? error.name : "Error",
          statusCode: statusCodeFromError(error) ?? "unknown",
          attempt: 1,
        });
        throw error;
      }
    });
  }

  async readChatThreadHistory(options: { readonly conversationId: string; readonly rootMessageId: string; readonly beforeMessageId?: string | undefined; readonly beforeCursor?: string | undefined; readonly limit?: number | undefined }): Promise<{
    readonly messages: readonly ChatThreadMessage[];
    readonly formattedText?: string | undefined;
    readonly hasMore: boolean;
    readonly nextCursor?: string | undefined;
  }> {
    const effectiveLimit = clampFeishuHistoryLimit(options.limit, this.#initialThreadHistoryCount, this.#historyApiMaxLimit);
    if (effectiveLimit === 0) {
      return {
        messages: [],
        formattedText: undefined,
        hasMore: false,
      };
    }

    const page = await this.#listThreadMessagePage({
      platform: "feishu",
      conversationId: options.conversationId,
      rootMessageId: options.rootMessageId,
      beforeMessageId: options.beforeMessageId,
      beforeCursor: options.beforeCursor,
      limit: effectiveLimit,
    });
    return {
      messages: page.messages,
      formattedText: page.messages.length > 0 ? page.messages.map((message) => formatFeishuMessageForCodex(message)).join("\n\n") : undefined,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    };
  }

  async acceptBackgroundJobEvent(options: { readonly conversationId: string; readonly rootMessageId: string; readonly payload: BackgroundJobEventPayload }): Promise<void> {
    const coordinates = {
      platform: "feishu",
      conversationId: options.conversationId,
      rootMessageId: options.rootMessageId,
    } as const;
    const session = this.#sessions.getChatSession(coordinates);
    if (!session) {
      throw new Error(`Unknown session for Feishu background job event: ${options.conversationId}:${options.rootMessageId}`);
    }

    await this.#handleMessage({
      platform: "feishu",
      conversationId: options.conversationId,
      conversationKind: session.conversationKind,
      rootMessageId: options.rootMessageId,
      platformThreadId: session.platformThreadId,
      messageId: createBackgroundJobMessageId(options.payload),
      eventId: createBackgroundJobEventId(options.payload),
      source: "background_job_event",
      sender: {
        kind: "system",
        userId: "BACKGROUND_JOB",
      },
      text: options.payload.summary,
      backgroundJob: options.payload,
    });
  }

  async resolveCommitCoauthors(options: { readonly cwd: string; readonly commitMessage: string; readonly primaryAuthorEmail?: string | undefined }): Promise<{
    readonly status: "noop" | "blocked" | "resolved";
    readonly sessionKey?: string | undefined;
    readonly message?: string | undefined;
    readonly errorCode?: string | undefined;
    readonly coAuthors?: readonly string[] | undefined;
    readonly commitMessage?: string | undefined;
  }> {
    const session = this.#sessions.findSessionByWorkspace(options.cwd);
    if (!session || session.platform !== "feishu") {
      return { status: "noop" };
    }

    const candidateUserIds = session.coAuthorCandidateUserIds ?? [];
    if (candidateUserIds.length === 0) {
      return {
        status: "noop",
        sessionKey: session.key,
      };
    }

    if (session.coAuthorConfirmedRevision !== session.coAuthorCandidateRevision) {
      await this.#ensureCoauthorPrompt(session);
      return {
        status: "blocked",
        sessionKey: session.key,
        errorCode: "coauthor_confirmation_required",
        message: "Commit blocked by Feishu co-author gate. Open the Feishu group card and confirm co-authors, then retry the commit.",
      };
    }

    const confirmedUserIds = session.coAuthorConfirmedUserIds ?? [];
    if (confirmedUserIds.length === 0) {
      return {
        status: "noop",
        sessionKey: session.key,
        coAuthors: [],
      };
    }

    if (!this.#mappings) {
      return {
        status: "blocked",
        sessionKey: session.key,
        errorCode: "coauthor_mapping_unavailable",
        message: "Commit blocked by Feishu co-author gate. Feishu GitHub author mappings are not available in this runtime.",
      };
    }

    await this.#mappings.load();
    const mappings = confirmedUserIds.map((userId) => {
      return (
        this.#mappings!.getMappingForUser({
          platform: "feishu",
          userId,
        }) ?? null
      );
    });

    const missingUserIds = confirmedUserIds.filter((_, index) => !mappings[index]);
    if (missingUserIds.length > 0) {
      return {
        status: "blocked",
        sessionKey: session.key,
        errorCode: "coauthor_mapping_required",
        message: "Commit blocked by Feishu co-author gate. At least one confirmed Feishu contributor is still missing a GitHub author mapping.",
      };
    }

    const coAuthors = mappings.filter((mapping): mapping is GitHubAuthorMappingRecord => mapping !== null).map((mapping) => mapping.githubAuthor);
    const commitMessage = appendCoAuthorTrailers(options.commitMessage, {
      coAuthors,
      primaryAuthorEmail: options.primaryAuthorEmail,
    });

    if (commitMessage === options.commitMessage) {
      return {
        status: "noop",
        sessionKey: session.key,
        coAuthors,
      };
    }

    return {
      status: "resolved",
      sessionKey: session.key,
      coAuthors,
      commitMessage,
    };
  }

  async #handleMessage(message: ChatInputMessage): Promise<void> {
    const processedEventKey = processedFeishuMessageKey(message);
    if (this.#sessions.hasProcessedEvent(processedEventKey)) {
      logger.debug("chat.message.deduped", {
        platform: "feishu",
        conversationId: message.conversationId,
        conversationKind: message.conversationKind,
        rootMessageId: message.rootMessageId,
        messageId: message.messageId,
        eventId: message.eventId ?? message.messageId,
        route: "deduped",
      });
      return;
    }

    await this.#sessions.markProcessedEvent(processedEventKey);

    const coordinates = coordinatesFor(message);
    const exactSession = this.#sessions.getChatSession(coordinates);
    const existing = exactSession ?? this.#findActiveGroupSessionForFollowup(message);
    const sessionCoordinates = existing ? coordinatesForSession(existing) : coordinates;

    if (!existing && message.source !== "bot_mention") {
      logger.info("chat.message.ignored", {
        platform: "feishu",
        conversationId: message.conversationId,
        conversationKind: message.conversationKind,
        rootMessageId: message.rootMessageId,
        messageId: message.messageId,
        eventId: message.eventId ?? message.messageId,
        senderKind: message.sender.kind,
        ignoredReason: "ignored_no_active_session",
        route: "ignored_no_active_session",
      });
      return;
    }

    if (message.source === "group_message" && this.#groupMessageMode === "at_only") {
      logger.warn("chat.platform.degraded", {
        platform: "feishu",
        source: "long_connection",
        groupMessageMode: this.#groupMessageMode,
        degradedReason: "group_message_all_unavailable",
        permission: "im:message.group_msg",
      });
      return;
    }

    let session =
      existing ??
      (await this.#sessions.ensureChatSession(coordinates, {
        conversationKind: message.conversationKind,
        platformThreadId: message.platformThreadId,
      }));
    session = await this.#sessions.setChatLastObservedMessageTs(sessionCoordinates, message.messageCursor ?? message.messageId);

    if (!existing) {
      logger.info("chat.session.created", {
        platform: "feishu",
        sessionKey: session.key,
        conversationId: message.conversationId,
        rootMessageId: message.rootMessageId,
        messageId: message.messageId,
        groupMessageMode: this.#groupMessageMode,
      });
    } else {
      logger.info("chat.session.resumed", {
        platform: "feishu",
        sessionKey: session.key,
        conversationId: sessionCoordinates.conversationId,
        rootMessageId: sessionCoordinates.rootMessageId,
        messageId: message.messageId,
        turnId: session.activeTurnId,
      });
    }

    if (message.text.trim() === "-stop") {
      await this.#handleStop(session, message);
      return;
    }

    session = await this.#noteIncomingCoauthorCandidates(session, [message], sessionCoordinates);
    session = await this.#ensureCodexThread(session, sessionCoordinates);
    const input = await this.#buildCodexInput(message);

    if (session.activeTurnId) {
      await this.#codex.steer(session, input);
      logger.info("chat.turn.steered", {
        platform: "feishu",
        sessionKey: session.key,
        turnId: session.activeTurnId,
        messageId: message.messageId,
        batchId: message.messageId,
      });
      return;
    }

    const started = await this.#codex.startTurn(session, input);
    logger.info("chat.turn.started", {
      platform: "feishu",
      sessionKey: session.key,
      turnId: started.turnId,
      codexThreadId: session.codexThreadId,
      messageId: message.messageId,
      batchId: message.messageId,
    });
    session = await this.#sessions.setChatActiveTurnId(sessionCoordinates, started.turnId);

    try {
      const result = await started.completion;
      await this.#sessions.setChatActiveTurnId(sessionCoordinates, undefined);
      logger.info("chat.turn.completed", {
        platform: "feishu",
        sessionKey: session.key,
        turnId: result.turnId,
        codexThreadId: result.threadId,
        durationMs: 0,
        batchId: message.messageId,
      });
    } catch (error) {
      await this.#sessions.setChatActiveTurnId(sessionCoordinates, undefined);
      logger.warn("chat.turn.completed", {
        platform: "feishu",
        sessionKey: session.key,
        turnId: started.turnId,
        codexThreadId: session.codexThreadId,
        errorClass: error instanceof Error ? error.name : "Error",
        durationMs: 0,
        batchId: message.messageId,
      });
      throw error;
    }
  }

  async #handleInteractivePayload(payload: unknown): Promise<void> {
    const action = parseFeishuCoauthorAction(payload);
    if (!action) {
      return;
    }

    const session = this.#sessions.getSessionByKey(action.sessionKey);
    if (!session || session.platform !== "feishu") {
      return;
    }

    const target = threadTargetForSession(session);
    if (action.conversationId !== target.conversationId || action.rootMessageId !== target.rootMessageId) {
      return;
    }

    if (session.coAuthorCandidateRevision !== action.candidateRevision) {
      await this.#postLoggedThreadMessage(target, {
        text: "Co-author candidates changed. Retry the commit to open a fresh confirmation card.",
      });
      return;
    }

    const confirmedUserIds = action.kind === "coauthor_skip" ? [] : (session.coAuthorCandidateUserIds ?? []);
    await this.#sessions.confirmChatCoAuthors(coordinatesForSession(session), {
      userIds: confirmedUserIds,
      candidateRevision: action.candidateRevision,
    });

    logger.info("chat.coauthor.confirmed", {
      platform: "feishu",
      sessionKey: session.key,
      conversationId: target.conversationId,
      rootMessageId: target.rootMessageId,
      candidateRevision: action.candidateRevision,
      confirmedCount: confirmedUserIds.length,
    });
    await this.#postLoggedThreadMessage(target, {
      text: confirmedUserIds.length > 0 ? "Co-authors confirmed. Retry the commit; if a GitHub author mapping is missing, fill it in from the admin page first." : "Co-author gate confirmed with no co-authors selected. Retry the commit.",
    });
  }

  async #noteIncomingCoauthorCandidates(session: SlackSessionRecord, messages: readonly ChatThreadMessage[], coordinates: ChatSessionCoordinates): Promise<SlackSessionRecord> {
    const candidateUserIds = [
      ...new Set(
        messages
          .filter((message) => message.sender.kind === "user")
          .map((message) => message.sender.userId.trim())
          .filter(Boolean),
      ),
    ];
    if (candidateUserIds.length === 0) {
      return session;
    }

    return await this.#sessions.addChatCoAuthorCandidates(coordinates, candidateUserIds);
  }

  #findActiveGroupSessionForFollowup(message: ChatInputMessage): SlackSessionRecord | undefined {
    if (this.#groupMessageMode !== "all" || message.source !== "group_message") {
      return undefined;
    }

    return this.#sessions
      .listSessions()
      .filter((session) => session.platform === "feishu" && (session.conversationId ?? session.channelId) === message.conversationId && Boolean(session.activeTurnId) && Boolean(session.codexThreadId))
      .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))[0];
  }

  async #ensureCoauthorPrompt(session: SlackSessionRecord): Promise<void> {
    const candidateRevision = session.coAuthorCandidateRevision;
    const candidateUserIds = session.coAuthorCandidateUserIds ?? [];
    if (!candidateRevision || candidateUserIds.length === 0) {
      return;
    }

    const promptAtMs = session.coAuthorPromptedAt ? Date.parse(session.coAuthorPromptedAt) : Number.NaN;
    const promptedRecently = session.coAuthorPromptRevision === candidateRevision && Number.isFinite(promptAtMs) && Date.now() - promptAtMs < COAUTHOR_PROMPT_COOLDOWN_MS;
    if (promptedRecently) {
      return;
    }

    const target = threadTargetForSession(session);
    const labels = await Promise.all(
      candidateUserIds.map(async (userId) => {
        const identity = await this.#adapter.getUserIdentity(userId).catch(() => null);
        return describeFeishuContributor(identity, userId);
      }),
    );

    try {
      await this.#postLoggedThreadMessage(target, {
        text: "Git commit paused: confirm Feishu co-authors before retrying the commit.",
        format: "card",
        card: createFeishuCoauthorPromptCard(session, labels, candidateRevision),
      });
      await this.#sessions.markChatCoAuthorPrompted(coordinatesForSession(session), candidateRevision);
    } catch (error) {
      // The logged send helper already recorded the structured failure.
    }
  }

  async #ensureCodexThread(session: SlackSessionRecord, coordinates: ChatSessionCoordinates): Promise<SlackSessionRecord> {
    if (session.codexThreadId) {
      await this.#codex.ensureThread(session);
      return session;
    }

    const codexThreadId = await this.#codex.ensureThread(session);
    return await this.#sessions.setChatCodexThreadId(coordinates, codexThreadId);
  }

  async #buildCodexInput(message: ChatInputMessage): Promise<readonly CodexInputItem[]> {
    const downloadedImages = await this.#downloadImageAttachments(message);
    return [
      createTextInputItem(
        formatFeishuMessageForCodex(message, {
          downloadedAttachmentIds: new Set(downloadedImages.map((image) => image.attachmentId)),
        }),
      ),
      ...downloadedImages.map((image) => ({
        type: "image" as const,
        url: image.url,
      })),
    ];
  }

  async #downloadImageAttachments(message: ChatInputMessage): Promise<
    readonly {
      readonly attachmentId: string;
      readonly url: string;
    }[]
  > {
    if (!this.#adapter.downloadAttachment || !message.attachments?.length) {
      return [];
    }

    const images = message.attachments.filter((attachment) => attachment.kind === "image");
    const downloaded = await Promise.allSettled(
      images.map(async (attachment) => ({
        attachmentId: attachment.id,
        url: await this.#adapter.downloadAttachment!(attachment),
      })),
    );

    return downloaded.flatMap((result, index) => {
      if (result.status === "fulfilled") {
        return [result.value];
      }

      const attachment = images[index];
      logger.warn("chat.attachment.download_failed", {
        platform: "feishu",
        sessionKey: this.#sessionKeyFor(coordinatesFor(message)),
        conversationId: message.conversationId,
        rootMessageId: message.rootMessageId,
        messageId: message.messageId,
        attachmentId: attachment?.id,
        kind: attachment?.kind,
        errorClass: result.reason instanceof Error ? result.reason.name : "Error",
      });
      return [];
    });
  }

  async #handleStop(session: SlackSessionRecord, message: ChatInputMessage): Promise<void> {
    const hadActiveTurn = Boolean(session.activeTurnId && session.codexThreadId);
    const stoppedTurnId = session.activeTurnId ?? "none";
    if (hadActiveTurn) {
      await this.#codex.interrupt(session);
      await this.#sessions.setChatActiveTurnId(coordinatesForSession(session), undefined);
    }

    await this.#postLoggedThreadMessage(
      {
        platform: "feishu",
        conversationId: session.conversationId ?? session.channelId,
        rootMessageId: session.rootMessageId ?? session.rootThreadTs,
        platformThreadId: session.platformThreadId,
      },
      {
        text: hadActiveTurn ? "Stopped the current run." : "No active run to stop.",
      },
    );
    logger.info("chat.turn.stopped", {
      platform: "feishu",
      sessionKey: session.key,
      conversationId: session.conversationId ?? session.channelId,
      rootMessageId: session.rootMessageId ?? session.rootThreadTs,
      messageId: message.messageId,
      turnId: stoppedTurnId,
      hadActiveTurn,
    });
  }

  #sessionKeyFor(coordinates: ChatSessionCoordinates): string {
    return this.#sessions.getChatSession(coordinates)?.key ?? SessionManager.createChatKey(coordinates);
  }

  async #runWithOutboundQueue<T>(target: ChatThreadTarget, operation: () => Promise<T>): Promise<T> {
    const queueKey = feishuOutboundQueueKey(target);
    const previous = this.#outboundQueues.get(queueKey) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.#outboundQueues.set(queueKey, tail);

    try {
      return await current;
    } finally {
      if (this.#outboundQueues.get(queueKey) === tail) {
        this.#outboundQueues.delete(queueKey);
      }
    }
  }

  async #postLoggedThreadMessage(
    target: ChatThreadTarget,
    message: ChatOutboundMessage,
    options?: {
      readonly attempt?: number | undefined;
      readonly chunkIndex?: number | undefined;
      readonly chunkCount?: number | undefined;
    },
  ): Promise<ChatPostedMessage> {
    const format = message.format ?? "text";
    try {
      const posted = await this.#adapter.postThreadMessage(target, message);
      logger.info("chat.outbound.posted", {
        platform: "feishu",
        sessionKey: this.#sessionKeyFor(target),
        conversationId: target.conversationId,
        rootMessageId: target.rootMessageId,
        messageId: posted.messageId ?? "unknown",
        format,
        chunkIndex: options?.chunkIndex,
        chunkCount: options?.chunkCount,
        durationMs: 0,
      });
      return posted;
    } catch (error) {
      logger.warn("chat.outbound.failed", {
        platform: "feishu",
        sessionKey: this.#sessionKeyFor(target),
        conversationId: target.conversationId,
        rootMessageId: target.rootMessageId,
        format,
        errorClass: error instanceof Error ? error.name : "Error",
        statusCode: statusCodeFromError(error) ?? "unknown",
        attempt: options?.attempt ?? 1,
      });
      throw error;
    }
  }

  async #listThreadMessagePage(query: { readonly platform: "feishu"; readonly conversationId: string; readonly rootMessageId: string; readonly beforeMessageId?: string | undefined; readonly beforeCursor?: string | undefined; readonly limit?: number | undefined }): Promise<ChatThreadPage> {
    if (this.#adapter.listThreadMessagePage) {
      return await this.#adapter.listThreadMessagePage(query);
    }

    return {
      messages: await this.#adapter.listThreadMessages(query),
      hasMore: false,
    };
  }

  async #recoverActiveSessions(): Promise<void> {
    const nowMs = Date.now();
    const sessions = this.#sessions.listSessions().filter((session) => session.platform === "feishu" && Boolean(session.codexThreadId) && shouldRecoverFeishuSession(session, nowMs));

    for (const session of sessions) {
      await this.#recoverSessionHistory(session);
    }
  }

  async #recoverSessionHistory(session: SlackSessionRecord): Promise<void> {
    const startedAt = Date.now();
    const conversationId = session.conversationId ?? session.channelId;
    const rootMessageId = session.rootMessageId ?? session.rootThreadTs;
    const recoveryLimit = clampFeishuHistoryLimit(undefined, this.#initialThreadHistoryCount, this.#historyApiMaxLimit);

    if (recoveryLimit === 0) {
      logger.warn("chat.history.recovered", {
        platform: "feishu",
        sessionKey: session.key,
        conversationId,
        rootMessageId,
        messageCursor: session.lastObservedMessageTs ?? "none",
        recoveredCount: 0,
        degradedReason: "history_recovery_disabled",
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    try {
      const messages = await this.#adapter.listThreadMessages({
        platform: "feishu",
        conversationId,
        conversationKind: session.conversationKind,
        rootMessageId,
        platformThreadId: session.platformThreadId,
        limit: recoveryLimit,
      });
      const recoveredMessages = selectRecoveredFeishuMessages(messages, session.lastObservedMessageTs);
      const lastRecoveredMessage = recoveredMessages.at(-1);
      const degradedReason = feishuRecoveryDegradedReason(messages, recoveredMessages, session.lastObservedMessageTs);

      if (recoveredMessages.length > 0) {
        session = await this.#noteIncomingCoauthorCandidates(session, recoveredMessages, coordinatesForSession(session));
      }

      if (recoveredMessages.length > 0 && session.activeTurnId) {
        await this.#codex.steer(session, createRecoveredFeishuHistoryInput(recoveredMessages));
        await Promise.all(
          recoveredMessages.map(async (message) => {
            await this.#sessions.markProcessedEvent(processedFeishuMessageKey(message));
          }),
        );
        await this.#sessions.setChatLastObservedMessageTs(coordinatesForSession(session), lastRecoveredMessage?.messageCursor ?? lastRecoveredMessage?.messageId);
        logger.info("chat.turn.steered", {
          platform: "feishu",
          sessionKey: session.key,
          turnId: session.activeTurnId,
          messageId: lastRecoveredMessage?.messageId ?? "none",
          batchId: lastRecoveredMessage ? `history:${lastRecoveredMessage.messageId}` : "history:none",
          source: "history_recovery",
        });
      } else if (recoveredMessages.length > 0 && session.codexThreadId) {
        const started = await this.#codex.startTurn(session, createRecoveredFeishuHistoryInput(recoveredMessages));
        await Promise.all(
          recoveredMessages.map(async (message) => {
            await this.#sessions.markProcessedEvent(processedFeishuMessageKey(message));
          }),
        );
        await this.#sessions.setChatActiveTurnId(coordinatesForSession(session), started.turnId);
        await this.#sessions.setChatLastObservedMessageTs(coordinatesForSession(session), lastRecoveredMessage?.messageCursor ?? lastRecoveredMessage?.messageId);
        logger.info("chat.turn.started", {
          platform: "feishu",
          sessionKey: session.key,
          turnId: started.turnId,
          codexThreadId: session.codexThreadId,
          messageId: lastRecoveredMessage?.messageId ?? "none",
          batchId: lastRecoveredMessage ? `history:${lastRecoveredMessage.messageId}` : "history:none",
          source: "history_recovery",
        });
        this.#observeRecoveredTurnCompletion(session, started, lastRecoveredMessage?.messageId ?? "history");
      }

      logger[degradedReason ? "warn" : "info"]("chat.history.recovered", {
        platform: "feishu",
        sessionKey: session.key,
        conversationId,
        rootMessageId,
        messageCursor: lastRecoveredMessage?.messageCursor ?? messages.at(-1)?.messageCursor ?? session.lastObservedMessageTs ?? "none",
        recoveredCount: recoveredMessages.length,
        degradedReason,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      logger.warn("chat.history.recovered", {
        platform: "feishu",
        sessionKey: session.key,
        conversationId,
        rootMessageId,
        messageCursor: session.lastObservedMessageTs ?? "unavailable",
        recoveredCount: 0,
        degradedReason: "history_recovery_failed",
        errorClass: error instanceof Error ? error.name : "Error",
        durationMs: Date.now() - startedAt,
      });
    }
  }

  #observeRecoveredTurnCompletion(
    session: SlackSessionRecord,
    started: {
      readonly turnId: string;
      readonly completion: Promise<{
        readonly threadId: string;
        readonly turnId: string;
      }>;
    },
    batchId: string,
  ): void {
    void started.completion
      .then(async (result) => {
        await this.#sessions.setChatActiveTurnId(coordinatesForSession(session), undefined);
        logger.info("chat.turn.completed", {
          platform: "feishu",
          sessionKey: session.key,
          turnId: result.turnId,
          codexThreadId: result.threadId,
          durationMs: 0,
          batchId: `history:${batchId}`,
        });
      })
      .catch(async (error: unknown) => {
        await this.#sessions.setChatActiveTurnId(coordinatesForSession(session), undefined);
        logger.warn("chat.turn.completed", {
          platform: "feishu",
          sessionKey: session.key,
          turnId: started.turnId,
          codexThreadId: session.codexThreadId,
          errorClass: error instanceof Error ? error.name : "Error",
          durationMs: 0,
          batchId: `history:${batchId}`,
        });
      });
  }
}

function coordinatesFor(message: ChatInputMessage): ChatSessionCoordinates {
  return {
    platform: "feishu",
    conversationId: message.conversationId,
    rootMessageId: message.rootMessageId,
  };
}

function processedFeishuMessageKey(message: Pick<ChatThreadMessage, "conversationId" | "messageId">): string {
  return ["feishu", "message", message.conversationId, message.messageId].join(":");
}

function createBackgroundJobMessageId(payload: BackgroundJobEventPayload): string {
  return ["job", payload.jobId, payload.eventKind, Date.now().toString(36), Math.floor(Math.random() * 1_000_000).toString(36)].join(":");
}

function createBackgroundJobEventId(payload: BackgroundJobEventPayload): string {
  return ["job-event", payload.jobId, payload.eventKind, Date.now().toString(36)].join(":");
}

function coordinatesForSession(session: SlackSessionRecord): ChatSessionCoordinates {
  return {
    platform: "feishu",
    conversationId: session.conversationId ?? session.channelId,
    rootMessageId: session.rootMessageId ?? session.rootThreadTs,
  };
}

function threadTargetForSession(session: SlackSessionRecord) {
  return {
    platform: "feishu" as const,
    conversationId: session.conversationId ?? session.channelId,
    rootMessageId: session.rootMessageId ?? session.rootThreadTs,
    platformThreadId: session.platformThreadId,
  };
}

function shouldRecoverFeishuSession(session: SlackSessionRecord, nowMs: number): boolean {
  if (session.activeTurnId) {
    return true;
  }

  if (!session.lastObservedMessageTs) {
    return false;
  }

  const updatedAtMs = Date.parse(session.updatedAt);
  return Number.isFinite(updatedAtMs) && nowMs - updatedAtMs <= FEISHU_RECENT_SESSION_RECOVERY_LOOKBACK_MS;
}

function selectRecoveredFeishuMessages(messages: readonly ChatThreadMessage[], lastObservedMessageTs: string | undefined): readonly ChatThreadMessage[] {
  if (!lastObservedMessageTs) {
    return [];
  }

  const anchorIndex = messages.findIndex((message) => messageMatchesRecoveryCursor(message, lastObservedMessageTs));
  if (anchorIndex >= 0) {
    return messages.slice(anchorIndex + 1);
  }

  const lastObservedNumber = parseRecoveryCursorNumber(lastObservedMessageTs);
  if (lastObservedNumber === undefined) {
    return [];
  }

  return messages.filter((message) => {
    const messageNumber = parseRecoveryCursorNumber(message.messageCursor ?? message.messageId);
    return messageNumber !== undefined && messageNumber > lastObservedNumber;
  });
}

function feishuRecoveryDegradedReason(messages: readonly ChatThreadMessage[], recoveredMessages: readonly ChatThreadMessage[], lastObservedMessageTs: string | undefined): string | undefined {
  if (!lastObservedMessageTs) {
    return "missing_last_observed_cursor";
  }

  if (messages.length > 0 && recoveredMessages.length === 0 && !messages.some((message) => messageMatchesRecoveryCursor(message, lastObservedMessageTs)) && parseRecoveryCursorNumber(lastObservedMessageTs) === undefined) {
    return "cursor_anchor_not_found";
  }

  return undefined;
}

function messageMatchesRecoveryCursor(message: ChatThreadMessage, cursor: string): boolean {
  return message.messageCursor === cursor || message.messageId === cursor;
}

function parseRecoveryCursorNumber(cursor: string | undefined): number | undefined {
  if (!cursor?.trim()) {
    return undefined;
  }

  const parsed = Number(cursor);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clampFeishuHistoryLimit(requested: number | undefined, fallback: number, max: number): number {
  const resolved = requested ?? fallback;
  return Math.max(0, Math.min(resolved, max));
}

function createRecoveredFeishuHistoryInput(messages: readonly ChatThreadMessage[]): readonly CodexInputItem[] {
  return [createTextInputItem(["Recovered Feishu messages after broker restart:", "", ...messages.map((message) => formatFeishuMessageForCodex(message))].join("\n\n"))];
}

function createTextInputItem(text: string): CodexInputItem {
  return {
    type: "text",
    text,
    text_elements: [],
  };
}

function formatFeishuMessageForCodex(
  message: ChatThreadMessage,
  options?: {
    readonly downloadedAttachmentIds?: ReadonlySet<string> | undefined;
  },
): string {
  if (message.source === "background_job_event" && message.backgroundJob) {
    return formatFeishuBackgroundJobEventForCodex(message);
  }

  const lines = ["Feishu message:", `- chat_id: ${message.conversationId}`, `- root_message_id: ${message.rootMessageId}`, `- message_id: ${message.messageId}`, `- source: ${message.source}`, `- sender: ${message.sender.userId}`, "", message.text];

  if (message.attachments?.length) {
    lines.push("", ...message.attachments.flatMap((attachment) => formatFeishuAttachmentForCodex(attachment, options)));
  }

  return lines.join("\n");
}

function formatFeishuBackgroundJobEventForCodex(message: ChatThreadMessage): string {
  const lines = [
    "Feishu background job event:",
    `- chat_id: ${message.conversationId}`,
    `- root_message_id: ${message.rootMessageId}`,
    `- message_id: ${message.messageId}`,
    `- job_id: ${message.backgroundJob?.jobId}`,
    `- job_kind: ${message.backgroundJob?.jobKind}`,
    `- event_kind: ${message.backgroundJob?.eventKind}`,
    "",
    `summary: ${message.backgroundJob?.summary ?? (message.text.trim() || "[no summary]")}`,
  ];

  if (message.backgroundJob?.detailsText) {
    lines.push("", `details_text: ${message.backgroundJob.detailsText}`);
  }

  if (message.backgroundJob?.detailsJson !== undefined) {
    lines.push("", `details_json: ${JSON.stringify(message.backgroundJob.detailsJson)}`);
  }

  return lines.join("\n");
}

function formatFeishuAttachmentForCodex(
  attachment: ChatAttachment,
  options?: {
    readonly downloadedAttachmentIds?: ReadonlySet<string> | undefined;
  },
): string[] {
  const transferStatus = options?.downloadedAttachmentIds?.has(attachment.id) ? "downloaded_as_image_input" : attachment.kind === "file" ? "downloadable_via_feishu_resource" : "download_unavailable";
  return ["Feishu attachment:", `- kind: ${attachment.kind}`, `- id: ${attachment.id}`, attachment.name ? `- name: ${attachment.name}` : undefined, attachment.resourceKey ? `- resource_key: ${attachment.resourceKey}` : undefined, `- transfer_status: ${transferStatus}`].filter((line): line is string => Boolean(line));
}

function feishuOutboundQueueKey(target: Pick<ChatThreadTarget, "conversationId">): string {
  return `feishu-chat:${target.conversationId}`;
}

function createFeishuOutboundMessage(options: FeishuPostChatMessageOptions, text: string): ChatOutboundMessage {
  if (shouldRenderOperationalCard(options)) {
    return {
      text,
      format: "card",
      richText: undefined,
      card: createFeishuOperationalCard(options.kind, text, options.reason),
    };
  }

  return {
    text,
    format: options.format,
    richText: options.richText,
    card: options.card,
  };
}

function shouldRenderOperationalCard(options: FeishuPostChatMessageOptions): options is FeishuPostChatMessageOptions & {
  readonly kind: NonNullable<ChatOutboundMessage["kind"]>;
} {
  return Boolean(options.kind) && !options.format && !options.richText && !options.card;
}

function createFeishuOperationalCard(kind: NonNullable<ChatOutboundMessage["kind"]>, text: string, reason: string | undefined): JsonLike {
  const elements: JsonLike[] = [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: text,
      },
    },
  ];

  if (reason?.trim()) {
    elements.push({
      tag: "note",
      elements: [
        {
          tag: "plain_text",
          content: `Reason: ${reason.trim()}`,
        },
      ],
    });
  }

  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: feishuOperationalCardTemplate(kind),
      title: {
        tag: "plain_text",
        content: feishuOperationalCardTitle(kind),
      },
    },
    elements,
  };
}

function createFeishuCoauthorPromptCard(session: SlackSessionRecord, contributorLabels: readonly string[], candidateRevision: number): JsonLike {
  const value = {
    sessionKey: session.key,
    conversationId: session.conversationId ?? session.channelId,
    rootMessageId: session.rootMessageId ?? session.rootThreadTs,
    candidateRevision,
  };

  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: "yellow",
      title: {
        tag: "plain_text",
        content: "Confirm co-authors",
      },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: "Git commit paused: this Feishu session needs co-author confirmation before the commit can go through.",
        },
      },
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: contributorLabels.length > 0 ? `Candidates:\n${contributorLabels.map((label) => `- ${label}`).join("\n")}` : "Candidates: none",
        },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            type: "primary",
            text: {
              tag: "plain_text",
              content: "Confirm all",
            },
            value: {
              ...value,
              kind: "coauthor_confirm_all",
            },
          },
          {
            tag: "button",
            type: "default",
            text: {
              tag: "plain_text",
              content: "Skip co-authors",
            },
            value: {
              ...value,
              kind: "coauthor_skip",
            },
          },
        ],
      },
    ],
  };
}

function feishuOperationalCardTemplate(kind: NonNullable<ChatOutboundMessage["kind"]>): string {
  switch (kind) {
    case "final":
      return "green";
    case "block":
      return "red";
    case "wait":
      return "yellow";
    case "progress":
      return "blue";
  }
}

function feishuOperationalCardTitle(kind: NonNullable<ChatOutboundMessage["kind"]>): string {
  switch (kind) {
    case "final":
      return "Done";
    case "block":
      return "Blocked";
    case "wait":
      return "Waiting";
    case "progress":
      return "Update";
  }
}

function statusCodeFromError(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const record = error as {
    readonly statusCode?: unknown;
    readonly status?: unknown;
  };
  const value = record.statusCode ?? record.status;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseFeishuCoauthorAction(payload: unknown): {
  readonly kind: "coauthor_confirm_all" | "coauthor_skip";
  readonly sessionKey: string;
  readonly conversationId: string;
  readonly rootMessageId: string;
  readonly candidateRevision: number;
} | null {
  const actionValue = readActionValue(payload);
  const kind = readString(actionValue, "kind");
  if (kind !== "coauthor_confirm_all" && kind !== "coauthor_skip") {
    return null;
  }

  const sessionKey = readString(actionValue, "sessionKey");
  const conversationId = readString(actionValue, "conversationId") ?? readString(actionValue, "conversation_id");
  const rootMessageId = readString(actionValue, "rootMessageId") ?? readString(actionValue, "root_message_id");
  const candidateRevision = readNumber(actionValue, "candidateRevision");
  if (!sessionKey || !conversationId || !rootMessageId || !Number.isFinite(candidateRevision)) {
    return null;
  }

  return {
    kind,
    sessionKey,
    conversationId,
    rootMessageId,
    candidateRevision,
  };
}

function readActionValue(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const action = (payload as { action?: unknown }).action;
  if (!action || typeof action !== "object") {
    return null;
  }

  const value = (action as { value?: unknown }).value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  return null;
}

function readString(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(record: Record<string, unknown> | null, key: string): number {
  const value = record?.[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
}

function describeFeishuContributor(
  identity: {
    readonly mention?: string | undefined;
    readonly realName?: string | undefined;
    readonly displayName?: string | undefined;
    readonly username?: string | undefined;
  } | null,
  fallbackUserId: string,
): string {
  return identity?.realName ?? identity?.displayName ?? identity?.username ?? identity?.mention ?? `@${fallbackUserId}`;
}

const FEISHU_OUTBOUND_TEXT_CHUNK_SIZE = 4_000;

function chunkFeishuOutboundText(text: string): readonly string[] {
  if (text.length <= FEISHU_OUTBOUND_TEXT_CHUNK_SIZE) {
    return [text];
  }

  const chunks: string[] = [];
  let current = "";

  for (const line of text.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= FEISHU_OUTBOUND_TEXT_CHUNK_SIZE) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    if (line.length <= FEISHU_OUTBOUND_TEXT_CHUNK_SIZE) {
      current = line;
      continue;
    }

    for (let index = 0; index < line.length; index += FEISHU_OUTBOUND_TEXT_CHUNK_SIZE) {
      chunks.push(line.slice(index, index + FEISHU_OUTBOUND_TEXT_CHUNK_SIZE));
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.length > 0 ? chunks : [text];
}
