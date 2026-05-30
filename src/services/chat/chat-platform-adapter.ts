import type { ChatTurnProjection } from "./chat-turn-projection.js";
import type { ChatAttachment, ChatInputMessage, ChatOutboundFile, ChatOutboundMessage, ChatPlatform, ChatPostedMessage, ChatThreadMessage, ChatThreadPage, ChatThreadQuery, ChatThreadTarget, ChatTurnState, ChatUploadedFile, ChatUserIdentity } from "./chat-types.js";

export interface ChatPlatformHandlers {
  readonly onReady?: ((platform: ChatPlatform) => void | Promise<void>) | undefined;
  readonly onMessage: (message: ChatInputMessage) => Promise<void>;
  readonly onInteractive?: ((payload: unknown) => Promise<void>) | undefined;
}

export interface ChatPlatformAdapter {
  readonly platform: ChatPlatform;
  start(handlers: ChatPlatformHandlers): Promise<void>;
  stop(): Promise<void>;
  getBotIdentity(): Promise<ChatUserIdentity | null>;
  listThreadMessages(query: ChatThreadQuery): Promise<readonly ChatThreadMessage[]>;
  listThreadMessagePage?(query: ChatThreadQuery): Promise<ChatThreadPage>;
  postThreadMessage(target: ChatThreadTarget, message: ChatOutboundMessage): Promise<ChatPostedMessage>;
  postThreadState?(target: ChatThreadTarget, state: ChatTurnState): Promise<void>;
  postThreadProjection?(target: ChatThreadTarget, projection: ChatTurnProjection): Promise<void>;
  uploadThreadFile?(target: ChatThreadTarget, file: ChatOutboundFile): Promise<ChatUploadedFile>;
  downloadAttachment?(attachment: ChatAttachment): Promise<string>;
  getUserIdentity(userId: string): Promise<ChatUserIdentity | null>;
}

export class ChatPlatformRegistry {
  readonly #adapters = new Map<ChatPlatform, ChatPlatformAdapter>();

  register(adapter: ChatPlatformAdapter): void {
    if (this.#adapters.has(adapter.platform)) {
      throw new Error(`Chat platform already registered: ${adapter.platform}`);
    }

    this.#adapters.set(adapter.platform, adapter);
  }

  get(platform: ChatPlatform): ChatPlatformAdapter | undefined {
    return this.#adapters.get(platform);
  }

  require(platform: ChatPlatform): ChatPlatformAdapter {
    const adapter = this.get(platform);
    if (!adapter) {
      throw new Error(`Chat platform is not registered: ${platform}`);
    }

    return adapter;
  }

  list(): readonly ChatPlatformAdapter[] {
    return [...this.#adapters.values()];
  }

  async startAll(handlers: ChatPlatformHandlers): Promise<void> {
    for (const adapter of this.#adapters.values()) {
      await adapter.start(handlers);
    }
  }

  async stopAll(): Promise<void> {
    const adapters = [...this.#adapters.values()].reverse();
    await Promise.all(adapters.map((adapter) => adapter.stop()));
  }
}
