export const ACTIVE_STATUSES = [
  "COLLECTING",
  "AWAITING_USER",
  "SYNTHESIZING",
  "REVIEW_PENDING",
  "NEEDS_MORE",
  "APPROVED",
  "MATERIALIZED",
  "PAUSED",
  "CANCELLED",
] as const;

export type SessionStatus = (typeof ACTIVE_STATUSES)[number];
export type QuestionKind = "single" | "multi" | "text";

export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface Question {
  id: string;
  prompt: string;
  kind: QuestionKind;
  required: boolean;
  options?: QuestionOption[];
  recommendedOptionIds?: string[];
  recommendedText?: string;
  recommendationReason: string;
  allowOther: boolean;
}

export interface QuestionBatch {
  round: number;
  purpose: "INTERVIEW" | "ROUND_LIMIT" | "FILE_CONFLICT";
  questions: Question[];
  decidedSummary: string[];
  remainingAreas: string[];
  createdAt: string;
}

export interface Answer {
  questionId: string;
  selectedOptionIds?: string[];
  text?: string;
  otherText?: string;
}

export interface AnswerRound {
  round: number;
  answers: Answer[];
  submittedAt: string;
  idempotencyKey: string;
}

export interface CandidatePlan {
  markdown: string;
  decisions: string[];
  unresolved: string[];
  createdAt: string;
}

export interface ReviewRecord {
  decision: "approve" | "return";
  reasons: Array<{ area: string; problem: string; requiredDecision?: string }>;
  createdAt: string;
}

export interface SessionEvent {
  type: string;
  revision: number;
  at: string;
  detail?: Record<string, unknown>;
}

export interface Session {
  schemaVersion: 1;
  sessionId: string;
  goal: string;
  workspaceRoot: string;
  status: SessionStatus;
  revision: number;
  round: number;
  createdAt: string;
  updatedAt: string;
  resumeStatus?: Exclude<SessionStatus, "PAUSED" | "CANCELLED">;
  currentBatch?: QuestionBatch;
  answerRounds: AnswerRound[];
  decisions: string[];
  remainingAreas: string[];
  candidate?: CandidatePlan;
  reviews: ReviewRecord[];
  idempotency: Record<string, { revision: number; round: number }>;
  materialized?: {
    at: string;
    files: string[];
    backupDirectory?: string;
  };
  maxRounds: number;
  riskAccepted: boolean;
  conflictsConfirmed: boolean;
}

export interface CompactSession {
  sessionId: string;
  status: SessionStatus;
  revision: number;
  round: number;
  goal: string;
  workspaceRoot: string;
  decisions: string[];
  remainingAreas: string[];
  latestAnswers?: AnswerRound;
  latestReview?: ReviewRecord;
  candidate?: CandidatePlan;
  maxRoundsReached: boolean;
  maxRounds: number;
  riskAccepted: boolean;
  conflictsConfirmed: boolean;
}

export class GrillError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "GrillError";
  }
}
