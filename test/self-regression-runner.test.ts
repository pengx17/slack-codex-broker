import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { collectSelfRegressionReport, evaluateSlackSelfRegressionPreflight, evaluateSlackSelfRegressionStatus, writeSelfRegressionBundle } from "./manual/run-self-regression.js";

describe("self-regression runner", () => {
  it("checks Slack preflight without exposing token values", () => {
    const report = evaluateSlackSelfRegressionPreflight(
      {
        mode: "preflight",
        channel: "#xp-test",
      },
      {
        SLACK_APP_TOKEN: "xapp-secret-value",
        SLACK_BOT_TOKEN: "xoxb-secret-value",
        SLACK_USER_TOKEN: "xoxp-secret-value",
      },
    );

    expect(report.ok).toBe(true);
    expect(JSON.stringify(report)).not.toContain("secret-value");
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "preflight.slack_channel_configured",
          status: "pass",
          evidence: ["channel=#xp-test"],
        }),
      ]),
    );

    const channelIdReport = evaluateSlackSelfRegressionPreflight(
      {
        mode: "preflight",
        channel: "C0ALMF2AD70",
      },
      {
        SLACK_APP_TOKEN: "xapp-secret-value",
        SLACK_BOT_TOKEN: "xoxb-secret-value",
        SLACK_USER_TOKEN: "xoxp-secret-value",
      },
    );

    expect(channelIdReport.ok).toBe(true);
    expect(channelIdReport.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "preflight.slack_channel_safe_label",
          status: "pass",
          evidence: ["channel_label=channel_id"],
        }),
      ]),
    );
  });

  it("replays Slack admin status for roundtrip, status, and file evidence", () => {
    const report = evaluateSlackSelfRegressionStatus(
      {
        platforms: {
          slack: {
            state: "ready",
            connectionMode: "socket_mode",
          },
        },
        state: {
          recentBrokerLogs: [
            {
              message: "chat.platform.ready",
              meta: {
                platform: "slack",
                source: "socket_mode",
              },
            },
            {
              message: "chat.message.accepted",
              meta: {
                platform: "slack",
                sessionKey: "C123:111.222",
                conversationId: "C123",
                rootMessageId: "111.222",
                messageId: "111.222",
              },
            },
            {
              message: "slack.assistant.status.updated",
              meta: {
                platform: "slack",
                sessionKey: "C123:111.222",
                status: "Thinking...",
              },
            },
            {
              message: "chat.outbound.posted",
              meta: {
                platform: "slack",
                sessionKey: "C123:111.222",
                conversationId: "C123",
                rootMessageId: "111.222",
                messageId: "111.333",
                format: "text",
              },
            },
            {
              message: "chat.outbound.posted",
              meta: {
                platform: "slack",
                sessionKey: "C123:111.222",
                conversationId: "C123",
                rootMessageId: "111.222",
                messageId: "F123",
                format: "file",
              },
            },
          ],
        },
      },
      {
        mode: "replay",
        manifest: {
          platform: "slack",
          mode: "replay",
          checkedAt: "2026-05-30T00:00:00.000Z",
          command: "pnpm manual:self-regression -- --platform slack --replay --status-file evidence/self-regression/slack/admin-status.json",
          sanitizedSourceFiles: ["evidence/self-regression/slack/admin-status.json"],
        },
      },
    );

    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => `${check.id}:${check.status}`)).toEqual(expect.arrayContaining(["runtime.slack_ready:pass", "slack.message_roundtrip:pass", "slack.work_status_visible:pass", "slack.file_artifact_path:pass"]));
  });

  it("writes sanitized reports and manifests without copying host paths or tokens", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "self-regression-bundle-"));
    const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "self-regression-private-"));
    const envFile = path.join(privateRoot, ".env");
    await fs.writeFile(envFile, "SLACK_APP_TOKEN=xapp-file-secret\n");
    const report = await collectSelfRegressionReport(
      {
        platform: "slack",
        mode: "preflight",
        baseUrl: "http://127.0.0.1:3000",
        envFile,
        channel: "#xp-test",
        waitMs: 0,
        intervalMs: 1000,
        json: true,
      },
      {
        cwd: "/Users/pengx17/Documents/slack-codex-broker",
        argv: ["--platform", "slack", "--preflight", "--channel", "#xp-test", "--env-file", envFile, "--json"],
        env: {
          SLACK_APP_TOKEN: "xapp-secret-value",
          SLACK_BOT_TOKEN: "xoxb-secret-value",
          SLACK_USER_TOKEN: "xoxp-secret-value",
        },
        now: new Date("2026-05-30T00:00:00.000Z"),
      },
    );

    const bundle = await writeSelfRegressionBundle({
      outputDir: tempRoot,
      report,
    });
    const savedReport = await fs.readFile(bundle.reportFile, "utf8");
    const manifest = await fs.readFile(bundle.manifestFile, "utf8");

    expect(savedReport).not.toContain("secret-value");
    expect(savedReport).not.toContain("/Users/pengx17/private");
    expect(manifest).not.toContain("secret-value");
    expect(manifest).not.toContain("/Users/pengx17/private");
    expect(JSON.parse(manifest)).toMatchObject({
      platform: "slack",
      mode: "preflight",
      sanitizedSourceFiles: [".env"],
    });
  });

  it("uses the Feishu smoke evaluator for Feishu preflight under the shared command", async () => {
    const report = await collectSelfRegressionReport(
      {
        platform: "feishu",
        mode: "preflight",
        baseUrl: "http://127.0.0.1:3000",
        waitMs: 0,
        intervalMs: 1000,
        json: true,
      },
      {
        env: {
          SLACK_APP_TOKEN: "xapp-secret-value",
          SLACK_BOT_TOKEN: "xoxb-secret-value",
          FEISHU_ENABLED: "true",
          FEISHU_APP_ID: "set",
          FEISHU_APP_SECRET: "set",
          FEISHU_BOT_OPEN_ID: "set",
          FEISHU_DOMAIN: "feishu",
          FEISHU_API_BASE_URL: "https://open.feishu.cn/open-apis",
          FEISHU_GROUP_MESSAGE_MODE: "all",
          FEISHU_STARTUP_REQUIRED: "true",
          LOG_RAW_FEISHU_EVENTS: "false",
        },
        now: new Date("2026-05-30T00:00:00.000Z"),
      },
    );

    expect(report.platform).toBe("feishu");
    expect(report.mode).toBe("preflight");
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "preflight.feishu_enabled",
          status: "pass",
        }),
      ]),
    );
    expect(JSON.stringify(report)).not.toContain("secret-value");
  });

  it("fails Feishu observe when the manual action provenance is missing", async () => {
    const report = await collectSelfRegressionReport(
      {
        platform: "feishu",
        mode: "observe",
        baseUrl: "http://127.0.0.1:3000",
        setupEvidenceFile: "evidence/feishu-smoke/feishu-setup-evidence.json",
        waitMs: 0,
        intervalMs: 1000,
        json: true,
      },
      {
        env: {
          FEISHU_ENABLED: "true",
        },
        now: new Date("2026-05-30T00:00:00.000Z"),
      },
    );

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.observe.manual_action_provenance",
          status: "fail",
          evidence: ["manual_action=missing"],
        }),
      ]),
    );
  });

  it("records sanitized Feishu observe manual action provenance", async () => {
    const report = await collectSelfRegressionReport(
      {
        platform: "feishu",
        mode: "observe",
        baseUrl: "http://127.0.0.1:3000",
        statusFile: "evidence/feishu-smoke/admin-status.json",
        setupEvidenceFile: "evidence/feishu-smoke/feishu-setup-evidence.json",
        manualAction: "operator@example.com used https://feishu.example.test to send @bot plus non-@ follow-up",
        waitMs: 0,
        intervalMs: 1000,
        json: true,
      },
      {
        argv: ["--platform", "feishu", "--observe", "--manual-action", "operator@example.com used https://feishu.example.test to send @bot plus non-@ follow-up", "--status-file", "evidence/feishu-smoke/admin-status.json", "--setup-evidence-file", "evidence/feishu-smoke/feishu-setup-evidence.json", "--json"],
        env: {
          FEISHU_ENABLED: "true",
          FEISHU_APP_ID: "set",
          FEISHU_APP_SECRET: "set",
          FEISHU_BOT_OPEN_ID: "set",
          FEISHU_DOMAIN: "feishu",
          FEISHU_API_BASE_URL: "https://open.feishu.cn/open-apis",
          FEISHU_GROUP_MESSAGE_MODE: "all",
          FEISHU_STARTUP_REQUIRED: "true",
          LOG_RAW_FEISHU_EVENTS: "false",
        },
        now: new Date("2026-05-30T00:00:00.000Z"),
      },
    );

    expect(report.ok).toBe(true);
    expect(report.manifest.manualAction).toBe("[redacted-email] used [redacted-url] to send @bot plus non-@ follow-up");
    expect(report.manifest.command).toContain("--manual-action [redacted]");
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.observe.manual_action_provenance",
          status: "pass",
          evidence: ["manual_action=[redacted-email] used [redacted-url] to send @bot plus non-@ follow-up"],
        }),
      ]),
    );
    expect(JSON.stringify(report)).not.toContain("operator@example.com");
    expect(JSON.stringify(report)).not.toContain("feishu.example.test");
  });

  it("drives Slack by resolving a channel label, posting a mention, and observing admin status", async () => {
    const calls: string[] = [];
    const fetch = async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      calls.push(href);
      if (href === "https://slack.com/api/auth.test") {
        const authorization = new Headers(init?.headers).get("authorization");
        if (authorization === "Bearer xoxp-secret-value") {
          return jsonResponse({
            ok: true,
            user: "test-user",
            user_id: "UUSER",
          });
        }
        return jsonResponse({
          ok: true,
          user: "bot",
          user_id: "UBOT",
          app_id: "A123",
        });
      }
      if (href.startsWith("https://slack.com/api/conversations.list")) {
        const authorization = new Headers(init?.headers).get("authorization");
        if (authorization === "Bearer xoxp-secret-value") {
          return jsonResponse({
            ok: false,
            error: "missing_scope",
          });
        }
        return jsonResponse({
          ok: true,
          channels: [
            {
              id: "CXPTEST",
              name: "xp-test",
            },
          ],
          response_metadata: {
            next_cursor: "",
          },
        });
      }
      if (href === "https://slack.com/api/chat.postMessage") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).toMatchObject({
          channel: "CXPTEST",
        });
        expect(String(body.text)).toContain("<@UBOT>");
        return jsonResponse({
          ok: true,
          ts: "111.222",
        });
      }
      if (href === "http://127.0.0.1:3000/chat/post-file") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).toMatchObject({
          platform: "slack",
          conversation_id: "CXPTEST",
          root_message_id: "111.222",
          filename: "self-regression.txt",
        });
        expect(String(body.content_base64)).not.toContain("self-regression artifact");
        return jsonResponse({
          ok: true,
          file: {
            id: "F123",
          },
        });
      }
      if (href === "http://127.0.0.1:3000/admin/api/status?platform=slack") {
        return jsonResponse(slackReplayStatus());
      }
      throw new Error(`unexpected fetch ${href}`);
    };

    const report = await collectSelfRegressionReport(
      {
        platform: "slack",
        mode: "drive",
        baseUrl: "http://127.0.0.1:3000",
        channel: "#xp-test",
        waitMs: 0,
        intervalMs: 1000,
        json: true,
      },
      {
        fetch: fetch as typeof globalThis.fetch,
        env: {
          SLACK_APP_TOKEN: "xapp-1-A123-secret-value",
          SLACK_BOT_TOKEN: "xoxb-secret-value",
          SLACK_USER_TOKEN: "xoxp-secret-value",
        },
        now: new Date("2026-05-30T00:00:00.000Z"),
      },
    );

    expect(report.ok).toBe(true);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "slack.drive.message_posted",
          status: "pass",
        }),
        expect.objectContaining({
          id: "slack.drive.file_posted",
          status: "pass",
        }),
      ]),
    );
    expect(calls).toEqual(expect.arrayContaining(["https://slack.com/api/auth.test", expect.stringContaining("https://slack.com/api/conversations.list"), "https://slack.com/api/chat.postMessage", "http://127.0.0.1:3000/chat/post-file", "http://127.0.0.1:3000/admin/api/status?platform=slack"]));
    expect(JSON.stringify(report)).not.toContain("secret-value");
    expect(JSON.stringify(report)).toContain("channel_resolved_by=bot");
  });

  it("reports Slack posting scope posture when auto-drive cannot create the user message", async () => {
    const fetch = async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href === "https://slack.com/api/auth.test") {
        const authorization = new Headers(init?.headers).get("authorization");
        if (authorization === "Bearer xoxp-secret-value") {
          return jsonResponse({
            ok: true,
            user: "test-user",
            user_id: "UUSER",
          });
        }
        return jsonResponse({
          ok: true,
          user: "bot",
          user_id: "UBOT",
          app_id: "A123",
        });
      }
      if (href.startsWith("https://slack.com/api/conversations.list")) {
        return jsonResponse({
          ok: true,
          channels: [
            {
              id: "CXPTEST",
              name: "xp-test",
            },
          ],
          response_metadata: {
            next_cursor: "",
          },
        });
      }
      if (href === "https://slack.com/api/chat.postMessage") {
        return jsonResponse({
          ok: false,
          error: "missing_scope",
          needed: "chat:write:bot",
          provided: "identify,channels:history",
        });
      }
      throw new Error(`unexpected fetch ${href}`);
    };

    const report = await collectSelfRegressionReport(
      {
        platform: "slack",
        mode: "drive",
        baseUrl: "http://127.0.0.1:3000",
        channel: "#xp-test",
        waitMs: 0,
        intervalMs: 1000,
        json: true,
      },
      {
        fetch: fetch as typeof globalThis.fetch,
        env: {
          SLACK_APP_TOKEN: "xapp-1-A123-secret-value",
          SLACK_BOT_TOKEN: "xoxb-secret-value",
          SLACK_USER_TOKEN: "xoxp-secret-value",
        },
        now: new Date("2026-05-30T00:00:00.000Z"),
      },
    );

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "slack.drive.message_posted",
          status: "fail",
          evidence: ["Slack chat.postMessage failed: missing_scope needed=chat:write:bot provided=identify,channels:history"],
        }),
      ]),
    );
    expect(JSON.stringify(report)).not.toContain("secret-value");
  });

  it("fails Slack drive early when the drive user token authenticates as the bot", async () => {
    const calls: string[] = [];
    const fetch = async (url: string | URL) => {
      const href = String(url);
      calls.push(href);
      if (href === "https://slack.com/api/auth.test") {
        return jsonResponse({
          ok: true,
          user: "workworktest",
          user_id: "UBOT",
          app_id: "A123",
        });
      }
      throw new Error(`unexpected fetch ${href}`);
    };

    const report = await collectSelfRegressionReport(
      {
        platform: "slack",
        mode: "drive",
        baseUrl: "http://127.0.0.1:3000",
        channel: "#xp-test",
        waitMs: 0,
        intervalMs: 1000,
        json: true,
      },
      {
        fetch: fetch as typeof globalThis.fetch,
        env: {
          SLACK_APP_TOKEN: "xapp-1-A123-secret-value",
          SLACK_BOT_TOKEN: "xoxb-secret-value",
          SLACK_USER_TOKEN: "xoxp-secret-value",
        },
        now: new Date("2026-05-30T00:00:00.000Z"),
      },
    );

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "slack.drive.user_actor_distinct",
          status: "fail",
          evidence: ["drive_user_id=UBOT", "bot_user_id=UBOT", "drive_user=workworktest"],
        }),
      ]),
    );
    expect(calls).toEqual(["https://slack.com/api/auth.test", "https://slack.com/api/auth.test"]);
    expect(JSON.stringify(report)).not.toContain("secret-value");
  });

  it("fails Slack drive early when the app token and bot token belong to different apps", async () => {
    const calls: string[] = [];
    const fetch = async (url: string | URL) => {
      const href = String(url);
      calls.push(href);
      if (href === "https://slack.com/api/auth.test") {
        return jsonResponse({
          ok: true,
          user_id: "UBOT",
          app_id: "AOLDAPP",
        });
      }
      throw new Error(`unexpected fetch ${href}`);
    };

    const report = await collectSelfRegressionReport(
      {
        platform: "slack",
        mode: "drive",
        baseUrl: "http://127.0.0.1:3000",
        channel: "#xp-test",
        waitMs: 0,
        intervalMs: 1000,
        json: true,
      },
      {
        fetch: fetch as typeof globalThis.fetch,
        env: {
          SLACK_APP_TOKEN: "xapp-1-ANEWAPP-secret-value",
          SLACK_BOT_TOKEN: "xoxb-secret-value",
          SLACK_USER_TOKEN: "xoxp-secret-value",
        },
        now: new Date("2026-05-30T00:00:00.000Z"),
      },
    );

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "slack.drive.credential_alignment",
          status: "fail",
          evidence: ["bot_app_id=AOLDAPP", "app_token_app_id=ANEWAPP", "bot_user_id=UBOT"],
        }),
      ]),
    );
    expect(calls).toEqual(["https://slack.com/api/auth.test"]);
    expect(JSON.stringify(report)).not.toContain("secret-value");
  });

  it("falls back to bots.info for Slack bot app identity when auth.test omits it", async () => {
    const calls: string[] = [];
    const fetch = async (url: string | URL) => {
      const href = String(url);
      calls.push(href);
      if (href === "https://slack.com/api/auth.test") {
        return jsonResponse({
          ok: true,
          user_id: "UBOT",
          bot_id: "BBOT",
        });
      }
      if (href === "https://slack.com/api/bots.info?bot=BBOT") {
        return jsonResponse({
          ok: true,
          bot: {
            app_id: "AOLDAPP",
          },
        });
      }
      throw new Error(`unexpected fetch ${href}`);
    };

    const report = await collectSelfRegressionReport(
      {
        platform: "slack",
        mode: "drive",
        baseUrl: "http://127.0.0.1:3000",
        channel: "#xp-test",
        waitMs: 0,
        intervalMs: 1000,
        json: true,
      },
      {
        fetch: fetch as typeof globalThis.fetch,
        env: {
          SLACK_APP_TOKEN: "xapp-1-ANEWAPP-secret-value",
          SLACK_BOT_TOKEN: "xoxb-secret-value",
          SLACK_USER_TOKEN: "xoxp-secret-value",
        },
        now: new Date("2026-05-30T00:00:00.000Z"),
      },
    );

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "slack.drive.credential_alignment",
          status: "fail",
          evidence: ["bot_app_id=AOLDAPP", "app_token_app_id=ANEWAPP", "bot_user_id=UBOT"],
        }),
      ]),
    );
    expect(calls).toEqual(["https://slack.com/api/auth.test", "https://slack.com/api/bots.info?bot=BBOT"]);
    expect(JSON.stringify(report)).not.toContain("secret-value");
  });
});

function slackReplayStatus(): unknown {
  const conversationId = "CXPTEST";
  const rootMessageId = "111.222";
  const sessionKey = `${conversationId}:${rootMessageId}`;
  return {
    platforms: {
      slack: {
        state: "ready",
        connectionMode: "socket_mode",
      },
    },
    state: {
      recentBrokerLogs: [
        {
          message: "chat.platform.ready",
          meta: {
            platform: "slack",
            source: "socket_mode",
          },
        },
        {
          message: "chat.message.accepted",
          meta: {
            platform: "slack",
            sessionKey,
            conversationId,
            rootMessageId,
            messageId: rootMessageId,
          },
        },
        {
          message: "slack.assistant.status.updated",
          meta: {
            platform: "slack",
            sessionKey,
          },
        },
        {
          message: "chat.outbound.posted",
          meta: {
            platform: "slack",
            sessionKey,
            conversationId,
            rootMessageId,
            messageId: "111.333",
            format: "text",
          },
        },
        {
          message: "chat.outbound.posted",
          meta: {
            platform: "slack",
            sessionKey,
            conversationId,
            rootMessageId,
            messageId: "F123",
            format: "file",
          },
        },
      ],
    },
  };
}

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as Response;
}
