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

  const setupEvidence = options.setupEvidenceFile ? await readJsonFile(options.setupEvidenceFile) : undefined;
  const status = options.statusFile ? await readJsonFile(options.statusFile) : await fetchAdminStatusWithRetry(options, fetchFn);
  const report = evaluateFeishuSmokeStatus(status, env, {
    requireSetupEvidence: true,
    setupEvidence,
  });
  return fromFeishuSmokeReport(report, {
    platform: "feishu",
    mode: options.statusFile ? "replay" : "observe",
    manifest,
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
      passed: !channel || SAFE_CHANNEL_NAME.test(channel.trim()),
      evidence: [`channel_label=${formatSlackChannelEvidence(channel)}`],
      nextAction: "Use a channel label such as #xp-test in evidence; do not paste private URLs, tokens, or message bodies.",
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
    const botUserId = await fetchSlackBotUserId(env.SLACK_BOT_TOKEN!, fetchFn);
    const channelId = await resolveSlackChannelId({
      token: env.SLACK_USER_TOKEN!,
      channel: channel!,
      fetch: fetchFn,
    });
    const message = await postSlackDriveMessage({
      token: env.SLACK_USER_TOKEN!,
      channel: channelId,
      text: `<@${botUserId}> self-regression ${Date.now()} reply with SELF_REGRESSION_OK`,
      fetch: fetchFn,
    });
    return [
      {
        id: "slack.drive.message_posted",
        label: "Slack drive posted a controlled user message",
        required: true,
        status: "pass",
        evidence: [`channel=${formatSlackChannelEvidence(channel)}`, `ts=${sanitizeEvidenceText(message.ts)}`],
      },
    ];
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

async function resolveSlackChannelId(options: { readonly token: string; readonly channel: string; readonly fetch: typeof fetch }): Promise<string> {
  const trimmed = options.channel.trim();
  if (!trimmed.startsWith("#")) {
    return trimmed;
  }

  const targetName = trimmed.slice(1).toLowerCase();
  let cursor: string | undefined;
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
        authorization: `Bearer ${options.token}`,
      },
    });
    const payload = asRecord(await response.json());
    if (!response.ok || payload.ok !== true) {
      throw new Error(`Slack conversations.list failed: ${readString(payload.error) ?? response.status}`);
    }
    const channel = asArray(payload.channels)
      .map(asRecord)
      .find((item) => readString(item.name)?.toLowerCase() === targetName || readString(item.name_normalized)?.toLowerCase() === targetName);
    const id = readString(channel?.id);
    if (id) {
      return id;
    }
    cursor = readString(asRecord(payload.response_metadata).next_cursor);
  } while (cursor);

  throw new Error(`Slack channel label was not found: ${trimmed}`);
}

async function fetchSlackBotUserId(token: string, fetchFn: typeof fetch): Promise<string> {
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
  const userId = readString(payload.user_id);
  if (!userId) {
    throw new Error("Slack auth.test did not return bot user id");
  }
  return userId;
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
    throw new Error(`Slack chat.postMessage failed: ${readString(payload.error) ?? response.status}`);
  }
  const ts = readString(payload.ts);
  if (!ts) {
    throw new Error("Slack chat.postMessage did not return message timestamp");
  }
  return { ts };
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
  return SAFE_CHANNEL_NAME.test(trimmed) ? trimmed : "configured";
}

function sanitizeCommand(parts: readonly string[]): string {
  return parts.map(sanitizeEvidenceText).join(" ");
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
      "       pnpm manual:self-regression -- --platform feishu --observe --setup-evidence-file setup.json [--base-url http://127.0.0.1:3000] [--output-dir evidence/self-regression/feishu] [--json]",
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
