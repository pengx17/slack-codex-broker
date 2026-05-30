#!/usr/bin/env node
/* oxlint-disable max-lines */

import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { createFeishuSmokeUnavailableReport, evaluateFeishuSmokePreflight, evaluateFeishuSmokeStatus, formatFeishuSmokeCliError, loadFeishuSmokeEnv, type FeishuSmokeCheck, type FeishuSmokeReport } from "./run-real-feishu-smoke.js";

type SelfRegressionPlatform = "slack" | "feishu";
type SelfRegressionMode = "preflight" | "observe" | "replay" | "drive";
type SelfRegressionStatus = "pass" | "fail" | "warn";

export interface SelfRegressionCheck {
  readonly id: string;
  readonly label: string;
  readonly required: boolean;
  readonly status: SelfRegressionStatus;
  readonly evidence: readonly string[];
  readonly nextAction?: string | undefined;
}

export interface SelfRegressionManifest {
  readonly platform: SelfRegressionPlatform;
  readonly mode: SelfRegressionMode;
  readonly checkedAt: string;
  readonly command: string;
  readonly sanitizedSourceFiles: readonly string[];
  readonly manualAction?: string | undefined;
}

export interface SelfRegressionReport {
  readonly ok: boolean;
  readonly platform: SelfRegressionPlatform;
  readonly mode: SelfRegressionMode;
  readonly checkedAt: string;
  readonly checks: readonly SelfRegressionCheck[];
  readonly manifest: SelfRegressionManifest;
  readonly nextActions: readonly string[];
}

interface CliOptions {
  readonly platform: SelfRegressionPlatform;
  readonly mode: SelfRegressionMode;
  readonly baseUrl: string;
  readonly adminToken?: string | undefined;
  readonly statusFile?: string | undefined;
  readonly setupEvidenceFile?: string | undefined;
  readonly outputDir?: string | undefined;
  readonly envFile?: string | undefined;
  readonly channel?: string | undefined;
  readonly manualAction?: string | undefined;
  readonly waitMs: number;
  readonly intervalMs: number;
  readonly json: boolean;
}

interface CollectOptions {
  readonly cwd?: string | undefined;
  readonly argv?: readonly string[] | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
  readonly now?: Date | undefined;
  readonly fetch?: typeof fetch | undefined;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:3000";
const SAFE_CHANNEL_NAME = /^#[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SAFE_CHANNEL_ID = /^[CDG][A-Z0-9]{8,}$/u;

export async function collectSelfRegressionReport(options: CliOptions, collectOptions: CollectOptions = {}): Promise<SelfRegressionReport> {
  const cwd = collectOptions.cwd ?? process.cwd();
  const baseEnv = collectOptions.env ?? process.env;
  const env = await loadFeishuSmokeEnv(baseEnv, options.envFile);
  const checkedAt = (collectOptions.now ?? new Date()).toISOString();
  const command = sanitizeCommand(["pnpm", "manual:self-regression", "--", ...(collectOptions.argv ?? [])]);
  const sourceFiles = [...(options.envFile ? [options.envFile] : []), ...(options.statusFile ? [options.statusFile] : []), ...(options.setupEvidenceFile ? [options.setupEvidenceFile] : [])].map((filePath) => sanitizeSourceFile(filePath, cwd));
  const manifest: SelfRegressionManifest = {
    platform: options.platform,
    mode: options.mode,
    checkedAt,
    command,
    sanitizedSourceFiles: sourceFiles,
    manualAction: options.manualAction ? sanitizeManualAction(options.manualAction) : undefined,
  };

  if (options.platform === "feishu") {
    return collectFeishuSelfRegressionReport(options, env, manifest, collectOptions.fetch ?? fetch);
  }

  return collectSlackSelfRegressionReport(options, env, manifest, collectOptions.fetch ?? fetch);
}

async function collectFeishuSelfRegressionReport(options: CliOptions, env: Record<string, string | undefined>, manifest: SelfRegressionManifest, fetchFn: typeof fetch): Promise<SelfRegressionReport> {
  if (options.mode === "preflight") {
    return fromFeishuSmokeReport(evaluateFeishuSmokePreflight(env), {
      platform: "feishu",
      mode: "preflight",
      manifest,
    });
  }

  if (options.mode === "drive") {
    return createReport({
      platform: "feishu",
      mode: "drive",
      manifest,
      checks: [
        {
          id: "feishu.drive.requires_external_user",
          label: "Feishu auto-drive requires a human/browser/test-user driver",
          required: true,
          status: "fail",
          evidence: ["app-only bot credentials cannot prove user inbound or non-@ follow-up"],
          nextAction: "Use --observe after manual Feishu actions, or add a browser/test-user driver before claiming unattended Feishu auto-drive.",
        },
      ],
    });
  }

  if (options.mode === "observe" && !options.manualAction?.trim()) {
    return createReport({
      platform: "feishu",
      mode: "observe",
      manifest,
      checks: [feishuManualActionCheck(options.manualAction)],
    });
  }

  const setupEvidence = options.setupEvidenceFile ? await readJsonFile(options.setupEvidenceFile) : undefined;
  const status = options.statusFile ? await readJsonFile(options.statusFile) : await fetchAdminStatusWithRetry(options, fetchFn);
  const report = evaluateFeishuSmokeStatus(status, env, {
    requireSetupEvidence: true,
    setupEvidence,
  });
  const selfRegressionReport = fromFeishuSmokeReport(report, {
    platform: "feishu",
    mode: options.statusFile ? "replay" : "observe",
    manifest,
  });
  if (options.mode !== "observe") {
    return selfRegressionReport;
  }
  return createReport({
    platform: "feishu",
    mode: "observe",
    manifest,
    checks: [feishuManualActionCheck(options.manualAction), ...selfRegressionReport.checks],
  });
}

function feishuManualActionCheck(manualAction: string | undefined): SelfRegressionCheck {
  const sanitized = manualAction ? sanitizeManualAction(manualAction) : "";
  return booleanCheck({
    id: "feishu.observe.manual_action_provenance",
    label: "Feishu observe evidence names the human/browser action that produced inbound work",
    required: true,
    passed: Boolean(sanitized),
    evidence: sanitized ? [`manual_action=${sanitized}`] : ["manual_action=missing"],
    nextAction: "Rerun Feishu observe with --manual-action describing the controlled @bot, non-@ follow-up, card/file action, or browser/test-user driver run.",
  });
}

async function collectSlackSelfRegressionReport(options: CliOptions, env: Record<string, string | undefined>, manifest: SelfRegressionManifest, fetchFn: typeof fetch): Promise<SelfRegressionReport> {
  if (options.mode === "preflight") {
    return evaluateSlackSelfRegressionPreflight(options, env, manifest);
  }

  let driveChecks: readonly SelfRegressionCheck[] = [];
  if (options.mode === "drive") {
    driveChecks = await driveSlackSelfRegression(options, env, fetchFn);
    if (driveChecks.some((check) => check.required && check.status !== "pass")) {
      return createReport({
        platform: "slack",
        mode: "drive",
        manifest,
        checks: driveChecks,
      });
    }
  }

  const status = options.statusFile ? await readJsonFile(options.statusFile) : await fetchAdminStatusWithRetry(options, fetchFn);
  return evaluateSlackSelfRegressionStatus(status, {
    mode: options.statusFile ? "replay" : options.mode,
    manifest,
    driveChecks,
  });
}

export function evaluateSlackSelfRegressionPreflight(options: Pick<CliOptions, "channel" | "mode">, env: Record<string, string | undefined>, manifest?: SelfRegressionManifest): SelfRegressionReport {
  const channel = options.channel ?? env.SLACK_SELF_REGRESSION_CHANNEL;
  const checks: SelfRegressionCheck[] = [
    booleanCheck({
      id: "preflight.slack_app_token_present",
      label: "Slack app-level token is present for Socket Mode",
      required: true,
      passed: Boolean(env.SLACK_APP_TOKEN),
      evidence: [`SLACK_APP_TOKEN=${env.SLACK_APP_TOKEN ? "set" : "missing"}`],
      nextAction: "Export SLACK_APP_TOKEN before running Slack self-regression.",
    }),
    booleanCheck({
      id: "preflight.slack_bot_token_present",
      label: "Slack bot token is present for broker replies",
      required: true,
      passed: Boolean(env.SLACK_BOT_TOKEN),
      evidence: [`SLACK_BOT_TOKEN=${env.SLACK_BOT_TOKEN ? "set" : "missing"}`],
      nextAction: "Export SLACK_BOT_TOKEN before running Slack self-regression.",
    }),
    booleanCheck({
      id: "preflight.slack_user_token_present",
      label: "Slack user token is present for controlled channel drive",
      required: true,
      passed: Boolean(env.SLACK_USER_TOKEN),
      evidence: [`SLACK_USER_TOKEN=${env.SLACK_USER_TOKEN ? "set" : "missing"}`],
      nextAction: "Export SLACK_USER_TOKEN so the runner can post a controlled human message.",
    }),
    booleanCheck({
      id: "preflight.slack_channel_configured",
      label: "Slack self-regression channel is configured",
      required: true,
      passed: Boolean(channel?.trim()),
      evidence: [`channel=${formatSlackChannelEvidence(channel)}`],
      nextAction: "Pass --channel '#xp-test' or set SLACK_SELF_REGRESSION_CHANNEL locally.",
    }),
    booleanCheck({
      id: "preflight.slack_channel_safe_label",
      label: "Slack self-regression channel evidence is safe to attach",
      required: true,
      passed: !channel || isSafeSlackChannelInput(channel),
      evidence: [`channel_label=${formatSlackChannelEvidence(channel)}`],
      nextAction: "Use a channel label such as #xp-test or a Slack channel id; do not paste private URLs, tokens, or message bodies.",
    }),
  ];

  return createReport({
    platform: "slack",
    mode: "preflight",
    manifest: manifest ?? {
      platform: "slack",
      mode: "preflight",
      checkedAt: new Date().toISOString(),
      command: "pnpm manual:self-regression -- --platform slack --preflight",
      sanitizedSourceFiles: [],
    },
    checks,
  });
}

export function evaluateSlackSelfRegressionStatus(
  status: unknown,
  options: {
    readonly mode: SelfRegressionMode;
    readonly manifest: SelfRegressionManifest;
    readonly driveChecks?: readonly SelfRegressionCheck[] | undefined;
  },
): SelfRegressionReport {
  const root = asRecord(status);
  const platforms = asRecord(root.platforms);
  const slack = asRecord(platforms.slack);
  const state = asRecord(root.state);
  const logs = asArray(state.recentBrokerLogs);
  const accepted = matchingLogs(logs, "chat.message.accepted", {
    platform: "slack",
  });
  const posted = matchingLogs(logs, "chat.outbound.posted", {
    platform: "slack",
  });
  const statusEvidence = findSlackWorkStatusEvidence(logs);
  const fileEvidence = findSlackFileEvidence(logs);

  const checks: SelfRegressionCheck[] = [
    ...(options.driveChecks ?? []),
    booleanCheck({
      id: "runtime.slack_ready",
      label: "Slack reports ready in the broker runtime",
      required: true,
      passed: readString(slack.state) === "ready",
      evidence: [`platforms.slack.state=${readString(slack.state) ?? "unknown"}`],
      nextAction: "Start the broker with Slack Socket Mode connected before collecting self-regression evidence.",
    }),
    booleanCheck({
      id: "slack.socket_mode_ready",
      label: "Slack Socket Mode reached ready state",
      required: true,
      passed: matchingLogs(logs, "chat.platform.ready", { platform: "slack", source: "socket_mode" }).length > 0 || readString(slack.connectionMode) === "socket_mode",
      evidence: [`connectionMode=${readString(slack.connectionMode) ?? "unknown"}`, ...matchingLogs(logs, "chat.platform.ready", { platform: "slack" }).slice(-3).map(summarizeLog)],
      nextAction: "Save admin status with chat.platform.ready platform=slack source=socket_mode, or platform connectionMode=socket_mode.",
    }),
    booleanCheck({
      id: "slack.message_roundtrip",
      label: "Slack accepted an inbound message and posted an outbound reply",
      required: true,
      passed: accepted.length > 0 && posted.length > 0 && hasOverlappingSessionCoordinates(accepted, posted),
      evidence: [...accepted.slice(-3).map(summarizeLog), ...posted.slice(-3).map(summarizeLog)],
      nextAction: "Post a controlled Slack mention in the self-regression channel and wait for matching inbound/outbound broker logs.",
    }),
    booleanCheck({
      id: "slack.work_status_visible",
      label: "Slack work status or fallback reaction evidence is present",
      required: true,
      passed: statusEvidence.length > 0,
      evidence: statusEvidence.length > 0 ? statusEvidence : ["missing=assistant_status_or_fallback_reaction"],
      nextAction: "Capture assistant.threads.setStatus evidence or fallback eyes reaction evidence during an active Slack turn.",
    }),
    booleanCheck({
      id: "slack.file_artifact_path",
      label: "Slack file/artifact path was exercised or explicitly unavailable",
      required: true,
      passed: fileEvidence.length > 0,
      evidence: fileEvidence.length > 0 ? fileEvidence : ["missing=file_or_permission_evidence"],
      nextAction: "Exercise Slack file upload, or save a structured file upload failure showing workspace permission unavailability.",
    }),
  ];

  return createReport({
    platform: "slack",
    mode: options.mode,
    manifest: options.manifest,
    checks,
  });
}

async function driveSlackSelfRegression(options: CliOptions, env: Record<string, string | undefined>, fetchFn: typeof fetch): Promise<readonly SelfRegressionCheck[]> {
  const channel = options.channel ?? env.SLACK_SELF_REGRESSION_CHANNEL;
  const preflight = evaluateSlackSelfRegressionPreflight(options, env).checks;
  const requiredFailures = preflight.filter((check) => check.required && check.status !== "pass");
  if (requiredFailures.length > 0) {
    return [
      ...preflight,
      {
        id: "slack.drive.skipped_preflight",
        label: "Slack drive was skipped because preflight failed",
        required: true,
        status: "fail",
        evidence: requiredFailures.map((check) => `${check.id}=${check.status}`),
        nextAction: "Fix Slack drive preflight, then rerun --drive.",
      },
    ];
  }

  try {
    const checks: SelfRegressionCheck[] = [];
    const credentialCheck = await checkSlackCredentialAlignment(env.SLACK_APP_TOKEN!, env.SLACK_BOT_TOKEN!, fetchFn);
    if (credentialCheck.status !== "pass") {
      return [credentialCheck];
    }
    const botUserId = credentialCheck.botUserId!;
    const actorCheck = await checkSlackDriveActorSeparation(env.SLACK_USER_TOKEN!, {
      botUserId,
      fetch: fetchFn,
    });
    if (actorCheck.status !== "pass") {
      return [actorCheck];
    }
    const resolvedChannel = await resolveSlackChannelId({
      tokens: [
        {
          label: "user",
          token: env.SLACK_USER_TOKEN!,
        },
        {
          label: "bot",
          token: env.SLACK_BOT_TOKEN!,
        },
      ],
      channel: channel!,
      fetch: fetchFn,
    });
    const message = await postSlackDriveMessage({
      token: env.SLACK_USER_TOKEN!,
      channel: resolvedChannel.id,
      text: `<@${botUserId}> self-regression ${Date.now()} reply with SELF_REGRESSION_OK`,
      fetch: fetchFn,
    });
    checks.push({
      id: "slack.drive.message_posted",
      label: "Slack drive posted a controlled user message",
      required: true,
      status: "pass",
      evidence: [`channel=${formatSlackChannelEvidence(channel)}`, `channel_resolved_by=${resolvedChannel.resolvedBy}`, `ts=${sanitizeEvidenceText(message.ts)}`],
    });
    const acceptedCheck = await waitForSlackDriveSessionAccepted({
      options,
      conversationId: resolvedChannel.id,
      rootMessageId: message.ts,
      fetch: fetchFn,
    });
    checks.push(acceptedCheck);
    if (acceptedCheck.status !== "pass") {
      return checks;
    }
    const file = await postSlackDriveFile({
      baseUrl: options.baseUrl,
      platform: "slack",
      conversationId: resolvedChannel.id,
      rootMessageId: message.ts,
      fetch: fetchFn,
    });
    checks.push({
      id: "slack.drive.file_posted",
      label: "Slack drive exercised a controlled file upload",
      required: true,
      status: "pass",
      evidence: [`channel=${formatSlackChannelEvidence(channel)}`, `rootMessageId=${sanitizeEvidenceText(message.ts)}`, `file=${file}`],
    });
    return checks;
  } catch (error) {
    return [
      {
        id: "slack.drive.message_posted",
        label: "Slack drive posted a controlled user message",
        required: true,
        status: "fail",
        evidence: [formatFeishuSmokeCliError(error)],
        nextAction: "Verify Slack user/bot token scopes, channel membership, and network access, then rerun --drive.",
      },
    ];
  }
}

async function checkSlackDriveActorSeparation(userToken: string, options: { readonly botUserId: string; readonly fetch: typeof fetch }): Promise<SelfRegressionCheck> {
  const userIdentity = await fetchSlackAuthIdentity(userToken, options.fetch);
  const passed = Boolean(userIdentity.userId && userIdentity.userId !== options.botUserId);
  return {
    id: "slack.drive.user_actor_distinct",
    label: "Slack drive user token belongs to a human/test user, not the bot",
    required: true,
    status: passed ? "pass" : "fail",
    evidence: [`drive_user_id=${userIdentity.userId ?? "unknown"}`, `bot_user_id=${options.botUserId}`, `drive_user=${userIdentity.user ?? "unknown"}`],
    nextAction: passed ? undefined : "Replace SLACK_USER_TOKEN with a real user token for the test workspace; bot tokens cannot prove inbound human messages.",
  };
}

async function waitForSlackDriveSessionAccepted(options: { readonly options: CliOptions; readonly conversationId: string; readonly rootMessageId: string; readonly fetch: typeof fetch }): Promise<SelfRegressionCheck> {
  const deadline = Date.now() + Math.max(options.options.waitMs, options.options.intervalMs);
  let lastEvidence = "missing=chat.message.accepted";
  do {
    try {
      const status = await fetchAdminStatus(options.options, options.fetch);
      const logs = asArray(asRecord(asRecord(status).state).recentBrokerLogs);
      const accepted = matchingLogs(logs, "chat.message.accepted", {
        platform: "slack",
      }).filter((log) => {
        const meta = logMeta(log);
        return readString(meta.conversationId) === options.conversationId && readString(meta.rootMessageId) === options.rootMessageId;
      });
      if (accepted.length > 0) {
        return {
          id: "slack.drive.session_accepted",
          label: "Slack drive message was accepted by the broker before file upload",
          required: true,
          status: "pass",
          evidence: accepted.slice(-2).map(summarizeLog),
        };
      }
    } catch (error) {
      lastEvidence = formatFeishuSmokeCliError(error);
    }
    if (Date.now() >= deadline) {
      break;
    }
    await delay(options.options.intervalMs);
  } while (Date.now() < deadline);

  return {
    id: "slack.drive.session_accepted",
    label: "Slack drive message was accepted by the broker before file upload",
    required: true,
    status: "fail",
    evidence: [lastEvidence],
    nextAction: "Wait for the Slack app mention to appear in broker admin logs before posting the file artifact.",
  };
}

async function checkSlackCredentialAlignment(appToken: string, botToken: string, fetchFn: typeof fetch): Promise<SelfRegressionCheck & { readonly botUserId?: string | undefined }> {
  const appTokenAppId = parseSlackAppIdFromAppToken(appToken);
  const botIdentity = await fetchSlackBotIdentity(botToken, fetchFn);
  const passed = !appTokenAppId || !botIdentity.appId || appTokenAppId === botIdentity.appId;
  return {
    id: "slack.drive.credential_alignment",
    label: "Slack app-level token and bot token belong to the same Slack app",
    required: true,
    status: passed ? "pass" : "fail",
    evidence: [`bot_app_id=${botIdentity.appId ?? "unknown"}`, `app_token_app_id=${appTokenAppId ?? "unknown"}`, `bot_user_id=${botIdentity.userId}`],
    nextAction: passed ? undefined : "Replace SLACK_BOT_TOKEN and SLACK_APP_TOKEN with tokens from the same Slack app, then reinstall the app to the workspace.",
    botUserId: botIdentity.userId,
  };
}

async function resolveSlackChannelId(options: { readonly tokens: ReadonlyArray<{ readonly label: string; readonly token: string }>; readonly channel: string; readonly fetch: typeof fetch }): Promise<{ readonly id: string; readonly resolvedBy: string }> {
  const trimmed = options.channel.trim();
  if (!trimmed.startsWith("#")) {
    return { id: trimmed, resolvedBy: "direct" };
  }

  const targetName = trimmed.slice(1).toLowerCase();
  const errors: string[] = [];
  for (const credential of options.tokens) {
    let cursor: string | undefined;
    try {
      do {
        const params = new URLSearchParams({
          exclude_archived: "true",
          limit: "200",
          types: "public_channel,private_channel",
        });
        if (cursor) {
          params.set("cursor", cursor);
        }
        const response = await options.fetch(`https://slack.com/api/conversations.list?${params.toString()}`, {
          headers: {
            authorization: `Bearer ${credential.token}`,
          },
        });
        const payload = asRecord(await response.json());
        if (!response.ok || payload.ok !== true) {
          throw new Error(formatSlackApiFailure("conversations.list", response.status, payload));
        }
        const channel = asArray(payload.channels)
          .map(asRecord)
          .find((item) => readString(item.name)?.toLowerCase() === targetName || readString(item.name_normalized)?.toLowerCase() === targetName);
        const id = readString(channel?.id);
        if (id) {
          return { id, resolvedBy: credential.label };
        }
        cursor = readString(asRecord(payload.response_metadata).next_cursor);
      } while (cursor);
    } catch (error) {
      errors.push(`${credential.label}:${formatFeishuSmokeCliError(error)}`);
    }
  }

  const suffix = errors.length > 0 ? ` (${errors.join("; ")})` : "";
  throw new Error(`Slack channel label was not found: ${trimmed}${suffix}`);
}

async function fetchSlackBotIdentity(token: string, fetchFn: typeof fetch): Promise<{ readonly userId: string; readonly appId?: string | undefined }> {
  const payload = await fetchSlackAuthTest(token, fetchFn);
  const userId = readString(payload.user_id);
  if (!userId) {
    throw new Error("Slack auth.test did not return bot user id");
  }
  const botId = readString(payload.bot_id);
  let appId = readString(payload.app_id);
  if (!appId && botId) {
    appId = await fetchSlackBotAppId(token, botId, fetchFn);
  }
  return {
    userId,
    appId,
  };
}

async function fetchSlackAuthIdentity(token: string, fetchFn: typeof fetch): Promise<{ readonly userId?: string | undefined; readonly user?: string | undefined; readonly botId?: string | undefined }> {
  const payload = await fetchSlackAuthTest(token, fetchFn);
  return {
    userId: readString(payload.user_id),
    user: readString(payload.user),
    botId: readString(payload.bot_id),
  };
}

async function fetchSlackAuthTest(token: string, fetchFn: typeof fetch): Promise<Record<string, unknown>> {
  const response = await fetchFn("https://slack.com/api/auth.test", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-www-form-urlencoded",
    },
  });
  const payload = asRecord(await response.json());
  if (!response.ok || payload.ok !== true) {
    throw new Error(`Slack auth.test failed: ${readString(payload.error) ?? response.status}`);
  }
  return payload;
}

async function fetchSlackBotAppId(token: string, botId: string, fetchFn: typeof fetch): Promise<string | undefined> {
  const response = await fetchFn(`https://slack.com/api/bots.info?${new URLSearchParams({ bot: botId }).toString()}`, {
    headers: {
      authorization: `Bearer ${token}`,
    },
  });
  const payload = asRecord(await response.json());
  if (!response.ok || payload.ok !== true) {
    return undefined;
  }
  return readString(asRecord(payload.bot).app_id);
}

function parseSlackAppIdFromAppToken(token: string): string | undefined {
  const match = /^xapp-\d+-([A-Z0-9]+)-/u.exec(token);
  return match?.[1];
}

async function postSlackDriveMessage(options: { readonly token: string; readonly channel: string; readonly text: string; readonly fetch: typeof fetch }): Promise<{ readonly ts: string }> {
  const response = await options.fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: options.channel,
      text: options.text,
    }),
  });
  const payload = asRecord(await response.json());
  if (!response.ok || payload.ok !== true) {
    throw new Error(formatSlackApiFailure("chat.postMessage", response.status, payload));
  }
  const ts = readString(payload.ts);
  if (!ts) {
    throw new Error("Slack chat.postMessage did not return message timestamp");
  }
  return { ts };
}

async function postSlackDriveFile(options: { readonly baseUrl: string; readonly platform: "slack"; readonly conversationId: string; readonly rootMessageId: string; readonly fetch: typeof fetch }): Promise<string> {
  const response = await options.fetch(`${options.baseUrl.replace(/\/+$/u, "")}/chat/post-file`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      platform: options.platform,
      conversation_id: options.conversationId,
      root_message_id: options.rootMessageId,
      content_base64: Buffer.from("Slack self-regression artifact\n", "utf8").toString("base64"),
      filename: "self-regression.txt",
      title: "self-regression.txt",
      content_type: "text/plain",
      initial_comment: "self-regression artifact",
    }),
  });
  const payload = asRecord(await response.json().catch(() => null));
  if (!response.ok || payload.ok !== true) {
    throw new Error(`broker /chat/post-file failed: ${readString(payload.error) ?? response.status}`);
  }
  return "self-regression.txt";
}

function formatSlackApiFailure(method: string, status: number, payload: Record<string, unknown>): string {
  const parts = [`Slack ${method} failed: ${readString(payload.error) ?? status}`];
  const needed = readString(payload.needed);
  const provided = readString(payload.provided);
  if (needed) {
    parts.push(`needed=${needed}`);
  }
  if (provided) {
    parts.push(`provided=${provided}`);
  }
  return parts.join(" ");
}

async function fetchAdminStatusWithRetry(options: CliOptions, fetchFn: typeof fetch): Promise<unknown> {
  const deadline = Date.now() + options.waitMs;
  let lastError: unknown;

  do {
    try {
      return await fetchAdminStatus(options, fetchFn);
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) {
        break;
      }
      await delay(options.intervalMs);
    }
  } while (Date.now() < deadline);

  if (options.platform === "feishu") {
    return createUnavailableStatusEvidence(createFeishuSmokeUnavailableReport({ baseUrl: options.baseUrl, error: lastError }));
  }

  throw lastError instanceof Error ? lastError : new Error("admin status unavailable");
}

async function fetchAdminStatus(options: CliOptions, fetchFn: typeof fetch): Promise<unknown> {
  const init: RequestInit = options.adminToken
    ? {
        headers: {
          "x-admin-token": options.adminToken,
        },
      }
    : {};
  const response = await fetchFn(`${options.baseUrl.replace(/\/+$/u, "")}/admin/api/status?platform=${options.platform}`, init);
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new Error(`admin status failed (${response.status})`);
  }
  return payload;
}

function fromFeishuSmokeReport(report: FeishuSmokeReport, options: { readonly platform: SelfRegressionPlatform; readonly mode: SelfRegressionMode; readonly manifest: SelfRegressionManifest }): SelfRegressionReport {
  return createReport({
    platform: options.platform,
    mode: options.mode,
    manifest: options.manifest,
    checks: report.checks.map(fromFeishuSmokeCheck),
  });
}

function fromFeishuSmokeCheck(check: FeishuSmokeCheck): SelfRegressionCheck {
  return {
    id: check.id,
    label: check.label,
    required: check.required,
    status: check.status,
    evidence: check.evidence.map(sanitizeEvidenceText),
    nextAction: check.nextAction ? sanitizeEvidenceText(check.nextAction) : undefined,
  };
}

function createReport(options: { readonly platform: SelfRegressionPlatform; readonly mode: SelfRegressionMode; readonly manifest: SelfRegressionManifest; readonly checks: readonly SelfRegressionCheck[] }): SelfRegressionReport {
  const checks = options.checks.map(sanitizeCheck);
  const requiredFailures = checks.filter((check) => check.required && check.status !== "pass");
  return {
    ok: requiredFailures.length === 0,
    platform: options.platform,
    mode: options.mode,
    checkedAt: options.manifest.checkedAt,
    checks,
    manifest: options.manifest,
    nextActions: checks.filter((check) => check.status !== "pass" && check.nextAction).map((check) => `${check.id}: ${check.nextAction}`),
  };
}

function sanitizeCheck(check: SelfRegressionCheck): SelfRegressionCheck {
  return {
    ...check,
    evidence: check.evidence.map(sanitizeEvidenceText),
    nextAction: check.nextAction ? sanitizeEvidenceText(check.nextAction) : undefined,
  };
}

function booleanCheck(options: { readonly id: string; readonly label: string; readonly required: boolean; readonly passed: boolean; readonly evidence: readonly string[]; readonly nextAction?: string | undefined; readonly warning?: boolean | undefined }): SelfRegressionCheck {
  return {
    id: options.id,
    label: options.label,
    required: options.required,
    status: options.passed ? "pass" : options.warning ? "warn" : "fail",
    evidence: options.evidence,
    nextAction: options.passed ? undefined : options.nextAction,
  };
}

export async function writeSelfRegressionBundle(options: { readonly outputDir: string; readonly report: SelfRegressionReport }): Promise<{ readonly reportFile: string; readonly manifestFile: string; readonly summaryFile: string }> {
  await fs.mkdir(options.outputDir, { recursive: true });
  const report = sanitizeSelfRegressionReport(options.report);
  const reportFile = path.join(options.outputDir, "self-regression-report.json");
  const manifestFile = path.join(options.outputDir, "manifest.json");
  const summaryFile = path.join(options.outputDir, "self-regression-summary.md");

  await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(manifestFile, `${JSON.stringify(report.manifest, null, 2)}\n`);
  await fs.writeFile(summaryFile, renderSelfRegressionSummary(report));

  return { reportFile, manifestFile, summaryFile };
}

function sanitizeSelfRegressionReport(report: SelfRegressionReport): SelfRegressionReport {
  return {
    ...report,
    checks: report.checks.map(sanitizeCheck),
    manifest: {
      ...report.manifest,
      command: sanitizeEvidenceText(report.manifest.command),
      sanitizedSourceFiles: report.manifest.sanitizedSourceFiles.map(sanitizeEvidenceText),
    },
    nextActions: report.nextActions.map(sanitizeEvidenceText),
  };
}

function renderSelfRegressionSummary(report: SelfRegressionReport): string {
  const lines = [`# ${report.platform} self-regression`, "", `mode: ${report.mode}`, `checked_at: ${report.checkedAt}`, `status: ${report.ok ? "PASS" : "MISSING_EVIDENCE"}`, ""];
  for (const check of report.checks) {
    const prefix = check.status === "pass" ? "[PASS]" : check.status === "warn" ? "[WARN]" : "[FAIL]";
    lines.push(`- ${prefix} ${check.id}: ${check.label}`);
    for (const evidence of check.evidence.slice(0, 3)) {
      lines.push(`  - evidence: ${evidence}`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function createUnavailableStatusEvidence(report: FeishuSmokeReport): Record<string, unknown> {
  const firstCheck = report.checks[0];
  return {
    adminStatus: {
      available: false,
      checkedAt: report.checkedAt,
      checkId: firstCheck?.id,
      evidence: firstCheck?.evidence,
      nextAction: firstCheck?.nextAction,
    },
    platforms: {},
    state: {
      sessions: [],
      recentBrokerLogs: [],
    },
  };
}

function findSlackWorkStatusEvidence(logs: readonly unknown[]): string[] {
  const explicit = logs
    .filter((log) => {
      const message = readString(asRecord(log).message);
      const meta = logMeta(log);
      return (
        message === "slack.assistant.status.updated" ||
        message === "slack.assistant.status.cleared" ||
        message === "slack.assistant.fallback_reaction.updated" ||
        (message === "chat.outbound.posted" && readString(meta.platform) === "slack" && (readString(meta.format) === "status" || readString(meta.format) === "reaction"))
      );
    })
    .slice(-4)
    .map(summarizeLog);
  return explicit;
}

function findSlackFileEvidence(logs: readonly unknown[]): string[] {
  return logs
    .filter((log) => {
      const message = readString(asRecord(log).message);
      const meta = logMeta(log);
      return readString(meta.platform) === "slack" && (readString(meta.format) === "file" || readString(meta.format) === "image") && (message === "chat.outbound.posted" || message === "chat.outbound.failed");
    })
    .slice(-4)
    .map(summarizeLog);
}

function hasOverlappingSessionCoordinates(left: readonly unknown[], right: readonly unknown[]): boolean {
  const leftKeys = new Set(left.map(logCoordinateKey).filter((key): key is string => Boolean(key)));
  return right.some((log) => {
    const key = logCoordinateKey(log);
    return Boolean(key && leftKeys.has(key));
  });
}

function logCoordinateKey(log: unknown): string | undefined {
  const meta = logMeta(log);
  const conversationId = readString(meta.conversationId);
  const rootMessageId = readString(meta.rootMessageId);
  const sessionKey = readString(meta.sessionKey);
  if (conversationId && rootMessageId) {
    return `${conversationId}:${rootMessageId}`;
  }
  return sessionKey;
}

function matchingLogs(logs: readonly unknown[], message: string, meta: Record<string, string>): unknown[] {
  return logs.filter((log) => {
    const record = asRecord(log);
    const logMetaRecord = logMeta(log);
    return readString(record.message) === message && Object.entries(meta).every(([key, value]) => readString(logMetaRecord[key]) === value);
  });
}

function summarizeLog(log: unknown): string {
  const record = asRecord(log);
  const meta = logMeta(log);
  const parts = [
    readString(record.message) ?? "unknown",
    readString(meta.platform) ? `platform=${readString(meta.platform)}` : undefined,
    readString(meta.source) ? `source=${readString(meta.source)}` : undefined,
    readString(meta.sessionKey) ? `sessionKey=${readString(meta.sessionKey)}` : undefined,
    readString(meta.conversationId) ? `conversationId=${readString(meta.conversationId)}` : undefined,
    readString(meta.rootMessageId) ? `rootMessageId=${readString(meta.rootMessageId)}` : undefined,
    readString(meta.messageId) ? `messageId=${readString(meta.messageId)}` : undefined,
    readString(meta.format) ? `format=${readString(meta.format)}` : undefined,
    readString(meta.statusCode) ? `statusCode=${readString(meta.statusCode)}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return sanitizeEvidenceText(parts.join(" "));
}

function logMeta(log: unknown): Record<string, unknown> {
  const record = asRecord(log);
  return {
    ...record,
    ...asRecord(record.meta),
  };
}

function formatSlackChannelEvidence(channel: string | undefined): string {
  const trimmed = channel?.trim();
  if (!trimmed) {
    return "missing";
  }
  if (SAFE_CHANNEL_NAME.test(trimmed)) {
    return trimmed;
  }
  if (SAFE_CHANNEL_ID.test(trimmed)) {
    return "channel_id";
  }
  return "configured";
}

function isSafeSlackChannelInput(channel: string): boolean {
  const trimmed = channel.trim();
  return SAFE_CHANNEL_NAME.test(trimmed) || SAFE_CHANNEL_ID.test(trimmed);
}

function sanitizeCommand(parts: readonly string[]): string {
  const sanitized: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (part === "--manual-action" || part === "--admin-token") {
      sanitized.push(part);
      if (index + 1 < parts.length) {
        sanitized.push("[redacted]");
        index += 1;
      }
      continue;
    }
    if (part.startsWith("--manual-action=")) {
      sanitized.push("--manual-action=[redacted]");
      continue;
    }
    if (part.startsWith("--admin-token=")) {
      sanitized.push("--admin-token=[redacted]");
      continue;
    }
    sanitized.push(sanitizeEvidenceText(part));
  }
  return sanitized.join(" ");
}

function sanitizeSourceFile(filePath: string, cwd: string): string {
  const absolute = path.resolve(cwd, filePath);
  const relative = path.relative(cwd, absolute);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return sanitizeEvidenceText(relative);
  }
  return sanitizeEvidenceText(path.basename(filePath));
}

function sanitizeEvidenceText(value: string): string {
  return value
    .replace(/\b(?:xox[abprs]-|xapp-)[A-Za-z0-9_-]+/gu, "[redacted-token]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/giu, "Bearer [redacted-token]")
    .replace(/(["'])(\/[^"']+)\1/gu, (_match, quote: string, filePath: string) => `${quote}${path.basename(filePath)}${quote}`)
    .replace(/(^|[\s=])\/(?!\/)([^\s'"]+)/gu, (_match, prefix: string, filePathTail: string) => `${prefix}${path.basename(`/${filePathTail}`)}`);
}

function sanitizeManualAction(value: string): string {
  return sanitizeEvidenceText(value)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[redacted-email]")
    .replace(/https?:\/\/\S+/giu, "[redacted-url]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 180);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
}

function parseArgs(argv: readonly string[], env: Record<string, string | undefined>): CliOptions {
  let platform: SelfRegressionPlatform | undefined;
  let baseUrl = env.BROKER_API_BASE ?? env.BROKER_HTTP_BASE_URL ?? DEFAULT_BASE_URL;
  let adminToken = env.BROKER_ADMIN_TOKEN;
  let statusFile: string | undefined;
  let setupEvidenceFile = env.FEISHU_SETUP_EVIDENCE_FILE;
  let outputDir: string | undefined;
  let envFile: string | undefined;
  let channel = env.SLACK_SELF_REGRESSION_CHANNEL;
  let manualAction = env.FEISHU_SELF_REGRESSION_MANUAL_ACTION;
  let mode: SelfRegressionMode | undefined;
  let waitMs = 0;
  let intervalMs = 2_000;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = argv[index + 1];
    const option = splitCliOption(arg);
    const optionName = option?.name ?? arg;
    const readValue = (name: string): string => {
      if (option?.value !== undefined) {
        if (!option.value) {
          throw new Error(`Missing value for ${name}`);
        }
        return option.value;
      }
      if (!next || next === "--" || next.startsWith("--")) {
        throw new Error(`Missing value for ${name}`);
      }
      index += 1;
      return next;
    };

    if (arg === "--") {
      continue;
    } else if (optionName === "--platform") {
      platform = parsePlatform(readValue("--platform"));
    } else if (optionName === "--base-url") {
      baseUrl = readValue("--base-url");
    } else if (optionName === "--admin-token") {
      adminToken = readValue("--admin-token");
    } else if (optionName === "--status-file") {
      statusFile = readValue("--status-file");
    } else if (optionName === "--setup-evidence-file") {
      setupEvidenceFile = readValue("--setup-evidence-file");
    } else if (optionName === "--output-dir") {
      outputDir = readValue("--output-dir");
    } else if (optionName === "--env-file") {
      envFile = readValue("--env-file");
    } else if (optionName === "--channel") {
      channel = readValue("--channel");
    } else if (optionName === "--manual-action") {
      manualAction = readValue("--manual-action");
    } else if (optionName === "--wait-ms") {
      waitMs = readNonNegativeInteger(readValue("--wait-ms"), "--wait-ms");
    } else if (optionName === "--interval-ms") {
      intervalMs = readNonNegativeInteger(readValue("--interval-ms"), "--interval-ms");
    } else if (optionName === "--preflight") {
      rejectInlineCliValue(option, "--preflight");
      mode = setMode(mode, "preflight");
    } else if (optionName === "--observe") {
      rejectInlineCliValue(option, "--observe");
      mode = setMode(mode, "observe");
    } else if (optionName === "--replay") {
      rejectInlineCliValue(option, "--replay");
      mode = setMode(mode, "replay");
    } else if (optionName === "--drive") {
      rejectInlineCliValue(option, "--drive");
      mode = setMode(mode, "drive");
    } else if (optionName === "--json") {
      rejectInlineCliValue(option, "--json");
      json = true;
    } else if (optionName === "--help" || optionName === "-h") {
      rejectInlineCliValue(option, optionName);
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!platform) {
    throw new Error("Missing required --platform slack|feishu");
  }
  const resolvedMode = mode ?? (statusFile ? "replay" : "observe");
  if (resolvedMode === "replay" && !statusFile) {
    throw new Error("--replay requires --status-file");
  }

  return {
    platform,
    mode: resolvedMode,
    baseUrl,
    adminToken,
    statusFile,
    setupEvidenceFile,
    outputDir,
    envFile,
    channel,
    manualAction,
    waitMs,
    intervalMs,
    json,
  };
}

function parsePlatform(value: string): SelfRegressionPlatform {
  if (value === "slack" || value === "feishu") {
    return value;
  }
  throw new Error(`Invalid --platform: ${value}`);
}

function setMode(current: SelfRegressionMode | undefined, next: SelfRegressionMode): SelfRegressionMode {
  if (current && current !== next) {
    throw new Error(`Choose only one mode; saw both --${current} and --${next}`);
  }
  return next;
}

function splitCliOption(arg: string): { readonly name: string; readonly value?: string | undefined } | undefined {
  if (!arg.startsWith("--")) {
    return undefined;
  }
  const equalsIndex = arg.indexOf("=");
  if (equalsIndex < 0) {
    return { name: arg };
  }
  return {
    name: arg.slice(0, equalsIndex),
    value: arg.slice(equalsIndex + 1),
  };
}

function rejectInlineCliValue(option: { readonly value?: string | undefined } | undefined, name: string): void {
  if (option?.value !== undefined) {
    throw new Error(`Unexpected value for ${name}`);
  }
}

function readNonNegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function printUsage(): void {
  console.log(
    [
      "usage: pnpm manual:self-regression -- --platform slack --preflight --channel '#xp-test' [--env-file .env] [--output-dir evidence/self-regression/slack] [--json]",
      "       pnpm manual:self-regression -- --platform slack --drive --channel '#xp-test' [--base-url http://127.0.0.1:3000] [--wait-ms 60000] [--output-dir evidence/self-regression/slack] [--json]",
      "       pnpm manual:self-regression -- --platform slack --replay --status-file admin-status.json [--output-dir evidence/self-regression/slack] [--json]",
      "       pnpm manual:self-regression -- --platform feishu --preflight [--env-file .env] [--output-dir evidence/self-regression/feishu] [--json]",
      "       pnpm manual:self-regression -- --platform feishu --observe --manual-action 'operator sent @bot + non-@ follow-up in test group' --setup-evidence-file setup.json [--base-url http://127.0.0.1:3000] [--output-dir evidence/self-regression/feishu] [--json]",
      "       pnpm manual:self-regression -- --platform feishu --replay --status-file admin-status.json --setup-evidence-file setup.json [--output-dir evidence/self-regression/feishu] [--json]",
      "",
      "Writes sanitized self-regression reports and manifests. Secrets are loaded only from env or local env files and are never copied into output bundles.",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const initialOptions = parseArgs(argv, process.env);
  const env = await loadFeishuSmokeEnv(process.env, initialOptions.envFile);
  const options = initialOptions.envFile ? parseArgs(argv, env) : initialOptions;
  const report = await collectSelfRegressionReport(options, {
    argv,
    env,
  });

  if (options.outputDir) {
    const bundle = await writeSelfRegressionBundle({
      outputDir: options.outputDir,
      report,
    });
    if (!options.json) {
      console.log(`wrote self-regression bundle: ${path.basename(bundle.summaryFile)}`);
    }
  }

  if (options.json) {
    console.log(JSON.stringify(sanitizeSelfRegressionReport(report), null, 2));
  } else {
    console.log(renderSelfRegressionSummary(sanitizeSelfRegressionReport(report)));
  }

  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(formatFeishuSmokeCliError(error));
    process.exitCode = 1;
  });
}
