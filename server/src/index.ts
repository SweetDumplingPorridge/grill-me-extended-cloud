#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DocumentMaterializer } from "./documents.js";
import { SessionStore } from "./store.js";
import type { Question, Session } from "./types.js";
import { GrillError } from "./types.js";
import type { RemoteContext } from './remote.js';
import { WORKFLOW } from './workflow.js';

const UI_URI = "ui://grill-me-extended/questionnaire-v1";

const optionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
});

const questionSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  kind: z.enum(["single", "multi", "text"]),
  required: z.boolean().default(true),
  options: z.array(optionSchema).optional(),
  recommendedOptionIds: z.array(z.string()).optional(),
  recommendedText: z.string().optional(),
  recommendationReason: z.string().min(1),
  allowOther: z.boolean().default(true),
});

const answerSchema = z.object({
  questionId: z.string().min(1),
  selectedOptionIds: z.array(z.string()).optional(),
  text: z.string().optional(),
  otherText: z.string().optional(),
});

const reviewReasonSchema = z.object({
  area: z.string().min(1),
  problem: z.string().min(1),
  requiredDecision: z.string().optional(),
});

function summary(session: Session) {
  return {
    session_id: session.sessionId,
    status: session.status,
    revision: session.revision,
    round: session.round,
  };
}

function result(value: unknown, message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    structuredContent: value as Record<string, unknown>,
  };
}

function errorResult(error: unknown) {
  const grill = error instanceof GrillError ? error : new GrillError("INTERNAL_ERROR", String(error));
  return {
    isError: true,
    content: [{ type: "text" as const, text: `${grill.code}: ${grill.message}` }],
    structuredContent: { error: { code: grill.code, message: grill.message, data: grill.data } },
  };
}

function fallbackQuestionnaire(session: Session): string {
  const batch = session.currentBatch;
  if (!batch) return `会话 ${session.sessionId} 当前没有待回答问卷。`;
  const lines = [
    `Grill Me Extended · 第 ${batch.round} 轮 · revision ${session.revision}`,
    `会话：${session.sessionId}`,
    "",
    ...batch.questions.flatMap((question, index) => {
      const options = question.options?.map((option) => `   - ${option.id}: ${option.label}${option.description ? ` — ${option.description}` : ""}`) ?? [];
      const recommendation = question.recommendedOptionIds?.length
        ? `   推荐：${question.recommendedOptionIds.join(", ")}（${question.recommendationReason}）`
        : question.recommendedText
          ? `   推荐填写：${question.recommendedText}（${question.recommendationReason}）`
          : `   推荐说明：${question.recommendationReason}`;
      return [
        `${index + 1}. ${question.prompt}${question.required ? "（必答）" : ""}`,
        ...options,
        recommendation,
        "   其他/补充说明：________________",
        "",
      ];
    }),
    "若界面未显示，请按同一 schema 调用 answers_submit；不要把答案仅留在聊天文本中。",
  ];
  return lines.join("\n");
}

export function createMcpServer(options: { store?: SessionStore; remote?: RemoteContext } = {}) {
const store = options.remote?.store ?? options.store ?? new SessionStore();
const materializer = new DocumentMaterializer();
const authMeta = { securitySchemes: options.remote ? [{ type: 'oauth2', scopes: ['interview'] }] : [{ type: 'noauth' }] };
const server = new McpServer({ name: "grill-me-extended", version: "0.2.0" }, { instructions: WORKFLOW });

server.registerResource(
  "grill-me-extended-questionnaire",
  UI_URI,
  {
    title: "Grill Me Extended Questionnaire",
    description: "交互式需求澄清问卷",
    mimeType: "text/html;profile=mcp-app",
    _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } }, 'openai/widgetDescription': '填写需求澄清问卷，或下载最终计划和交接文档。' },
  },
  async () => {
    const current = path.dirname(fileURLToPath(import.meta.url));
    const script = await readFile(path.resolve(current, "../../web/dist/app.js"), "utf8");
    const html = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Grill Me Extended</title></head>
<body><main id="app" aria-live="polite">正在载入问卷…</main><script type="module">${script}</script></body>
</html>`;
    return { contents: [{ uri: UI_URI, mimeType: "text/html;profile=mcp-app", text: html }] };
  },
);

server.registerTool(
  "session_start_or_resume",
  {
    title: "Start or resume interview",
    description: "创建或恢复 Grill Me Extended 会话。恢复时只需提供 session_id。",
    inputSchema: {
      goal: z.string().min(1),
    workspace: z.string().min(1).optional(),
      session_id: z.string().optional(),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
    _meta: { ...authMeta },
  },
  async ({ goal, workspace, session_id }) => {
    try {
      if (options.remote && workspace) throw new GrillError('REMOTE_WORKSPACE_FORBIDDEN', '远程服务自动分配目录，不接受本机或服务器路径');
      if (!options.remote && !workspace) throw new GrillError('INVALID_WORKSPACE', '本地 stdio 模式需要 workspace 绝对路径');
      const session = options.remote ? await options.remote.start(goal, session_id) : await store.startOrResume(goal, workspace!, session_id);
      return result(summary(session), `会话 ${session.sessionId}：${session.status}，revision ${session.revision}。${WORKFLOW}`);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "question_batch_put",
  {
    title: "Store a question batch",
    description: "由当前 ChatGPT 采访者原子保存一整轮 3–7 个高影响问题；随后调用 questionnaire_render。",
    inputSchema: {
      session_id: z.string().min(1),
      expected_revision: z.number().int().nonnegative(),
      questions: z.array(questionSchema).min(1).max(7),
      decided_summary: z.array(z.string()),
      remaining_areas: z.array(z.string()),
      round_limit_gate: z.boolean().default(false),
    },
    annotations: { readOnlyHint: false, idempotentHint: false },
    _meta: { ...authMeta },
  },
  async ({ session_id, expected_revision, questions, decided_summary, remaining_areas, round_limit_gate }) => {
    try {
      const session = await store.putQuestions(
        session_id,
        expected_revision,
        questions as Question[],
        decided_summary,
        remaining_areas,
        round_limit_gate,
      );
      return result(summary(session), `第 ${session.round} 轮问题已保存；现在调用 questionnaire_render。`);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "questionnaire_render",
  {
    title: "Open Grill Me Extended questionnaire",
    description: "打开当前轮问卷；这是唯一绑定 MCP App UI 的工具。",
    inputSchema: { session_id: z.string().min(1), text_fallback: z.boolean().default(false) },
    annotations: { readOnlyHint: true, idempotentHint: true },
    _meta: { ...authMeta, ui: { resourceUri: UI_URI }, "ui/resourceUri": UI_URI, 'openai/outputTemplate': UI_URI },
  },
  async ({ session_id, text_fallback }) => {
    try {
      const session = await store.get(session_id);
      if (session.status !== "AWAITING_USER") throw new GrillError("INVALID_STATE", `当前状态 ${session.status} 没有可填写问卷`);
      const questionnaire = {
        ...summary(session),
        goal: session.goal,
        decided_summary: session.currentBatch?.decidedSummary ?? [],
        remaining_areas: session.currentBatch?.remainingAreas ?? [],
        questions: session.currentBatch?.questions ?? [],
      };
      return {
        content: [{
          type: "text" as const,
          text: text_fallback
            ? fallbackQuestionnaire(session)
            : `第 ${session.round} 轮问卷已打开。会话 ${session.sessionId}，revision ${session.revision}。若 MCP App 无法显示，请以 text_fallback=true 重试。`,
        }],
        structuredContent: summary(session),
        _meta: { "grillMeExtended/questionnaire": questionnaire },
      };
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "answers_submit",
  {
    title: "Submit questionnaire answers",
    description: "校验并原子保存整轮答案；revision 与幂等键防止重复提交。",
    inputSchema: {
      session_id: z.string().min(1),
      expected_revision: z.number().int().nonnegative(),
      idempotency_key: z.string().min(8),
      answers: z.array(answerSchema),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
    _meta: { ...authMeta, ui: { visibility: ['model', 'app'] } },
  },
  async ({ session_id, expected_revision, idempotency_key, answers }) => {
    try {
      const session = await store.submitAnswers(session_id, expected_revision, idempotency_key, answers);
      return result(summary(session), `第 ${session.round} 轮答案已保存；请继续同一 Grill Me Extended 会话。`);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "session_get",
  {
    title: "Get compact interview state",
    description: "返回权威决策摘要、最近答案、未决项和候选计划，采访与审核前重读。",
    inputSchema: { session_id: z.string().min(1) },
    annotations: { readOnlyHint: true, idempotentHint: true },
    _meta: { ...authMeta },
  },
  async ({ session_id }) => {
    try {
      const compact = await store.compact(session_id);
      return result(compact, `会话 ${compact.sessionId}：${compact.status}，第 ${compact.round} 轮，revision ${compact.revision}`);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "candidate_plan_put",
  {
    title: "Store candidate plan",
    description: "由当前 ChatGPT 保存符合十三部分规范的候选计划和决策清单，然后自审。",
    inputSchema: {
      session_id: z.string().min(1),
      expected_revision: z.number().int().nonnegative(),
      markdown: z.string().min(1),
      decisions: z.array(z.string()),
      unresolved: z.array(z.string()),
    },
    annotations: { readOnlyHint: false, idempotentHint: false },
    _meta: { ...authMeta },
  },
  async ({ session_id, expected_revision, markdown, decisions, unresolved }) => {
    try {
      const session = await store.putCandidate(session_id, expected_revision, markdown, decisions, unresolved);
      return result(summary(session), `候选计划已保存，等待主 agent 审核。`);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "review_record",
  {
    title: "Record main-agent review",
    description: "主 agent 记录批准或结构化退回意见。",
    inputSchema: {
      session_id: z.string().min(1),
      expected_revision: z.number().int().nonnegative(),
      decision: z.enum(["approve", "return"]),
      reasons: z.array(reviewReasonSchema),
    },
    annotations: { readOnlyHint: false, idempotentHint: false },
    _meta: { ...authMeta },
  },
  async ({ session_id, expected_revision, decision, reasons }) => {
    try {
      const session = await store.recordReview(session_id, expected_revision, decision, reasons);
      return result(summary(session), decision === "approve" ? "主审核已通过。" : "候选计划已退回，需要继续追问。" );
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "documents_materialize",
  {
    title: "Materialize approved project documents",
    description: "生成计划.md、进度.md 和 AGENTS.md 托管段；冲突时先返回预览，确认后备份并写入。",
    inputSchema: {
      session_id: z.string().min(1),
      expected_revision: z.number().int().nonnegative(),
      confirm_conflicts: z.boolean().default(false),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
    _meta: { ...authMeta },
  },
  async ({ session_id, expected_revision, confirm_conflicts }) => {
    try {
      const session = await store.get(session_id);
      if (session.status === 'MATERIALIZED') return result({ ...summary(session), written: true, downloads: options.remote?.downloads(session_id) }, '文档已生成。调用 documents_download 获取下载界面。');
      if (session.revision !== expected_revision) {
        throw new GrillError("REVISION_CONFLICT", `revision 冲突：期望 ${expected_revision}，当前 ${session.revision}`);
      }
      const preview = await materializer.preview(session);
      if (confirm_conflicts && preview.conflicts.length > 0 && !session.conflictsConfirmed) {
        throw new GrillError("CONFLICT_CONFIRMATION_REQUIRED", "尚未通过问卷确认文件冲突处理");
      }
      const materialized = await materializer.materialize(session, confirm_conflicts);
      if (!materialized.written) {
        const awaiting = await store.prepareConflictConfirmation(session_id, expected_revision, materialized.conflicts);
        return result(
          { ...summary(awaiting), ...materialized },
          `检测到文件冲突：${materialized.conflicts.join("、")}。调用 questionnaire_render 取得用户确认；确认后以新的 revision 和 confirm_conflicts=true 重试。`,
        );
      }
      const updated = await store.markMaterialized(
        session_id,
        expected_revision,
        materialized.files,
        materialized.backupDirectory,
      );
      return result({ ...summary(updated), ...materialized, downloads: options.remote?.downloads(session_id) }, "计划、进度与 AGENTS.md 管理规则已生成。调用 documents_download 获取下载界面。" );
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "session_pause",
  {
    title: "Pause interview",
    description: "保存并暂停会话，稍后可用 session_id 恢复。",
    inputSchema: { session_id: z.string().min(1), expected_revision: z.number().int().nonnegative() },
    annotations: { readOnlyHint: false, idempotentHint: false },
    _meta: { ...authMeta, ui: { visibility: ['model', 'app'] } },
  },
  async ({ session_id, expected_revision }) => {
    try {
      const session = await store.pause(session_id, expected_revision);
      return result(summary(session), "会话已保存并暂停。" );
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "session_cancel",
  {
    title: "Cancel interview",
    description: "明确终止会话；缓存保留用于审计，但不能继续提交。",
    inputSchema: { session_id: z.string().min(1), expected_revision: z.number().int().nonnegative() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    _meta: { ...authMeta, ui: { visibility: ['model', 'app'] } },
  },
  async ({ session_id, expected_revision }) => {
    try {
      const session = await store.cancel(session_id, expected_revision);
      return result(summary(session), "会话已终止。" );
    } catch (error) {
      return errorResult(error);
    }
  },
);

if (options.remote) server.registerTool('documents_download', {
  title: '下载计划与交接文档', description: '获取已生成三个 Markdown 文档的短期下载链接和聊天内下载界面；链接过期后重新调用。',
  inputSchema: { session_id: z.string().min(1) },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  _meta: { ...authMeta, ui: { resourceUri: UI_URI }, 'ui/resourceUri': UI_URI, 'openai/outputTemplate': UI_URI },
}, async ({ session_id }) => {
  try {
    const session = await store.get(session_id);
    if (session.status !== 'MATERIALIZED') throw new GrillError('INVALID_STATE', '文档尚未生成');
    const downloads = options.remote!.downloads(session_id);
    return { ...result({ ...summary(session), downloads }, downloads.map(d => `[${d.name}](${d.url})`).join('\n')), _meta: { 'grillMeExtended/documents': { ...summary(session), goal: session.goal, downloads } } };
  } catch (error) { return errorResult(error); }
});
return server;
}
