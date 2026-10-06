import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("bundled MCP server lists tools, serves the App, and renders a stored batch", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "gme-mcp-data-"));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "gme-mcp-workspace-"));
  const serverPath = path.resolve("server/dist/index.mjs");
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  environment.GRILL_ME_EXTENDED_DATA_DIR = dataRoot;
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env: environment });
  const client = new Client({ name: "grill-me-extended-test", version: "0.1.0" });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    for (const expected of [
      "session_start_or_resume", "question_batch_put", "questionnaire_render", "answers_submit",
      "session_get", "candidate_plan_put", "review_record", "documents_materialize", "session_pause", "session_cancel",
    ]) assert.ok(names.includes(expected), `missing tool ${expected}`);
    const renderer = listed.tools.find((tool) => tool.name === "questionnaire_render");
    assert.equal(renderer?._meta?.["ui/resourceUri"], "ui://grill-me-extended/questionnaire-v1");

    const resource = await client.readResource({ uri: "ui://grill-me-extended/questionnaire-v1" });
    assert.equal(resource.contents[0]?.mimeType, "text/html;profile=mcp-app");
    assert.match("text" in resource.contents[0]! ? resource.contents[0].text : "", /Grill Me Extended Questionnaire/);

    const started = await client.callTool({ name: "session_start_or_resume", arguments: { goal: "MCP 冒烟", workspace } });
    const startState = started.structuredContent as { session_id: string; revision: number };
    const questions = [1, 2, 3].map((number) => ({
      id: `q${number}`,
      prompt: `问题 ${number}`,
      kind: "single",
      required: true,
      options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      recommendedOptionIds: ["a"],
      recommendationReason: "测试推荐",
      allowOther: true,
    }));
    const stored = await client.callTool({ name: "question_batch_put", arguments: {
      session_id: startState.session_id,
      expected_revision: startState.revision,
      questions,
      decided_summary: ["目标已知"],
      remaining_areas: ["范围"],
    }});
    assert.equal(stored.isError, undefined);
    const rendered = await client.callTool({ name: "questionnaire_render", arguments: { session_id: startState.session_id } });
    const renderState = rendered.structuredContent as { status: string };
    const questionnaire = (rendered._meta as Record<string, unknown>)["grillMeExtended/questionnaire"] as { questions: unknown[] };
    const renderContent = rendered.content as Array<{ type: string; text?: string }>;
    assert.equal(renderState.status, "AWAITING_USER");
    assert.equal(questionnaire.questions.length, 3);
    assert.doesNotMatch(JSON.stringify(renderState), /问题 1/);
    assert.match(renderContent[0]?.type === "text" ? renderContent[0].text ?? "" : "", /text_fallback=true/);
    const fallback = await client.callTool({ name: "questionnaire_render", arguments: { session_id: startState.session_id, text_fallback: true } });
    const fallbackContent = fallback.content as Array<{ type: string; text?: string }>;
    assert.match(fallbackContent[0]?.text ?? "", /其他\/补充说明/);

    const firstAnswers = await client.callTool({ name: "answers_submit", arguments: {
      session_id: startState.session_id,
      expected_revision: 2,
      idempotency_key: "mcp-round-one-submission",
      answers: questions.map((question) => ({ questionId: question.id, selectedOptionIds: ["a"] })),
    }});
    assert.equal((firstAnswers.structuredContent as { status: string }).status, "SYNTHESIZING");
    const firstCandidate = await client.callTool({ name: "candidate_plan_put", arguments: {
      session_id: startState.session_id,
      expected_revision: 3,
      markdown: "# 候选计划\n\n仍需决定失败恢复。",
      decisions: ["目标已知"],
      unresolved: ["失败恢复"],
    }});
    assert.equal((firstCandidate.structuredContent as { status: string }).status, "REVIEW_PENDING");
    const returned = await client.callTool({ name: "review_record", arguments: {
      session_id: startState.session_id,
      expected_revision: 4,
      decision: "return",
      reasons: [{ area: "可靠性", problem: "失败恢复仍未决定", requiredDecision: "确定恢复策略" }],
    }});
    assert.equal((returned.structuredContent as { status: string }).status, "NEEDS_MORE");
    const secondQuestions = questions.map((question, index) => ({ ...question, id: `followup-${index + 1}`, prompt: `追问 ${index + 1}` }));
    await client.callTool({ name: "question_batch_put", arguments: {
      session_id: startState.session_id,
      expected_revision: 5,
      questions: secondQuestions,
      decided_summary: ["目标已知"],
      remaining_areas: ["失败恢复"],
    }});
    await client.callTool({ name: "answers_submit", arguments: {
      session_id: startState.session_id,
      expected_revision: 6,
      idempotency_key: "mcp-round-two-submission",
      answers: secondQuestions.map((question) => ({ questionId: question.id, selectedOptionIds: ["a"] })),
    }});
    await client.callTool({ name: "candidate_plan_put", arguments: {
      session_id: startState.session_id,
      expected_revision: 7,
      markdown: "# 计划\n\n## 目标与成功标准\n可执行。\n\n## 失败恢复\n原子重试并保留缓存。",
      decisions: ["目标已知", "原子重试并保留缓存"],
      unresolved: [],
    }});
    const approved = await client.callTool({ name: "review_record", arguments: {
      session_id: startState.session_id,
      expected_revision: 8,
      decision: "approve",
      reasons: [],
    }});
    assert.equal((approved.structuredContent as { status: string }).status, "APPROVED");
    const materialized = await client.callTool({ name: "documents_materialize", arguments: {
      session_id: startState.session_id,
      expected_revision: 9,
      confirm_conflicts: false,
    }});
    assert.equal((materialized.structuredContent as { status: string }).status, "MATERIALIZED");
    assert.match(await readFile(path.join(workspace, "计划.md"), "utf8"), /失败恢复/);
    assert.match(await readFile(path.join(workspace, "进度.md"), "utf8"), /计划完成，尚未实施/);
    assert.match(await readFile(path.join(workspace, "AGENTS.md"), "utf8"), /GRILL-ME-EXTENDED:START/);
  } finally {
    await client.close();
  }
});
