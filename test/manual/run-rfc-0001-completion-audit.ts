#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { collectRfc0001LocalAudit } from "./run-rfc-0001-local-audit.js";
import { collectRfc0001TestPlanVerification } from "./run-rfc-0001-test-plan.js";
import { formatFeishuSmokeCliError } from "./run-real-feishu-smoke.js";

type CompletionStatus = "pass" | "missing";

export interface Rfc0001CompletionCheck {
  readonly id: string;
  readonly label: string;
  readonly status: CompletionStatus;
  readonly evidence: readonly string[];
  readonly nextAction?: string | undefined;
}

export interface Rfc0001CompletionAuditReport {
  readonly ok: boolean;
  readonly checkedAt: string;
  readonly checks: readonly Rfc0001CompletionCheck[];
  readonly nextActions: readonly string[];
}

interface CompletionAuditOptions {
  readonly cwd?: string | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
  readonly evidenceRoot?: string | undefined;
  readonly selfRegressionDir?: string | undefined;
  readonly feishuSmokeDir?: string | undefined;
  readonly codingSmokeReportFile?: string | undefined;
  readonly includeBaseAudits?: boolean | undefined;
}

interface CliOptions {
  readonly json: boolean;
  readonly help: boolean;
  readonly evidenceRoot?: string | undefined;
  readonly selfRegressionDir?: string | undefined;
  readonly feishuSmokeDir?: string | undefined;
  readonly codingSmokeReportFile?: string | undefined;
}

const REQUIRED_SLACK_DRIVE_CHECKS = ["slack.drive.message_posted", "slack.drive.file_posted", "runtime.slack_ready", "slack.socket_mode_ready", "slack.message_roundtrip", "slack.work_status_visible", "slack.file_artifact_path"];

const REQUIRED_FEISHU_SELF_REGRESSION_CHECKS = ["feishu.observe.manual_action_provenance", "runtime.feishu_ready", "feishu.long_connection_ready", "feishu.all_message_verified", "feishu.non_at_followup", "feishu.outbound_rich_card_file", "feishu.card_callback", "feishu.coauthor_card"];

export async function collectRfc0001CompletionAudit(options: CompletionAuditOptions = {}): Promise<Rfc0001CompletionAuditReport> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const evidenceRoot = options.evidenceRoot ?? path.join(cwd, "evidence");
  const selfRegressionDir = options.selfRegressionDir ?? path.join(evidenceRoot, "self-regression");
  const feishuSmokeDir = options.feishuSmokeDir ?? path.join(evidenceRoot, "feishu-smoke");
  const codingSmokeReportFile = options.codingSmokeReportFile ?? path.join(evidenceRoot, "codex-coding-smoke", "codex-coding-smoke-report.json");
  const checks: Rfc0001CompletionCheck[] = [];

  if (options.includeBaseAudits !== false) {
    checks.push(await rfcAuditCheck(cwd, env, feishuSmokeDir));
    checks.push(await testPlanCheck(cwd, env, feishuSmokeDir));
  }

  checks.push(
    await selfRegressionReportCheck({
      id: "completion.slack_self_regression_drive",
      label: "Slack self-regression auto-drive evidence proves controlled user inbound, reply, status, and file path",
      filePath: path.join(selfRegressionDir, "slack", "self-regression-report.json"),
      platform: "slack",
      requiredMode: "drive",
      requiredChecks: REQUIRED_SLACK_DRIVE_CHECKS,
      nextAction: "Run pnpm manual:self-regression -- --platform slack --drive --env-file .env --output-dir evidence/self-regression/slack --json after configuring a user-capable Slack token for the test channel.",
    }),
  );
  checks.push(
    await selfRegressionReportCheck({
      id: "completion.feishu_self_regression_observe",
      label: "Feishu self-regression evidence proves the controlled human/browser action and required real session behavior",
      filePath: path.join(selfRegressionDir, "feishu", "self-regression-report.json"),
      platform: "feishu",
      requiredMode: "observe",
      requiredChecks: REQUIRED_FEISHU_SELF_REGRESSION_CHECKS,
      nextAction: "Run pnpm manual:self-regression -- --platform feishu --observe --manual-action '<controlled group action>' --setup-evidence-file evidence/feishu-smoke/feishu-setup-evidence.json --output-dir evidence/self-regression/feishu --json after the live Feishu action.",
    }),
  );
  checks.push(await codingSmokeCheck(codingSmokeReportFile));

  return buildReport(checks);
}

function buildReport(checks: readonly Rfc0001CompletionCheck[]): Rfc0001CompletionAuditReport {
  return {
    ok: checks.every((check) => check.status === "pass"),
    checkedAt: new Date().toISOString(),
    checks,
    nextActions: checks.filter((check) => check.status !== "pass" && check.nextAction).map((check) => `${check.id}: ${check.nextAction}`),
  };
}

async function rfcAuditCheck(cwd: string, env: Record<string, string | undefined>, evidenceDir: string): Promise<Rfc0001CompletionCheck> {
  try {
    const report = await collectRfc0001LocalAudit({ cwd, env, evidenceDir });
    return {
      id: "completion.rfc_audit_full",
      label: "RFC 0001 full audit passes for local and saved real-tenant evidence",
      status: report.ok ? "pass" : "missing",
      evidence: [`ok=${String(report.ok)}`, `localOk=${String(report.localOk)}`, `realTenantOk=${String(report.realTenantOk)}`],
      nextAction: report.ok ? undefined : (report.nextActions[0] ?? "Fix RFC audit failures before claiming completion."),
    };
  } catch (error) {
    return {
      id: "completion.rfc_audit_full",
      label: "RFC 0001 full audit passes for local and saved real-tenant evidence",
      status: "missing",
      evidence: [formatFeishuSmokeCliError(error)],
      nextAction: "Fix the RFC audit error before claiming completion.",
    };
  }
}

async function testPlanCheck(cwd: string, env: Record<string, string | undefined>, evidenceDir: string): Promise<Rfc0001CompletionCheck> {
  try {
    const report = await collectRfc0001TestPlanVerification({ cwd, env, evidenceDir });
    return {
      id: "completion.test_plan_verified",
      label: "RFC 0001 progressive test-plan verifier passes",
      status: report.ok ? "pass" : "missing",
      evidence: [`ok=${String(report.ok)}`, `checks=${report.checks.length}`],
      nextAction: report.ok ? undefined : (report.nextActions[0] ?? "Fix test-plan verifier failures before claiming completion."),
    };
  } catch (error) {
    return {
      id: "completion.test_plan_verified",
      label: "RFC 0001 progressive test-plan verifier passes",
      status: "missing",
      evidence: [formatFeishuSmokeCliError(error)],
      nextAction: "Fix the test-plan verifier error before claiming completion.",
    };
  }
}

async function selfRegressionReportCheck(options: { readonly id: string; readonly label: string; readonly filePath: string; readonly platform: string; readonly requiredMode: string; readonly requiredChecks: readonly string[]; readonly nextAction: string }): Promise<Rfc0001CompletionCheck> {
  const report = await readJsonFile(options.filePath);
  if (!report) {
    return {
      id: options.id,
      label: options.label,
      status: "missing",
      evidence: [`missing=${safeEvidencePath(options.filePath)}`],
      nextAction: options.nextAction,
    };
  }

  const root = asRecord(report);
  const checks = asArray(root.checks).map(asRecord);
  const missing: string[] = [];
  if (root.ok !== true) missing.push(`ok=${String(root.ok)}`);
  if (root.platform !== options.platform) missing.push(`platform=${String(root.platform)}`);
  if (root.mode !== options.requiredMode) missing.push(`mode=${String(root.mode)}`);
  if (reportContainsUnsafeText(report)) missing.push("unsafe_text=present");

  for (const checkId of options.requiredChecks) {
    const check = checks.find((candidate) => candidate.id === checkId);
    if (!check) {
      missing.push(`missing_check=${checkId}`);
      continue;
    }
    if (check.required !== true) missing.push(`${checkId}.required=${String(check.required)}`);
    if (check.status !== "pass") missing.push(`${checkId}.status=${String(check.status)}`);
  }

  if (options.platform === "feishu" && !readString(asRecord(root.manifest).manualAction)) {
    missing.push("manifest.manualAction=missing");
  }

  return {
    id: options.id,
    label: options.label,
    status: missing.length === 0 ? "pass" : "missing",
    evidence: missing.length === 0 ? [`present=${safeEvidencePath(options.filePath)}`, `platform=${options.platform}`, `mode=${options.requiredMode}`, ...options.requiredChecks.map((checkId) => `${checkId}=pass`)] : missing,
    nextAction: missing.length === 0 ? undefined : options.nextAction,
  };
}

async function codingSmokeCheck(filePath: string): Promise<Rfc0001CompletionCheck> {
  const report = await readJsonFile(filePath);
  if (!report) {
    return {
      id: "completion.codex_coding_smoke",
      label: "Real Codex coding smoke edited a workspace and passed its check",
      status: "missing",
      evidence: [`missing=${safeEvidencePath(filePath)}`],
      nextAction: "Run pnpm manual:codex-coding-smoke -- --output-dir evidence/codex-coding-smoke --json with authenticated Codex app-server access.",
    };
  }

  const root = asRecord(report);
  const expected = readString(root.expectedContent);
  const actual = readString(root.actualContent);
  const missing: string[] = [];
  if (root.ok !== true) missing.push(`ok=${String(root.ok)}`);
  if (!expected) missing.push("expectedContent=missing");
  if (!actual || actual.trim() !== expected) missing.push("actualContent=mismatch");
  if (readString(root.checkStdout) !== "coding smoke passed") missing.push("checkStdout=missing");
  if (reportContainsUnsafeText(report)) missing.push("unsafe_text=present");

  return {
    id: "completion.codex_coding_smoke",
    label: "Real Codex coding smoke edited a workspace and passed its check",
    status: missing.length === 0 ? "pass" : "missing",
    evidence: missing.length === 0 ? [`present=${safeEvidencePath(filePath)}`, `expectedContent=${expected}`, "checkStdout=coding smoke passed"] : missing,
    nextAction: missing.length === 0 ? undefined : "Run pnpm manual:codex-coding-smoke -- --output-dir evidence/codex-coding-smoke --json with authenticated Codex app-server access.",
  };
}

async function readJsonFile(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function reportContainsUnsafeText(value: unknown): boolean {
  return /\b(?:xox[abprs]-|xapp-|Bearer\s+\S+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/iu.test(JSON.stringify(value));
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

function safeEvidencePath(filePath: string): string {
  const parts = filePath.split(/[\\/]+/u);
  const evidenceIndex = parts.lastIndexOf("evidence");
  return evidenceIndex >= 0 ? parts.slice(evidenceIndex).join("/") : path.basename(filePath);
}

function parseArgs(argv: readonly string[]): CliOptions {
  let json = false;
  let help = false;
  let evidenceRoot: string | undefined;
  let selfRegressionDir: string | undefined;
  let feishuSmokeDir: string | undefined;
  let codingSmokeReportFile: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg || arg === "--") continue;
    const option = splitCliOption(arg);
    const optionName = option?.name ?? arg;
    const readValue = (name: string): string => {
      if (option?.value !== undefined) {
        if (!option.value) throw new Error(`Missing value for ${name}`);
        return option.value;
      }
      const next = argv[index + 1];
      if (!next || next === "--" || next.startsWith("--")) throw new Error(`Missing value for ${name}`);
      index += 1;
      return next;
    };

    if (optionName === "--json") {
      rejectInlineCliValue(option, "--json");
      json = true;
    } else if (optionName === "--help" || optionName === "-h") {
      rejectInlineCliValue(option, optionName);
      help = true;
    } else if (optionName === "--evidence-root") {
      evidenceRoot = readValue("--evidence-root");
    } else if (optionName === "--self-regression-dir") {
      selfRegressionDir = readValue("--self-regression-dir");
    } else if (optionName === "--feishu-smoke-dir") {
      feishuSmokeDir = readValue("--feishu-smoke-dir");
    } else if (optionName === "--coding-smoke-report") {
      codingSmokeReportFile = readValue("--coding-smoke-report");
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return {
    json,
    help,
    evidenceRoot,
    selfRegressionDir,
    feishuSmokeDir,
    codingSmokeReportFile,
  };
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

function printUsage(): void {
  console.log(
    [
      "usage: pnpm rfc:feishu-completion-audit -- --json",
      "       pnpm rfc:feishu-completion-audit -- --evidence-root evidence --json",
      "",
      "This is a final-acceptance gate. It requires the RFC full audit, test-plan verifier, Slack self-regression drive bundle, Feishu self-regression observe bundle, and real Codex coding smoke bundle.",
    ].join("\n"),
  );
}

function printReport(report: Rfc0001CompletionAuditReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`RFC 0001 completion audit: ${report.ok ? "ok" : "missing evidence"}`);
  for (const check of report.checks) {
    console.log(`- [${check.status === "pass" ? "PASS" : "MISSING"}] ${check.id}: ${check.label}`);
    for (const evidence of check.evidence.slice(0, 4)) {
      console.log(`  - evidence: ${evidence}`);
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const report = await collectRfc0001CompletionAudit(options);
  printReport(report, options.json);
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
