import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionStore } from "../src/store.js";
import type { Question } from "../src/types.js";

function questions(prefix = "q"): Question[] {
  return [1, 2, 3].map((number) => ({
    id: `${prefix}${number}`,
    prompt: `问题 ${number}`,
    kind: "single" as const,
    required: true,
    options: [{ id: "yes", label: "是" }, { id: "no", label: "否" }],
    recommendedOptionIds: ["yes"],
    recommendationReason: "用于测试推荐高亮",
    allowOther: true,
  }));
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "gme-store-"));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "gme-workspace-"));
  const store = new SessionStore(root);
  const session = await store.startOrResume("构建一个可靠功能", workspace);
  return { root, workspace, store, session };
}

test("revision conflicts are rejected and answer retries are idempotent", async () => {
  const { store, session } = await fixture();
  const awaiting = await store.putQuestions(session.sessionId, 1, questions(), [], ["范围"]);
  await assert.rejects(
    store.submitAnswers(session.sessionId, 1, "submission-0001", [
      { questionId: "q1", selectedOptionIds: ["yes"] },
      { questionId: "q2", selectedOptionIds: ["yes"] },
      { questionId: "q3", selectedOptionIds: ["yes"] },
    ]),
    (error: unknown) => (error as { code?: string }).code === "REVISION_CONFLICT",
  );
  const answers = questions().map((question) => ({ questionId: question.id, selectedOptionIds: ["yes"] }));
  const submitted = await store.submitAnswers(session.sessionId, awaiting.revision, "submission-0001", answers);
  const replay = await store.submitAnswers(session.sessionId, awaiting.revision, "submission-0001", answers);
  assert.equal(submitted.revision, 3);
  assert.equal(replay.revision, 3);
  assert.equal(replay.answerRounds.length, 1);
});

test("invalid transitions and incomplete approval are rejected", async () => {
  const { store, session } = await fixture();
  await assert.rejects(
    store.putCandidate(session.sessionId, session.revision, "# 计划", [], []),
    (error: unknown) => (error as { code?: string }).code === "INVALID_STATE",
  );
  const awaiting = await store.putQuestions(session.sessionId, session.revision, questions(), [], []);
  const submitted = await store.submitAnswers(
    session.sessionId,
    awaiting.revision,
    "submission-0002",
    questions().map((question) => ({ questionId: question.id, selectedOptionIds: ["yes"] })),
  );
  const candidate = await store.putCandidate(session.sessionId, submitted.revision, "# 计划", ["决定 A"], ["未决 B"]);
  await assert.rejects(
    store.recordReview(session.sessionId, candidate.revision, "approve", []),
    (error: unknown) => (error as { code?: string }).code === "UNRESOLVED_DECISIONS",
  );
});

test("sessions recover after a server restart", async () => {
  const { root, workspace, store, session } = await fixture();
  const awaiting = await store.putQuestions(session.sessionId, session.revision, questions(), ["目标"], ["接口"]);
  const restarted = new SessionStore(root);
  const recovered = await restarted.startOrResume("ignored", workspace, session.sessionId);
  assert.equal(recovered.revision, awaiting.revision);
  assert.equal(recovered.status, "AWAITING_USER");
  assert.deepEqual(recovered.decisions, ["目标"]);
});

test("the twelfth-round gate requires an explicit user choice", async () => {
  const { store, session } = await fixture();
  let current = session;
  for (let round = 1; round <= 12; round += 1) {
    current = await store.putQuestions(current.sessionId, current.revision, questions(`r${round}-`), [], [`争议 ${round}`]);
    current = await store.submitAnswers(
      current.sessionId,
      current.revision,
      `submission-round-${round}`,
      questions(`r${round}-`).map((question) => ({ questionId: question.id, selectedOptionIds: ["yes"] })),
    );
    current = await store.putCandidate(current.sessionId, current.revision, "# 候选计划", [], [`争议 ${round}`]);
    current = await store.recordReview(current.sessionId, current.revision, "return", [{ area: "范围", problem: "仍有争议" }]);
  }
  await assert.rejects(
    store.putQuestions(current.sessionId, current.revision, questions("blocked-"), [], ["争议"]),
    (error: unknown) => (error as { code?: string }).code === "MAX_ROUNDS_REACHED",
  );
  const gateQuestion: Question = {
    id: "__round_limit_decision",
    prompt: "继续追问还是带风险结束？",
    kind: "single",
    required: true,
    options: [
      { id: "continue", label: "继续" },
      { id: "finish_with_known_risks", label: "带风险结束" },
    ],
    recommendedOptionIds: ["continue"],
    recommendationReason: "继续可消除高影响争议",
    allowOther: true,
  };
  current = await store.putQuestions(current.sessionId, current.revision, [gateQuestion], [], ["争议"], true);
  current = await store.submitAnswers(current.sessionId, current.revision, "round-limit-choice", [{
    questionId: gateQuestion.id,
    selectedOptionIds: ["continue"],
  }]);
  assert.equal(current.status, "NEEDS_MORE");
  assert.equal(current.maxRounds, 24);
  current = await store.putQuestions(current.sessionId, current.revision, questions("r13-"), [], []);
  assert.equal(current.round, 13);
});
