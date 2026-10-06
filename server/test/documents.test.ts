import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DocumentMaterializer } from "../src/documents.js";
import type { Session } from "../src/types.js";

async function approvedSession(): Promise<Session> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "gme-docs-"));
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    sessionId: "12345678-abcd-4321-abcd-123456789abc",
    goal: "交付一个可验证功能",
    workspaceRoot,
    status: "APPROVED",
    revision: 8,
    round: 2,
    createdAt: now,
    updatedAt: now,
    answerRounds: [],
    decisions: ["使用本地缓存"],
    remainingAreas: [],
    candidate: { markdown: "# 计划\n\n## 目标与成功标准\n\n可执行。", decisions: ["使用本地缓存"], unresolved: [], createdAt: now },
    reviews: [{ decision: "approve", reasons: [], createdAt: now }],
    idempotency: {},
    maxRounds: 12,
    riskAccepted: false,
    conflictsConfirmed: false,
  };
}

test("non-managed files require confirmation and are backed up", async () => {
  const session = await approvedSession();
  await writeFile(path.join(session.workspaceRoot, "计划.md"), "用户原计划\n", "utf8");
  await writeFile(path.join(session.workspaceRoot, "AGENTS.md"), "# Existing rules\n\nKeep this.\n", "utf8");
  const materializer = new DocumentMaterializer();
  const preview = await materializer.materialize(session, false);
  assert.equal(preview.written, false);
  assert.deepEqual(preview.conflicts.sort(), ["AGENTS.md", "计划.md"].sort());
  assert.equal(await readFile(path.join(session.workspaceRoot, "计划.md"), "utf8"), "用户原计划\n");

  const result = await materializer.materialize(session, true);
  assert.equal(result.written, true);
  assert.ok(result.backupDirectory);
  assert.equal(await readFile(path.join(result.backupDirectory!, "计划.md"), "utf8"), "用户原计划\n");
  const agents = await readFile(path.join(session.workspaceRoot, "AGENTS.md"), "utf8");
  assert.match(agents, /Keep this\./);
  assert.match(agents, /GRILL-ME-EXTENDED:START/);
  assert.match(await readFile(path.join(session.workspaceRoot, "进度.md"), "utf8"), /计划完成，尚未实施/);
});

test("same-session reruns update one managed block without conflict", async () => {
  const session = await approvedSession();
  const materializer = new DocumentMaterializer();
  await materializer.materialize(session, true);
  const preview = await materializer.preview(session);
  assert.equal(preview.requiresConfirmation, false);
  await materializer.materialize(session, true);
  const agents = await readFile(path.join(session.workspaceRoot, "AGENTS.md"), "utf8");
  assert.equal((agents.match(/GRILL-ME-EXTENDED:START/g) ?? []).length, 1);
  assert.match(agents, /每当完成步骤、修改文件、运行验证/);
});

test("relative workspaces are rejected", async () => {
  const session = await approvedSession();
  session.workspaceRoot = "relative/project";
  await assert.rejects(
    new DocumentMaterializer().preview(session),
    (error: unknown) => (error as { code?: string }).code === "INVALID_WORKSPACE",
  );
});
