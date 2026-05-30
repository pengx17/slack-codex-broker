import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { FeishuApi, createFeishuTextContent, feishuSdkDomainFromApiBaseUrl } from "../src/services/feishu/feishu-api.js";

describe("FeishuApi", () => {
  it("normalizes Open Platform API base URLs to SDK domains", () => {
    expect(feishuSdkDomainFromApiBaseUrl("https://open.feishu.cn/open-apis")).toBe("https://open.feishu.cn");
    expect(feishuSdkDomainFromApiBaseUrl("https://open.feishu.cn/open-apis/")).toBe("https://open.feishu.cn");
    expect(feishuSdkDomainFromApiBaseUrl("https://open.feishu.cn")).toBe("https://open.feishu.cn");
    expect(() => feishuSdkDomainFromApiBaseUrl("https://open.feishu.cn/open-apis/im/v1")).toThrowError("Invalid FEISHU_API_BASE_URL");
    expect(() => feishuSdkDomainFromApiBaseUrl("https://open.larksuite.com/open-apis")).toThrowError("Invalid FEISHU_API_BASE_URL: expected https://open.feishu.cn");
    expect(() => feishuSdkDomainFromApiBaseUrl("https://open.feishu.cn/open-apis?tenant_access_token=secret")).toThrowError("Invalid FEISHU_API_BASE_URL: query and hash are not supported");
  });

  it("sends group text messages with chat_id recipients", async () => {
    const calls: unknown[] = [];
    const api = new FeishuApi({
      appId: "cli-test",
      appSecret: "secret-test",
      client: createFakeClient(calls),
    });

    const sent = await api.sendMessage({
      chatId: "oc_group",
      msgType: "text",
      content: createFeishuTextContent("hello"),
    });

    expect(sent.message_id).toBe("om_created");
    expect(calls[0]).toEqual({
      operation: "create",
      payload: {
        params: {
          receive_id_type: "chat_id",
        },
        data: {
          receive_id: "oc_group",
          msg_type: "text",
          content: JSON.stringify({ text: "hello" }),
        },
      },
    });
  });

  it("replies in thread by default", async () => {
    const calls: unknown[] = [];
    const api = new FeishuApi({
      appId: "cli-test",
      appSecret: "secret-test",
      client: createFakeClient(calls),
    });

    await api.replyMessage({
      messageId: "om_root",
      msgType: "post",
      content: {
        zh_cn: {
          title: "Status",
          content: [[{ tag: "text", text: "done" }]],
        },
      },
    });

    expect(calls[0]).toEqual({
      operation: "reply",
      payload: {
        path: {
          message_id: "om_root",
        },
        data: {
          msg_type: "post",
          content: JSON.stringify({
            zh_cn: {
              title: "Status",
              content: [[{ tag: "text", text: "done" }]],
            },
          }),
          reply_in_thread: true,
        },
      },
    });
  });

  it("patches Feishu messages with serialized card content", async () => {
    const calls: unknown[] = [];
    const api = new FeishuApi({
      appId: "cli-test",
      appSecret: "secret-test",
      client: createFakeClient(calls),
    });

    await api.patchMessage({
      messageId: "om_status",
      content: {
        config: {
          wide_screen_mode: true,
        },
      },
    });

    expect(calls[0]).toEqual({
      operation: "patch",
      payload: {
        path: {
          message_id: "om_status",
        },
        data: {
          content: JSON.stringify({
            config: {
              wide_screen_mode: true,
            },
          }),
        },
      },
    });
  });

  it("lists group history with raw card content enabled", async () => {
    const calls: unknown[] = [];
    const api = new FeishuApi({
      appId: "cli-test",
      appSecret: "secret-test",
      client: createFakeClient(calls),
    });

    await api.listMessages({
      containerIdType: "chat",
      containerId: "oc_group",
      pageSize: 20,
      sortType: "ByCreateTimeAsc",
      cardMsgContentType: "user_card_content",
    });

    expect(calls[0]).toEqual({
      operation: "list",
      payload: {
        params: {
          container_id_type: "chat",
          container_id: "oc_group",
          page_size: 20,
          sort_type: "ByCreateTimeAsc",
          card_msg_content_type: "user_card_content",
        },
      },
    });
  });

  it("downloads message resources as data URLs", async () => {
    const calls: unknown[] = [];
    const api = new FeishuApi({
      appId: "cli-test",
      appSecret: "secret-test",
      client: createFakeClient(calls),
    });

    const dataUrl = await api.downloadMessageResourceAsDataUrl({
      messageId: "om_image",
      fileKey: "img_key",
      type: "image",
    });

    expect(dataUrl).toBe("data:image/png;base64,aGVsbG8=");
    expect(calls[0]).toEqual({
      operation: "resource.get",
      payload: {
        path: {
          message_id: "om_image",
          file_key: "img_key",
        },
        params: {
          type: "image",
        },
      },
    });
  });

  it("rejects message resource downloads whose headers exceed the configured size limit", async () => {
    const calls: unknown[] = [];
    const api = new FeishuApi({
      appId: "cli-test",
      appSecret: "secret-test",
      client: createFakeClient(calls, {
        resource: {
          getReadableStream: () => {
            throw new Error("download body should not be read");
          },
          headers: {
            "content-type": "image/png",
            "content-length": String(10 * 1024 * 1024 + 1),
          },
        },
      }),
    });

    await expect(
      api.downloadMessageResourceAsDataUrl({
        messageId: "om_image",
        fileKey: "img_key",
        type: "image",
        maxBytes: 10 * 1024 * 1024,
        allowedContentTypes: ["image/"],
      }),
    ).rejects.toThrow("Feishu resource download exceeds 10 MB limit");
    expect(calls).toHaveLength(1);
  });

  it("rejects message resource downloads with unexpected content types before reading the body", async () => {
    const calls: unknown[] = [];
    const api = new FeishuApi({
      appId: "cli-test",
      appSecret: "secret-test",
      client: createFakeClient(calls, {
        resource: {
          getReadableStream: () => {
            throw new Error("download body should not be read");
          },
          headers: {
            "content-type": "text/plain",
          },
        },
      }),
    });

    await expect(
      api.downloadMessageResourceAsDataUrl({
        messageId: "om_image",
        fileKey: "img_key",
        type: "image",
        maxBytes: 10 * 1024 * 1024,
        allowedContentTypes: ["image/"],
      }),
    ).rejects.toThrow("Feishu resource download content type text/plain is not allowed");
    expect(calls).toHaveLength(1);
  });

  it("stops streaming message resource downloads that exceed the configured size limit", async () => {
    const calls: unknown[] = [];
    const api = new FeishuApi({
      appId: "cli-test",
      appSecret: "secret-test",
      client: createFakeClient(calls, {
        resource: {
          getReadableStream: () => Readable.from([Buffer.from("hello"), Buffer.from("world")]),
          headers: {
            "content-type": "image/png",
          },
        },
      }),
    });

    await expect(
      api.downloadMessageResourceAsDataUrl({
        messageId: "om_image",
        fileKey: "img_key",
        type: "image",
        maxBytes: 9,
        allowedContentTypes: ["image/"],
      }),
    ).rejects.toThrow("Feishu resource download exceeds 9 bytes limit");
    expect(calls).toHaveLength(1);
  });

  it("uploads message images and files before they are sent", async () => {
    const calls: unknown[] = [];
    const api = new FeishuApi({
      appId: "cli-test",
      appSecret: "secret-test",
      client: createFakeClient(calls),
    });

    await expect(
      api.uploadMessageImage({
        bytes: Buffer.from("png"),
      }),
    ).resolves.toEqual({
      image_key: "img_uploaded",
    });
    await expect(
      api.uploadMessageFile({
        bytes: Buffer.from("pdf"),
        filename: "report.pdf",
        fileType: "pdf",
      }),
    ).resolves.toEqual({
      file_key: "file_uploaded",
    });

    expect(calls).toEqual([
      {
        operation: "image.create",
        payload: {
          data: {
            image_type: "message",
            image: Buffer.from("png"),
          },
        },
      },
      {
        operation: "file.create",
        payload: {
          data: {
            file_type: "pdf",
            file_name: "report.pdf",
            file: Buffer.from("pdf"),
          },
        },
      },
    ]);
  });
});

function createFakeClient(
  calls: unknown[],
  options?: {
    readonly resource?:
      | {
          readonly getReadableStream?: (() => Readable) | undefined;
          readonly headers?: Record<string, unknown> | undefined;
        }
      | undefined;
  },
) {
  return {
    im: {
      v1: {
        message: {
          create: async (payload: unknown) => {
            calls.push({ operation: "create", payload });
            return {
              code: 0,
              data: {
                message_id: "om_created",
              },
            };
          },
          reply: async (payload: unknown) => {
            calls.push({ operation: "reply", payload });
            return {
              code: 0,
              data: {
                message_id: "om_reply",
              },
            };
          },
          patch: async (payload: unknown) => {
            calls.push({ operation: "patch", payload });
            return {
              code: 0,
              data: {
                message_id: "om_status",
              },
            };
          },
          list: async (payload: unknown) => {
            calls.push({ operation: "list", payload });
            return {
              code: 0,
              data: {
                has_more: false,
                items: [],
              },
            };
          },
        },
        image: {
          create: async (payload: unknown) => {
            calls.push({ operation: "image.create", payload });
            return {
              image_key: "img_uploaded",
            };
          },
        },
        file: {
          create: async (payload: unknown) => {
            calls.push({ operation: "file.create", payload });
            return {
              code: 0,
              data: {
                file_key: "file_uploaded",
              },
            };
          },
        },
        messageResource: {
          get: async (payload: unknown) => {
            calls.push({ operation: "resource.get", payload });
            return {
              getReadableStream: options?.resource?.getReadableStream ?? (() => Readable.from([Buffer.from("hello")])),
              headers: options?.resource?.headers ?? {
                "content-type": "image/png; charset=utf-8",
              },
            };
          },
        },
      },
    },
  };
}
