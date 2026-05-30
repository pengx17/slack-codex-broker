#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { collectRfc0001LocalAudit } from "./run-rfc-0001-local-audit.js";
import { formatFeishuSmokeCliError } from "./run-real-feishu-smoke.js";

type TestPlanStatus = "pass" | "missing";

export interface Rfc0001TestPlanCheck {
  readonly id: string;
  readonly label: string;
  readonly status: TestPlanStatus;
  readonly evidence: readonly string[];
  readonly nextAction?: string | undefined;
}

export interface Rfc0001TestPlanReport {
  readonly ok: boolean;
  readonly checkedAt: string;
  readonly checks: readonly Rfc0001TestPlanCheck[];
  readonly nextActions: readonly string[];
}

interface TestPlanOptions {
  readonly cwd?: string | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
  readonly evidenceDir?: string | undefined;
}

interface CliOptions {
  json: boolean;
  help: boolean;
  cwd?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
  evidenceDir?: string | undefined;
}

interface CapabilityRow {
  readonly capability: string;
  readonly slackBaseline: string;
  readonly feishuTarget: string;
  readonly parityLevel: string;
  readonly automatedProof: string;
}

interface SmokeReport {
  readonly ok?: boolean | undefined;
  readonly checks?: readonly {
    readonly id?: string | undefined;
    readonly status?: string | undefined;
    readonly required?: boolean | undefined;
  }[];
}

const TEST_PLAN_PATH = path.join("docs", "rfcs", "0001-slack-feishu-dual-platform", "test-plan.md");

const EXPECTED_ACCEPTANCE_COMMANDS = [
  "pnpm format:check",
  "pnpm lint",
  "pnpm build",
  "pnpm test",
  "pnpm test:e2e:feishu-mock",
  "pnpm rfc:feishu-audit -- --json",
  "pnpm rfc:feishu-test-plan -- --json",
  "pnpm rfc:feishu-completion-audit -- --json",
  "pnpm manual:codex-coding-smoke -- --json",
  "pnpm manual:feishu-smoke -- --status-file evidence/feishu-smoke/admin-status.json --setup-evidence-file evidence/feishu-smoke/feishu-setup-evidence.json --output-dir evidence/feishu-smoke --json",
];

const EXPECTED_LAYER2_COMMANDS = EXPECTED_ACCEPTANCE_COMMANDS.filter((command) => !command.startsWith("pnpm manual:") && !command.startsWith("pnpm rfc:feishu-completion-audit"));

const EXPECTED_CAPABILITIES = [
  "Runtime readiness",
  "Session start/resume",
  "Active follow-up",
  "Degraded follow-up",
  "Private/direct chat",
  "Bot/self filtering",
  "Stop command",
  "Real Codex coding task",
  "Work status / typing",
  "Read/unread visibility",
  "Markdown/text reply",
  "Rich/card inbound",
  "Rich/card outbound",
  "File/image inbound",
  "File/image outbound",
  "Bounded history recovery",
  "Background jobs",
  "Co-author / GitHub mapping",
  "Admin dashboard",
  "Observability / redaction",
];

const ALLOWED_PARITY_LEVELS = new Set(["Parity", "Parity when approved", "Intentional difference", "Product difference", "Platform-adapted parity", "Parity plus Feishu gates"]);

const SMOKE_REQUIREMENTS_BY_CAPABILITY: ReadonlyMap<string, readonly string[]> = new Map([
  ["Runtime readiness", ["runtime.feishu_ready", "runtime.slack_ready", "slack.socket_mode_ready", "feishu.long_connection_ready"]],
  ["Active follow-up", ["feishu.all_message_verified", "feishu.non_at_followup"]],
  ["Degraded follow-up", ["observability.behavior_coverage"]],
  ["Private/direct chat", ["feishu.private_ignored"]],
  ["Bot/self filtering", ["feishu.self_sender_ignored"]],
  ["Stop command", ["feishu.stop"]],
  ["Rich/card outbound", ["feishu.outbound_rich_card_file", "feishu.card_callback", "feishu.coauthor_card"]],
  ["File/image outbound", ["feishu.outbound_rich_card_file"]],
  ["Observability / redaction", ["observability.required_log_fields", "observability.no_info_warn_body_leaks"]],
]);

export async function collectRfc0001TestPlanVerification(options: TestPlanOptions = {}): Promise<Rfc0001TestPlanReport> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const evidenceDir = options.evidenceDir ?? path.join(cwd, "evidence", "feishu-smoke");
  const checks: Rfc0001TestPlanCheck[] = [];
  const testPlanPath = path.join(cwd, TEST_PLAN_PATH);
  const packageScripts = await readPackageScripts(cwd);
  const content = await readOptionalText(testPlanPath);
  const smokeReport = await readSmokeReport(path.join(evidenceDir, "feishu-smoke-report.json"));

  checks.push({
    id: "testplan.document",
    label: "RFC 0001 test plan document exists",
    status: content === null ? "missing" : "pass",
    evidence: content === null ? [`missing=${TEST_PLAN_PATH}`] : [`present=${TEST_PLAN_PATH}`],
    nextAction: content === null ? "Restore the progressive Slack / Feishu parity test plan before claiming RFC 0001 verification coverage." : undefined,
  });

  if (content !== null) {
    checks.push(defaultCommandCheck(content, packageScripts));
    checks.push(layer2CommandCheck(content, packageScripts));
    checks.push(await capabilityMatrixCheck(cwd, content, smokeReport));
    checks.push(dashboardAcceptanceCheck(content));
  }

  checks.push(savedSmokeReportCheck(smokeReport));
  checks.push(await auditCheck(cwd, env, evidenceDir));

  return buildReport(checks);
}

export function parseRfc0001TestPlanArgs(argv: readonly string[]): CliOptions {
  const args = [...argv];
  const options: CliOptions = {
    json: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }
    if (arg === "--") {
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--evidence-dir") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Missing value for --evidence-dir");
      }
      options.evidenceDir = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--evidence-dir=")) {
      options.evidenceDir = arg.slice("--evidence-dir=".length);
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function defaultCommandCheck(content: string, packageScripts: Readonly<Record<string, string>>): Rfc0001TestPlanCheck {
  const commands = parseAcceptanceCommands(content);
  const missing = EXPECTED_ACCEPTANCE_COMMANDS.filter((command) => !commands.includes(command));
  const unwired = EXPECTED_ACCEPTANCE_COMMANDS.filter((command) => !isCommandWired(command, packageScripts));
  const ok = missing.length === 0 && unwired.length === 0;
  return {
    id: "testplan.default_commands",
    label: "Default acceptance command set is complete and wired",
    status: ok ? "pass" : "missing",
    evidence: ok ? EXPECTED_ACCEPTANCE_COMMANDS.map((command) => `command=${command}`) : [...missing.map((command) => `missing=${command}`), ...unwired.map((command) => `unwired=${command}`)],
    nextAction: ok ? undefined : "Update the test plan default command set and package scripts so the documented acceptance gate can be run by automation.",
  };
}

function layer2CommandCheck(content: string, packageScripts: Readonly<Record<string, string>>): Rfc0001TestPlanCheck {
  const commands = parseLayerCommands(content, "Layer 2: Fast Local Automation");
  const missing = EXPECTED_LAYER2_COMMANDS.filter((command) => !commands.includes(command));
  const unwired = EXPECTED_LAYER2_COMMANDS.filter((command) => !isCommandWired(command, packageScripts));
  const ok = missing.length === 0 && unwired.length === 0;
  return {
    id: "testplan.layer2_commands",
    label: "Layer 2 fast local automation commands are complete and wired",
    status: ok ? "pass" : "missing",
    evidence: ok ? EXPECTED_LAYER2_COMMANDS.map((command) => `command=${command}`) : [...missing.map((command) => `missing=${command}`), ...unwired.map((command) => `unwired=${command}`)],
    nextAction: ok ? undefined : "Restore every Layer 2 command so local automation covers format, lint, build, full test, Feishu mock, RFC audit, and test-plan drift checks.",
  };
}

async function capabilityMatrixCheck(cwd: string, content: string, smokeReport: SmokeReport | null): Promise<Rfc0001TestPlanCheck> {
  const rows = parseCapabilityRows(content);
  const rowByCapability = new Map(rows.map((row) => [row.capability, row]));
  const evidence: string[] = [];
  const missing: string[] = [];
  const smokeStatus = smokeCheckStatusMap(smokeReport);

  for (const capability of EXPECTED_CAPABILITIES) {
    const row = rowByCapability.get(capability);
    if (!row) {
      missing.push(`missing_capability=${capability}`);
      continue;
    }
    evidence.push(`capability=${capability}`);
    if (!row.slackBaseline || !row.feishuTarget || !row.automatedProof) {
      missing.push(`incomplete_row=${capability}`);
    }
    if (!ALLOWED_PARITY_LEVELS.has(row.parityLevel)) {
      missing.push(`invalid_parity=${capability}:${row.parityLevel}`);
    }

    const proofResults = await verifyAutomatedProofs(cwd, row.automatedProof);
    for (const result of proofResults) {
      if (result.ok) {
        evidence.push(`${capability}:proof=${result.label}`);
      } else {
        missing.push(`${capability}:missing_proof=${result.label}`);
      }
    }

    for (const smokeCheckId of SMOKE_REQUIREMENTS_BY_CAPABILITY.get(capability) ?? []) {
      if (smokeStatus.get(smokeCheckId) === "pass") {
        evidence.push(`${capability}:smoke=${smokeCheckId}`);
      } else {
        missing.push(`${capability}:missing_smoke=${smokeCheckId}`);
      }
    }
  }

  const extras = rows.map((row) => row.capability).filter((capability) => !EXPECTED_CAPABILITIES.includes(capability));
  for (const extra of extras) {
    missing.push(`unexpected_capability=${extra}`);
  }

  return {
    id: "testplan.capability_matrix",
    label: "Slack baseline and Feishu parity capability matrix has automated proof",
    status: missing.length === 0 ? "pass" : "missing",
    evidence: missing.length === 0 ? evidence : missing,
    nextAction: missing.length === 0 ? undefined : "Update the product capability matrix so every Slack baseline / Feishu target row has valid parity status, proof files or scripts, and required saved-smoke evidence.",
  };
}

function dashboardAcceptanceCheck(content: string): Rfc0001TestPlanCheck {
  const expected = [
    "Slack session rows show human channel labels",
    "Feishu session rows show a `飞书` platform pill",
    "Feishu session details do not show the Slack permalink action",
    "Mixed Slack + Feishu sessions keep queue state",
    "Dashboard rows/details expose work status or typing-equivalent state",
    "Dashboard rows/details expose read/unread or broker open-inbound state",
    "Admin platform health shows Slack Socket Mode and Feishu long connection",
  ];
  const missing = expected.filter((snippet) => !content.includes(snippet));
  return {
    id: "testplan.dashboard_acceptance",
    label: "Dashboard acceptance criteria cover Slack and Feishu differences",
    status: missing.length === 0 ? "pass" : "missing",
    evidence: missing.length === 0 ? expected.map((snippet) => `present=${snippet}`) : missing.map((snippet) => `missing=${snippet}`),
    nextAction: missing.length === 0 ? undefined : "Restore Layer 4 dashboard acceptance criteria for Slack labels, Feishu platform cues, permalink behavior, mixed-session state, and platform health.",
  };
}

function savedSmokeReportCheck(report: SmokeReport | null): Rfc0001TestPlanCheck {
  if (!report) {
    return {
      id: "testplan.saved_smoke_report",
      label: "Saved Feishu smoke report proves real-tenant gates",
      status: "missing",
      evidence: ["missing=feishu-smoke-report.json"],
      nextAction: "Run manual Feishu smoke with --output-dir evidence/feishu-smoke or restore the saved smoke report bundle.",
    };
  }
  const requiredFailures = (report.checks ?? []).filter((check) => check.required && check.status !== "pass");
  const ok = report.ok === true && requiredFailures.length === 0;
  return {
    id: "testplan.saved_smoke_report",
    label: "Saved Feishu smoke report proves real-tenant gates",
    status: ok ? "pass" : "missing",
    evidence: ok ? [`ok=${String(report.ok)}`, `required_checks=${report.checks?.filter((check) => check.required).length ?? 0}`] : [`ok=${String(report.ok)}`, ...requiredFailures.map((check) => `${check.id ?? "unknown"}=${check.status ?? "missing"}`)],
    nextAction: ok ? undefined : "Refresh evidence/feishu-smoke with a passing manual Feishu smoke report before claiming Layer 3 coverage.",
  };
}

async function auditCheck(cwd: string, env: Record<string, string | undefined>, evidenceDir: string): Promise<Rfc0001TestPlanCheck> {
  try {
    const report = await collectRfc0001LocalAudit({ cwd, env, evidenceDir });
    return {
      id: "testplan.rfc_audit",
      label: "RFC audit passes under the test-plan evidence bundle",
      status: report.ok ? "pass" : "missing",
      evidence: [`ok=${String(report.ok)}`, `localOk=${String(report.localOk)}`, `realTenantOk=${String(report.realTenantOk)}`],
      nextAction: report.ok ? undefined : (report.nextActions[0] ?? "Fix RFC audit failures before claiming test-plan automation is complete."),
    };
  } catch (error) {
    return {
      id: "testplan.rfc_audit",
      label: "RFC audit passes under the test-plan evidence bundle",
      status: "missing",
      evidence: [formatFeishuSmokeCliError(error)],
      nextAction: "Fix the RFC audit failure and rerun the test-plan verifier.",
    };
  }
}

function buildReport(checks: readonly Rfc0001TestPlanCheck[]): Rfc0001TestPlanReport {
  return {
    ok: checks.every((check) => check.status === "pass"),
    checkedAt: new Date().toISOString(),
    checks,
    nextActions: checks.filter((check) => check.status !== "pass" && check.nextAction).map((check) => `${check.id}: ${check.nextAction}`),
  };
}

function parseAcceptanceCommands(content: string): string[] {
  const markerIndex = content.indexOf("The default acceptance command set is:");
  if (markerIndex < 0) return [];
  const fenceStart = content.indexOf("```sh", markerIndex);
  if (fenceStart < 0) return [];
  const commandStart = content.indexOf("\n", fenceStart);
  const fenceEnd = content.indexOf("```", commandStart);
  if (commandStart < 0 || fenceEnd < 0) return [];
  return content
    .slice(commandStart + 1, fenceEnd)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line);
}

function parseLayerCommands(content: string, layerTitle: string): string[] {
  const layerStart = content.indexOf(`<summary>${layerTitle}</summary>`);
  if (layerStart < 0) return [];
  const layerEnd = content.indexOf("</details>", layerStart);
  const layerContent = content.slice(layerStart, layerEnd < 0 ? undefined : layerEnd);
  return [...layerContent.matchAll(/- \[ \] Run `([^`]+)`/gu)].flatMap((match) => (match[1] ? [match[1]] : []));
}

function parseCapabilityRows(content: string): CapabilityRow[] {
  const layerStart = content.indexOf("<summary>Layer 1: Product Capability Matrix</summary>");
  if (layerStart < 0) return [];
  const tableStart = content.indexOf("| Capability", layerStart);
  if (tableStart < 0) return [];
  const tableEnd = content.indexOf("</details>", tableStart);
  const rows: CapabilityRow[] = [];
  for (const line of content.slice(tableStart, tableEnd < 0 ? undefined : tableEnd).split(/\r?\n/u)) {
    if (!line.startsWith("|") || line.includes("---") || line.includes("Capability")) {
      continue;
    }
    const cells = line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
    if (cells.length !== 5) {
      continue;
    }
    const [capability, slackBaseline, feishuTarget, parityLevel, automatedProof] = cells;
    if (capability === undefined || slackBaseline === undefined || feishuTarget === undefined || parityLevel === undefined || automatedProof === undefined) {
      continue;
    }
    rows.push({
      capability: stripMarkdown(capability),
      slackBaseline: stripMarkdown(slackBaseline),
      feishuTarget: stripMarkdown(feishuTarget),
      parityLevel: stripMarkdown(parityLevel),
      automatedProof,
    });
  }
  return rows;
}

async function verifyAutomatedProofs(cwd: string, proof: string): Promise<Array<{ readonly label: string; readonly ok: boolean }>> {
  const codeSpans = [...proof.matchAll(/`([^`]+)`/gu)].flatMap((match) => (match[1] ? [match[1]] : []));
  const results: Array<{ readonly label: string; readonly ok: boolean }> = [];
  for (const codeSpan of codeSpans) {
    if (codeSpan.startsWith("pnpm ")) {
      results.push({
        label: codeSpan,
        ok: await isCommandAvailable(cwd, codeSpan),
      });
      continue;
    }
    if (looksLikePathProof(codeSpan)) {
      results.push({
        label: codeSpan,
        ok: await pathProofExists(cwd, codeSpan),
      });
    }
  }
  if (results.length === 0 && /real smoke|evidence/iu.test(proof)) {
    results.push({ label: "real-smoke-evidence", ok: true });
  }
  return results;
}

function smokeCheckStatusMap(report: SmokeReport | null): ReadonlyMap<string, string> {
  const statuses = new Map<string, string>();
  for (const check of report?.checks ?? []) {
    if (check.id) {
      statuses.set(check.id, check.status ?? "missing");
    }
  }
  return statuses;
}

async function isCommandAvailable(cwd: string, command: string): Promise<boolean> {
  const scripts = await readPackageScripts(cwd);
  if (!command.startsWith("pnpm ")) return false;
  const scriptName = command.slice("pnpm ".length).split(/\s+/u)[0] ?? "";
  return Boolean(scripts[scriptName]);
}

function isCommandWired(command: string, packageScripts: Readonly<Record<string, string>>): boolean {
  if (!command.startsWith("pnpm ")) return true;
  const scriptName = command.slice("pnpm ".length).split(/\s+/u)[0] ?? "";
  return Boolean(packageScripts[scriptName]);
}

function looksLikePathProof(value: string): boolean {
  return /^(test|src|scripts|docs|evidence|\.github)\//u.test(value) || value.endsWith(".ts") || value.endsWith(".md") || value.endsWith(".json");
}

async function pathProofExists(cwd: string, proofPath: string): Promise<boolean> {
  if (!proofPath.includes("*")) {
    return pathExists(path.join(cwd, proofPath));
  }
  const slashIndex = proofPath.lastIndexOf("/");
  const directory = slashIndex >= 0 ? proofPath.slice(0, slashIndex) : ".";
  const pattern = slashIndex >= 0 ? proofPath.slice(slashIndex + 1) : proofPath;
  try {
    const entries = await fs.readdir(path.join(cwd, directory));
    const regex = new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*") + "$", "u");
    return entries.some((entry) => regex.test(entry));
  } catch {
    return false;
  }
}

async function readPackageScripts(cwd: string): Promise<Record<string, string>> {
  try {
    const content = await fs.readFile(path.join(cwd, "package.json"), "utf8");
    const parsed = JSON.parse(content) as { readonly scripts?: Record<string, string> | undefined };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}

async function readSmokeReport(filePath: string): Promise<SmokeReport | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as SmokeReport;
  } catch {
    return null;
  }
}

async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function stripMarkdown(value: string): string {
  return value.replace(/`([^`]+)`/gu, "$1").trim();
}

function renderHumanReport(report: Rfc0001TestPlanReport): string {
  const lines = [`RFC 0001 test plan verification: ${report.ok ? "ok" : "incomplete"}`, `checkedAt: ${report.checkedAt}`, ""];
  for (const check of report.checks) {
    lines.push(`- ${check.status.toUpperCase()} ${check.id}: ${check.label}`);
    for (const evidence of check.evidence.slice(0, 8)) {
      lines.push(`  - ${evidence}`);
    }
    if (check.evidence.length > 8) {
      lines.push(`  - ... ${check.evidence.length - 8} more`);
    }
    if (check.nextAction) {
      lines.push(`  next: ${check.nextAction}`);
    }
  }
  if (report.nextActions.length) {
    lines.push("", "Next actions:", ...report.nextActions.map((action) => `- ${action}`));
  }
  return lines.join("\n");
}

function printHelp(): void {
  console.log(`Usage: pnpm rfc:feishu-test-plan -- [--json] [--evidence-dir <dir>]\n\nVerifies the RFC 0001 Slack / Feishu parity test plan against documented commands, proof files, saved smoke evidence, and RFC audit state.`);
}

async function main(): Promise<void> {
  const options = parseRfc0001TestPlanArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const report = await collectRfc0001TestPlanVerification(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderHumanReport(report));
  }
  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().catch((error) => {
    console.error(formatFeishuSmokeCliError(error));
    process.exitCode = 1;
  });
}
