import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { collectRfc0001CompletionAudit } from "./manual/run-rfc-0001-completion-audit.js";

const verifierEnv = {
  SLACK_APP_TOKEN: "xapp-test",
  SLACK_BOT_TOKEN: "xoxb-test",
  FEISHU_ENABLED: "true",
  FEISHU_APP_ID: "cli_test",
  FEISHU_APP_SECRET: "test-secret",
  FEISHU_BOT_OPEN_ID: "ou_test",
  FEISHU_DOMAIN: "feishu",
  FEISHU_API_BASE_URL: "https://open.feishu.cn/open-apis",
  FEISHU_GROUP_MESSAGE_MODE: "all",
  FEISHU_STARTUP_REQUIRED: "true",
  LOG_RAW_FEISHU_EVENTS: "false",
} satisfies Record<string, string>;

describe("RFC 0001 completion audit", () => {
  it("fails closed until Slack drive and real Codex coding smoke bundles are present", async () => {
    const report = await collectRfc0001CompletionAudit({ env: verifierEnv });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "completion.rfc_audit_full", status: "pass" }),
        expect.objectContaining({ id: "completion.test_plan_verified", status: "pass" }),
        expect.objectContaining({
          id: "completion.slack_self_regression_drive",
          status: "missing",
          evidence: expect.arrayContaining(["missing=evidence/self-regression/slack/self-regression-report.json"]),
        }),
        expect.objectContaining({
          id: "completion.feishu_self_regression_observe",
          status: "pass",
          evidence: expect.arrayContaining(["present=evidence/self-regression/feishu/self-regression-report.json", "platform=feishu", "mode=observe", "feishu.observe.manual_action_provenance=pass"]),
        }),
        expect.objectContaining({
          id: "completion.codex_coding_smoke",
          status: "missing",
          evidence: expect.arrayContaining(["missing=evidence/codex-coding-smoke/codex-coding-smoke-report.json"]),
        }),
      ]),
    );
  });

  it("passes for sanitized self-regression and coding smoke evidence bundles", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rfc-completion-audit-"));
    await writeJson(
      path.join(root, "evidence", "self-regression", "slack", "self-regression-report.json"),
      selfRegressionReport("slack", "drive", undefined, ["slack.drive.message_posted", "slack.drive.file_posted", "runtime.slack_ready", "slack.socket_mode_ready", "slack.message_roundtrip", "slack.work_status_visible", "slack.file_artifact_path"]),
    );
    await writeJson(
      path.join(root, "evidence", "self-regression", "feishu", "self-regression-report.json"),
      selfRegressionReport("feishu", "observe", "operator sent @bot plus non-at follow-up in test group", [
        "feishu.observe.manual_action_provenance",
        "runtime.feishu_ready",
        "feishu.long_connection_ready",
        "feishu.all_message_verified",
        "feishu.non_at_followup",
        "feishu.outbound_rich_card_file",
        "feishu.card_callback",
        "feishu.coauthor_card",
      ]),
    );
    await writeJson(path.join(root, "evidence", "codex-coding-smoke", "codex-coding-smoke-report.json"), {
      ok: true,
      workspacePath: "codex-coding-smoke-test/workspace",
      workspaceRetained: false,
      expectedContent: "REAL_CODEX_CODING_SMOKE_OK",
      actualContent: "REAL_CODEX_CODING_SMOKE_OK\n",
      finalMessage: "CODING_SMOKE_DONE",
      checkStdout: "coding smoke passed",
    });

    const report = await collectRfc0001CompletionAudit({
      cwd: root,
      includeBaseAudits: false,
    });

    expect(report.ok).toBe(true);
    expect(report.nextActions).toEqual([]);
    expect(report.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "completion.slack_self_regression_drive", status: "pass" }), expect.objectContaining({ id: "completion.feishu_self_regression_observe", status: "pass" }), expect.objectContaining({ id: "completion.codex_coding_smoke", status: "pass" })]),
    );
  });
});

function selfRegressionReport(platform: "slack" | "feishu", mode: "drive" | "observe", manualAction: string | undefined, checkIds: readonly string[]): unknown {
  return {
    ok: true,
    platform,
    mode,
    checkedAt: "2026-05-30T00:00:00.000Z",
    manifest: {
      platform,
      mode,
      checkedAt: "2026-05-30T00:00:00.000Z",
      command: `pnpm manual:self-regression -- --platform ${platform} --${mode}`,
      sanitizedSourceFiles: [],
      manualAction,
    },
    checks: checkIds.map((id) => ({
      id,
      label: id,
      required: true,
      status: "pass",
      evidence: [`${id}=pass`],
    })),
    nextActions: [],
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
