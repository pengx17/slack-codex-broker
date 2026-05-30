import { Readable } from "node:stream";

import * as Lark from "@larksuiteoapi/node-sdk";

import type { JsonLike } from "../../types.js";

const CHINA_FEISHU_OPEN_PLATFORM_ORIGIN = "https://open.feishu.cn";

export interface FeishuMessageData {
  readonly message_id?: string | undefined;
  readonly root_id?: string | undefined;
  readonly parent_id?: string | undefined;
  readonly thread_id?: string | undefined;
  readonly msg_type?: string | undefined;
  readonly create_time?: string | undefined;
  readonly update_time?: string | undefined;
  readonly chat_id?: string | undefined;
  readonly body?:
    | {
        readonly content?: string | undefined;
      }
    | undefined;
  readonly raw?: JsonLike | undefined;
}

export interface FeishuUploadedImageData {
  readonly image_key?: string | undefined;
}

export interface FeishuUploadedFileData {
  readonly file_key?: string | undefined;
}

export interface FeishuListMessagesData {
  readonly has_more?: boolean | undefined;
  readonly page_token?: string | undefined;
  readonly items?: readonly FeishuMessageData[] | undefined;
}

interface FeishuApiResponse<T> {
  readonly code?: number | undefined;
  readonly msg?: string | undefined;
  readonly data?: T | undefined;
}

interface FeishuMessageResourceResponse {
  readonly getReadableStream: () => Readable;
  readonly headers?: Record<string, unknown> | undefined;
}

interface FeishuSdkClient {
  readonly im: {
    readonly v1: {
      readonly message: {
        readonly create: (payload: unknown) => Promise<FeishuApiResponse<FeishuMessageData>>;
        readonly reply: (payload: unknown) => Promise<FeishuApiResponse<FeishuMessageData>>;
        readonly patch: (payload: unknown) => Promise<FeishuApiResponse<FeishuMessageData>>;
        readonly list: (payload: unknown) => Promise<FeishuApiResponse<FeishuListMessagesData>>;
      };
      readonly image: {
        readonly create: (payload: unknown) => Promise<FeishuApiResponse<FeishuUploadedImageData> | FeishuUploadedImageData | null>;
      };
      readonly file: {
        readonly create: (payload: unknown) => Promise<FeishuApiResponse<FeishuUploadedFileData> | FeishuUploadedFileData | null>;
      };
      readonly messageResource: {
        readonly get: (payload: unknown) => Promise<FeishuMessageResourceResponse>;
      };
    };
  };
}

export class FeishuApi {
  readonly #client: FeishuSdkClient;

  constructor(options: { readonly appId: string; readonly appSecret: string; readonly apiBaseUrl?: string | undefined; readonly client?: FeishuSdkClient | undefined }) {
    const domain = options.apiBaseUrl ? feishuSdkDomainFromApiBaseUrl(options.apiBaseUrl) : Lark.Domain.Feishu;
    this.#client =
      options.client ??
      (new Lark.Client({
        appId: options.appId,
        appSecret: options.appSecret,
        domain,
      }) as unknown as FeishuSdkClient);
  }

  async sendMessage(options: { readonly chatId: string; readonly msgType: "text" | "post" | "interactive" | "image" | "file"; readonly content: JsonLike; readonly uuid?: string | undefined }): Promise<FeishuMessageData> {
    const response = await this.#client.im.v1.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: withoutUndefined({
        receive_id: options.chatId,
        msg_type: options.msgType,
        content: JSON.stringify(options.content),
        uuid: options.uuid,
      }),
    });

    return assertFeishuData(response, "im.v1.message.create");
  }

  async replyMessage(options: { readonly messageId: string; readonly msgType: "text" | "post" | "interactive" | "image" | "file"; readonly content: JsonLike; readonly replyInThread?: boolean | undefined; readonly uuid?: string | undefined }): Promise<FeishuMessageData> {
    const response = await this.#client.im.v1.message.reply({
      path: {
        message_id: options.messageId,
      },
      data: withoutUndefined({
        msg_type: options.msgType,
        content: JSON.stringify(options.content),
        reply_in_thread: options.replyInThread ?? true,
        uuid: options.uuid,
      }),
    });

    return assertFeishuData(response, "im.v1.message.reply");
  }

  async patchMessage(options: { readonly messageId: string; readonly content: JsonLike }): Promise<FeishuMessageData> {
    const response = await this.#client.im.v1.message.patch({
      path: {
        message_id: options.messageId,
      },
      data: {
        content: JSON.stringify(options.content),
      },
    });

    return assertFeishuData(response, "im.v1.message.patch");
  }

  async listMessages(options: {
    readonly containerIdType: "chat" | "thread";
    readonly containerId: string;
    readonly pageSize?: number | undefined;
    readonly pageToken?: string | undefined;
    readonly sortType?: "ByCreateTimeAsc" | "ByCreateTimeDesc" | undefined;
    readonly cardMsgContentType?: "user_card_content" | undefined;
  }): Promise<FeishuListMessagesData> {
    const response = await this.#client.im.v1.message.list({
      params: withoutUndefined({
        container_id_type: options.containerIdType,
        container_id: options.containerId,
        page_size: options.pageSize,
        page_token: options.pageToken,
        sort_type: options.sortType,
        card_msg_content_type: options.cardMsgContentType,
      }),
    });

    return assertFeishuData(response, "im.v1.message.list");
  }

  async uploadMessageImage(options: { readonly bytes: Buffer }): Promise<FeishuUploadedImageData> {
    const response = await this.#client.im.v1.image.create({
      data: {
        image_type: "message",
        image: options.bytes,
      },
    });

    return assertFeishuUploadData(response, "im.v1.image.create", "image_key");
  }

  async uploadMessageFile(options: { readonly bytes: Buffer; readonly filename: string; readonly fileType: "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream"; readonly durationMs?: number | undefined }): Promise<FeishuUploadedFileData> {
    const response = await this.#client.im.v1.file.create({
      data: withoutUndefined({
        file_type: options.fileType,
        file_name: options.filename,
        duration: options.durationMs,
        file: options.bytes,
      }),
    });

    return assertFeishuUploadData(response, "im.v1.file.create", "file_key");
  }

  async downloadMessageResourceAsDataUrl(options: { readonly messageId: string; readonly fileKey: string; readonly type: "image" | "file" | "audio" | "video"; readonly maxBytes?: number | undefined; readonly allowedContentTypes?: readonly string[] | undefined }): Promise<string> {
    const response = await this.#client.im.v1.messageResource.get({
      path: {
        message_id: options.messageId,
        file_key: options.fileKey,
      },
      params: {
        type: options.type,
      },
    });
    const contentType = normalizeHeader(readHeader(response.headers, "content-type")) ?? "application/octet-stream";
    assertAllowedResourceContentType(contentType, options.allowedContentTypes);
    const contentLength = parseContentLength(readHeader(response.headers, "content-length"));
    assertResourceDownloadWithinLimit(contentLength, options.maxBytes);
    const bytes = await readStreamToBuffer(response.getReadableStream(), options.maxBytes);
    return `data:${contentType};base64,${bytes.toString("base64")}`;
  }
}

export function createFeishuTextContent(text: string): JsonLike {
  return {
    text,
  };
}

export function feishuSdkDomainFromApiBaseUrl(apiBaseUrl: string): string {
  const url = new URL(apiBaseUrl);
  const pathname = url.pathname.replace(/\/+$/u, "");
  if (pathname && pathname !== "/open-apis") {
    throw new Error("Invalid FEISHU_API_BASE_URL: expected origin or /open-apis path");
  }
  if (url.origin !== CHINA_FEISHU_OPEN_PLATFORM_ORIGIN) {
    throw new Error("Invalid FEISHU_API_BASE_URL: expected https://open.feishu.cn");
  }
  if (url.search || url.hash) {
    throw new Error("Invalid FEISHU_API_BASE_URL: query and hash are not supported");
  }
  return url.origin;
}

function assertFeishuData<T>(response: FeishuApiResponse<T>, operation: string): T {
  if (response.code && response.code !== 0) {
    throw new Error(`Feishu API error for ${operation}: ${response.msg ?? response.code}`);
  }

  if (!response.data) {
    throw new Error(`Feishu API response for ${operation} did not include data`);
  }

  return response.data;
}

function assertFeishuUploadData<T extends object, K extends string>(response: FeishuApiResponse<T> | T | null, operation: string, key: K): T {
  const data = isFeishuApiEnvelope(response) ? assertFeishuData(response, operation) : response;

  if (!data) {
    throw new Error(`Feishu API response for ${operation} did not include ${key}`);
  }

  const value = (data as Record<string, unknown>)[key];
  if (typeof value !== "string" || !value) {
    throw new Error(`Feishu API response for ${operation} did not include ${key}`);
  }

  return data;
}

function isFeishuApiEnvelope<T>(value: FeishuApiResponse<T> | T | null): value is FeishuApiResponse<T> {
  return Boolean(value && typeof value === "object" && ("code" in value || "msg" in value || "data" in value));
}

function assertAllowedResourceContentType(contentType: string, allowedContentTypes: readonly string[] | undefined): void {
  if (!allowedContentTypes?.length) {
    return;
  }

  const normalized = contentType.toLowerCase();
  const allowed = allowedContentTypes.some((entry) => {
    const expected = entry.toLowerCase();
    return expected.endsWith("/") ? normalized.startsWith(expected) : normalized === expected;
  });

  if (!allowed) {
    throw new Error(`Feishu resource download content type ${contentType} is not allowed`);
  }
}

function parseContentLength(value: unknown): number | undefined {
  const normalized = normalizeHeader(value);
  if (!normalized) {
    return undefined;
  }

  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function assertResourceDownloadWithinLimit(byteLength: number | undefined, maxBytes: number | undefined): void {
  if (maxBytes === undefined || byteLength === undefined || byteLength <= maxBytes) {
    return;
  }

  throw new Error(`Feishu resource download exceeds ${formatByteLimit(maxBytes)} limit`);
}

function formatByteLimit(maxBytes: number): string {
  if (maxBytes % (1024 * 1024) === 0) {
    return `${maxBytes / (1024 * 1024)} MB`;
  }

  return `${maxBytes} bytes`;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

async function readStreamToBuffer(stream: Readable, maxBytes: number | undefined): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    assertResourceDownloadWithinLimit(totalBytes, maxBytes);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function normalizeHeader(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return normalizeHeader(value[0]);
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const contentType = value.split(";")[0]?.trim();
  return contentType || undefined;
}

function readHeader(headers: Record<string, unknown> | undefined, name: string): unknown {
  if (!headers) {
    return undefined;
  }

  const direct = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  if (direct !== undefined) {
    return direct;
  }

  const normalizedName = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === normalizedName)?.[1];
}
