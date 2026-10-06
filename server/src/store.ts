import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  Answer,
  CandidatePlan,
  CompactSession,
  Question,
  ReviewRecord,
  Session,
  SessionEvent,
  SessionStatus,
} from "./types.js";
import { GrillError } from "./types.js";

const INITIAL_MAX_ROUNDS = 12;

function defaultDataRoot(): string {
  if (process.env.GRILL_ME_EXTENDED_DATA_DIR) {
    return path.resolve(process.env.GRILL_ME_EXTENDED_DATA_DIR);
  }
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return path.join(local, "OpenAI", "Codex", "grill-me-extended", "sessions");
}

export function validateSessionId(sessionId: string): string {
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(sessionId)) {
    throw new GrillError("INVALID_SESSION_ID", "session_id 格式无效");
  }
  return sessionId;
}

function assertAbsoluteWorkspace(workspaceRoot: string): string {
  if (!path.isAbsolute(workspaceRoot)) {
    throw new GrillError("INVALID_WORKSPACE", "workspace 必须是绝对路径");
  }
  return path.resolve(workspaceRoot);
}

function assertRevision(session: Session, expected: number): void {
  if (session.revision !== expected) {
    throw new GrillError("REVISION_CONFLICT", `revision 冲突：期望 ${expected}，当前 ${session.revision}`, {
      expected,
      current: session.revision,
    });
  }
}

function assertStatus(session: Session, allowed: SessionStatus[], action: string): void {
  if (!allowed.includes(session.status)) {
    throw new GrillError("INVALID_STATE", `${action} 不能在 ${session.status} 状态执行`, {
      status: session.status,
      allowed,
    });
  }
}

function validateQuestions(questions: Question[], roundLimitGate: boolean): void {
  if (questions.length < (roundLimitGate ? 1 : 3) || questions.length > 7) {
    throw new GrillError("INVALID_QUESTION_BATCH", roundLimitGate ? "轮次上限确认必须包含一个问题" : "每轮必须包含 3–7 个问题");
  }
  const ids = new Set<string>();
  for (const question of questions) {
    if (!question.id || ids.has(question.id)) {
      throw new GrillError("INVALID_QUESTION", "问题 id 必须存在且在本轮唯一");
    }
    ids.add(question.id);
    if (!question.prompt.trim() || !question.recommendationReason.trim()) {
      throw new GrillError("INVALID_QUESTION", `问题 ${question.id} 缺少题干或推荐理由`);
    }
    if (question.kind !== "text" && (!question.options || question.options.length < 2)) {
      throw new GrillError("INVALID_QUESTION", `问题 ${question.id} 至少需要两个选项`);
    }
  }
}

function validateAnswers(session: Session, answers: Answer[]): void {
  const batch = session.currentBatch;
  if (!batch) throw new GrillError("NO_QUESTION_BATCH", "当前没有待回答的问题");
  const byId = new Map(answers.map((answer) => [answer.questionId, answer]));
  for (const question of batch.questions) {
    const answer = byId.get(question.id);
    if (!answer) {
      if (question.required) throw new GrillError("REQUIRED_ANSWER", `必答题未回答：${question.prompt}`);
      continue;
    }
    const selected = answer.selectedOptionIds ?? [];
    const hasText = Boolean(answer.text?.trim() || answer.otherText?.trim());
    if (question.required && selected.length === 0 && !hasText) {
      throw new GrillError("REQUIRED_ANSWER", `必答题未回答：${question.prompt}`);
    }
    if (question.kind === "single" && selected.length > 1) {
      throw new GrillError("INVALID_ANSWER", `单选题只能选择一项：${question.prompt}`);
    }
    const validOptions = new Set(question.options?.map((option) => option.id) ?? []);
    if (selected.some((id) => !validOptions.has(id))) {
      throw new GrillError("INVALID_ANSWER", `答案包含不存在的选项：${question.prompt}`);
    }
  }
}

export class SessionStore {
  readonly root: string;
  private locks = new Map<string, Promise<void>>();

  constructor(root = defaultDataRoot()) {
    this.root = path.resolve(root);
  }

  private sessionDirectory(sessionId: string): string {
    validateSessionId(sessionId);
    const resolved = path.resolve(this.root, sessionId);
    if (path.dirname(resolved) !== this.root) throw new GrillError("PATH_ESCAPE", "会话路径越界");
    return resolved;
  }

  private async withLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const next = previous.then(() => gate);
    this.locks.set(sessionId, next);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(sessionId) === next) this.locks.delete(sessionId);
    }
  }

  async startOrResume(goal: string, workspaceRoot: string | ((id: string) => string), requestedSessionId?: string): Promise<Session> {
    if (requestedSessionId) {
      const existing = await this.get(requestedSessionId);
      if (existing.status === "PAUSED") {
        return this.mutate(existing.sessionId, existing.revision, (session) => {
          session.status = session.resumeStatus ?? "COLLECTING";
          delete session.resumeStatus;
          return { type: "session_resumed" };
        });
      }
      return existing;
    }
    const sessionId = randomUUID();
    const workspace = assertAbsoluteWorkspace(typeof workspaceRoot === 'function' ? workspaceRoot(sessionId) : workspaceRoot);
    const now = new Date().toISOString();
    const session: Session = {
      schemaVersion: 1,
      sessionId,
      goal: goal.trim(),
      workspaceRoot: workspace,
      status: "COLLECTING",
      revision: 1,
      round: 0,
      createdAt: now,
      updatedAt: now,
      answerRounds: [],
      decisions: [],
      remainingAreas: [],
      reviews: [],
      idempotency: {},
      maxRounds: INITIAL_MAX_ROUNDS,
      riskAccepted: false,
      conflictsConfirmed: false,
    };
    if (!session.goal) throw new GrillError("INVALID_GOAL", "目标不能为空");
    await this.persist(session, { type: "session_started", revision: 1, at: now });
    return session;
  }

  async get(sessionId: string): Promise<Session> {
    const file = path.join(this.sessionDirectory(sessionId), "session.json");
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as Session;
      return {
        ...parsed,
        maxRounds: parsed.maxRounds ?? INITIAL_MAX_ROUNDS,
        riskAccepted: parsed.riskAccepted ?? false,
        conflictsConfirmed: parsed.conflictsConfirmed ?? false,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new GrillError("SESSION_NOT_FOUND", `找不到会话 ${sessionId}`);
      }
      throw error;
    }
  }

  async compact(sessionId: string): Promise<CompactSession> {
    const session = await this.get(sessionId);
    return {
      sessionId: session.sessionId,
      status: session.status,
      revision: session.revision,
      round: session.round,
      goal: session.goal,
      workspaceRoot: session.workspaceRoot,
      decisions: session.decisions,
      remainingAreas: session.remainingAreas,
      latestAnswers: session.answerRounds.at(-1),
      latestReview: session.reviews.at(-1),
      candidate: session.candidate,
      maxRoundsReached: session.round >= session.maxRounds,
      maxRounds: session.maxRounds,
      riskAccepted: session.riskAccepted,
      conflictsConfirmed: session.conflictsConfirmed,
    };
  }

  async putQuestions(
    sessionId: string,
    expectedRevision: number,
    questions: Question[],
    decidedSummary: string[],
    remainingAreas: string[],
    roundLimitGate = false,
  ): Promise<Session> {
    validateQuestions(questions, roundLimitGate);
    return this.mutate(sessionId, expectedRevision, (session) => {
      assertStatus(session, ["COLLECTING", "NEEDS_MORE", "SYNTHESIZING"], "写入问题");
      if (roundLimitGate) {
        if (session.round < session.maxRounds || session.reviews.at(-1)?.decision !== "return") {
          throw new GrillError("INVALID_ROUND_LIMIT_GATE", "只有达到上限且最新审阅被退回时才能展示轮次选择");
        }
        if (questions.length !== 1 || questions[0]?.id !== "__round_limit_decision") {
          throw new GrillError("INVALID_ROUND_LIMIT_GATE", "轮次选择题必须使用 __round_limit_decision");
        }
        session.currentBatch = {
          round: session.round,
          purpose: "ROUND_LIMIT",
          questions,
          decidedSummary,
          remainingAreas,
          createdAt: new Date().toISOString(),
        };
        session.status = "AWAITING_USER";
        return { type: "round_limit_prompted", detail: { round: session.round } };
      }
      if (session.round >= session.maxRounds) {
        throw new GrillError("MAX_ROUNDS_REACHED", "已达到 12 轮上限，需要用户明确选择继续或带风险结束", {
          latestReview: session.reviews.at(-1),
          remainingAreas: session.remainingAreas,
        });
      }
      session.round += 1;
      session.currentBatch = {
        round: session.round,
        purpose: "INTERVIEW",
        questions,
        decidedSummary,
        remainingAreas,
        createdAt: new Date().toISOString(),
      };
      session.decisions = decidedSummary;
      session.remainingAreas = remainingAreas;
      session.status = "AWAITING_USER";
      return { type: "question_batch_put", detail: { round: session.round, questionCount: questions.length } };
    });
  }

  async submitAnswers(
    sessionId: string,
    expectedRevision: number,
    idempotencyKey: string,
    answers: Answer[],
  ): Promise<Session> {
    if (!idempotencyKey.trim()) throw new GrillError("INVALID_IDEMPOTENCY_KEY", "idempotency_key 不能为空");
    return this.withLock(sessionId, async () => {
      const current = await this.get(sessionId);
      const replay = current.idempotency[idempotencyKey];
      if (replay) return current;
      assertRevision(current, expectedRevision);
      assertStatus(current, ["AWAITING_USER"], "提交答案");
      validateAnswers(current, answers);
      current.answerRounds.push({
        round: current.round,
        answers,
        submittedAt: new Date().toISOString(),
        idempotencyKey,
      });
      if (current.currentBatch?.purpose === "ROUND_LIMIT") {
        const choice = answers.find((answer) => answer.questionId === "__round_limit_decision")?.selectedOptionIds?.[0];
        if (choice === "continue") {
          current.maxRounds += INITIAL_MAX_ROUNDS;
          current.status = "NEEDS_MORE";
        } else if (choice === "finish_with_known_risks") {
          current.riskAccepted = true;
          current.status = "REVIEW_PENDING";
        } else {
          throw new GrillError("INVALID_ROUND_LIMIT_CHOICE", "请选择继续追问或带已知风险结束");
        }
      } else if (current.currentBatch?.purpose === "FILE_CONFLICT") {
        const choice = answers.find((answer) => answer.questionId === "__file_conflict_decision")?.selectedOptionIds?.[0];
        if (choice === "confirm_backup_and_write") {
          current.conflictsConfirmed = true;
          current.status = "APPROVED";
        } else if (choice === "cancel_materialization") {
          current.resumeStatus = "APPROVED";
          current.status = "PAUSED";
        } else {
          throw new GrillError("INVALID_CONFLICT_CHOICE", "请选择备份后写入或取消生成");
        }
      } else {
        current.status = "SYNTHESIZING";
      }
      current.revision += 1;
      current.updatedAt = new Date().toISOString();
      current.idempotency[idempotencyKey] = { revision: current.revision, round: current.round };
      await this.persist(current, {
        type: "answers_submitted",
        revision: current.revision,
        at: current.updatedAt,
        detail: { round: current.round },
      });
      return current;
    });
  }

  async putCandidate(
    sessionId: string,
    expectedRevision: number,
    markdown: string,
    decisions: string[],
    unresolved: string[],
  ): Promise<Session> {
    if (!markdown.trim()) throw new GrillError("INVALID_PLAN", "候选计划不能为空");
    return this.mutate(sessionId, expectedRevision, (session) => {
      assertStatus(session, ["SYNTHESIZING"], "保存候选计划");
      const candidate: CandidatePlan = {
        markdown: markdown.trim(),
        decisions,
        unresolved,
        createdAt: new Date().toISOString(),
      };
      session.candidate = candidate;
      session.decisions = decisions;
      session.remainingAreas = unresolved;
      session.status = "REVIEW_PENDING";
      return { type: "candidate_plan_put", detail: { unresolvedCount: unresolved.length } };
    });
  }

  async recordReview(
    sessionId: string,
    expectedRevision: number,
    decision: "approve" | "return",
    reasons: ReviewRecord["reasons"],
  ): Promise<Session> {
    return this.mutate(sessionId, expectedRevision, (session) => {
      assertStatus(session, ["REVIEW_PENDING"], "记录审阅");
      if (decision === "return" && reasons.length === 0) {
        throw new GrillError("INVALID_REVIEW", "退回时必须提供具体原因");
      }
      if (decision === "approve" && (session.candidate?.unresolved.length ?? 0) > 0 && !session.riskAccepted) {
        throw new GrillError("UNRESOLVED_DECISIONS", "候选计划仍包含未决事项，不能批准");
      }
      session.reviews.push({ decision, reasons, createdAt: new Date().toISOString() });
      session.status = decision === "approve" ? "APPROVED" : "NEEDS_MORE";
      return { type: "review_recorded", detail: { decision, reasonCount: reasons.length } };
    });
  }

  async markMaterialized(
    sessionId: string,
    expectedRevision: number,
    files: string[],
    backupDirectory?: string,
  ): Promise<Session> {
    return this.mutate(sessionId, expectedRevision, (session) => {
      assertStatus(session, ["APPROVED"], "生成项目文档");
      session.status = "MATERIALIZED";
      session.materialized = { at: new Date().toISOString(), files, backupDirectory };
      return { type: "documents_materialized", detail: { files, backupDirectory } };
    });
  }

  async prepareConflictConfirmation(sessionId: string, expectedRevision: number, conflicts: string[]): Promise<Session> {
    return this.mutate(sessionId, expectedRevision, (session) => {
      assertStatus(session, ["APPROVED"], "请求文件冲突确认");
      session.currentBatch = {
        round: session.round,
        purpose: "FILE_CONFLICT",
        decidedSummary: session.decisions,
        remainingAreas: [`现有文件冲突：${conflicts.join("、")}`],
        createdAt: new Date().toISOString(),
        questions: [{
          id: "__file_conflict_decision",
          prompt: `项目中已有 ${conflicts.join("、")}。是否先备份原文件，再生成已审核文档？`,
          kind: "single",
          required: true,
          options: [
            { id: "confirm_backup_and_write", label: "备份后写入", description: "原文件复制到 .grill-me-extended-backups/<session>/<timestamp>/" },
            { id: "cancel_materialization", label: "暂不生成", description: "保留现有文件并暂停会话" },
          ],
          recommendedOptionIds: ["confirm_backup_and_write"],
          recommendationReason: "先备份再写入可保留恢复路径，同时完成已审核计划的落地。",
          allowOther: true,
        }],
      };
      session.status = "AWAITING_USER";
      return { type: "file_conflict_confirmation_requested", detail: { conflicts } };
    });
  }

  async pause(sessionId: string, expectedRevision: number): Promise<Session> {
    return this.mutate(sessionId, expectedRevision, (session) => {
      assertStatus(session, ["COLLECTING", "AWAITING_USER", "SYNTHESIZING", "REVIEW_PENDING", "NEEDS_MORE"], "暂停会话");
      session.resumeStatus = session.status as Exclude<SessionStatus, "PAUSED" | "CANCELLED">;
      session.status = "PAUSED";
      return { type: "session_paused" };
    });
  }

  async cancel(sessionId: string, expectedRevision: number): Promise<Session> {
    return this.mutate(sessionId, expectedRevision, (session) => {
      assertStatus(session, ["COLLECTING", "AWAITING_USER", "SYNTHESIZING", "REVIEW_PENDING", "NEEDS_MORE", "PAUSED"], "终止会话");
      session.status = "CANCELLED";
      return { type: "session_cancelled" };
    });
  }

  private async mutate(
    sessionId: string,
    expectedRevision: number,
    change: (session: Session) => { type: string; detail?: Record<string, unknown> },
  ): Promise<Session> {
    return this.withLock(sessionId, async () => {
      const session = await this.get(sessionId);
      assertRevision(session, expectedRevision);
      const event = change(session);
      session.revision += 1;
      session.updatedAt = new Date().toISOString();
      await this.persist(session, {
        ...event,
        revision: session.revision,
        at: session.updatedAt,
      });
      return session;
    });
  }

  private async persist(session: Session, event: SessionEvent): Promise<void> {
    const directory = this.sessionDirectory(session.sessionId);
    await mkdir(directory, { recursive: true });
    const sessionFile = path.join(directory, "session.json");
    const temporary = `${sessionFile}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, "utf8");
    await rename(temporary, sessionFile);
    await appendFile(path.join(directory, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
    if (session.candidate) {
      await writeFile(path.join(directory, "candidate.md"), `${session.candidate.markdown.trim()}\n`, "utf8");
    }
  }
}
