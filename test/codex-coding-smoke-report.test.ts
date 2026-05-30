import { describe, expect, it } from "vitest";

import { formatCodingSmokeWorkspacePath, sanitizeCodingSmokeReportText } from "./manual/run-real-codex-coding-smoke.js";

describe("real Codex coding smoke report", () => {
  it("keeps report paths attachable without host filesystem prefixes", () => {
    expect(formatCodingSmokeWorkspacePath("/var/folders/nt/example/T/codex-coding-smoke-abc123/workspace")).toBe("codex-coding-smoke-abc123/workspace");
    expect(sanitizeCodingSmokeReportText('check failed in "/var/folders/nt/example/T/codex-coding-smoke-abc123/workspace/target.txt"')).toBe('check failed in "target.txt"');
    expect(sanitizeCodingSmokeReportText("cwd=/var/folders/nt/example/T/codex-coding-smoke-abc123/workspace")).toBe("cwd=workspace");
  });
});
