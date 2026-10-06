# Grill Me Extended Workflow Contract

## State ownership and transitions

The MCP server owns `session.json`, the append-only event log, and the candidate draft. Expected flow:

`COLLECTING → AWAITING_USER → SYNTHESIZING → REVIEW_PENDING → APPROVED → MATERIALIZED`

A review return follows `REVIEW_PENDING → NEEDS_MORE → AWAITING_USER`. Every write uses the current revision. Answer submission also uses a new idempotency key. Never repair revision conflicts by guessing: reread `session_get` and retry only if the intended action is still valid.

The iframe may keep an unsubmitted local draft, but it is never business truth. A successful submission locks the round and sends a compact continuation message through `ui/message`.

## Required candidate plan

The candidate Markdown must be directly usable as `计划.md` and cover:

1. 摘要
2. 目标与成功标准
3. 受众与使用场景
4. 范围（包含与不包含）
5. 约束、权限与明确假设
6. 现状与依赖
7. 关键决策
8. 实现方案
9. 接口、输入输出、状态归属与数据流
10. 失败恢复、兼容性与文件冲突
11. 测试方案
12. 可执行验收标准
13. 实施顺序与交接要求

Do not leave high-impact choices for the implementer. Do not retain rejected or superseded alternatives except when an explicit risk record is necessary.

## ChatGPT self-review rubric

Approve only when all are true:

- Goal, success criteria, scope, and constraints are explicit and mutually consistent.
- Every important product and implementation tradeoff is decided.
- Interfaces, inputs, outputs, state ownership, and data flow are sufficient to implement.
- Failure recovery, compatibility, file conflicts, and permission boundaries are explicit.
- Tests and acceptance checks can actually be run.
- The `进度.md` protocol supports a low-cost, accurate handoff.
- No high-impact item remains for an implementer to decide ad hoc.

Return concrete reasons grouped by area and state the missing decision or evidence. Do not merely say that the plan needs more detail.

## Round limit

Before the twelfth round ends, include a clear choice when material disputes remain: continue questioning or finish with explicitly documented known risks. Show the remaining disputes and latest review reasons. Never silently exceed twelve rounds or silently hide unresolved risk.

After a twelfth-round review return, store exactly one system gate with `question_batch_put`: question ID `__round_limit_decision`, option IDs `continue` and `finish_with_known_risks`, and `round_limit_gate: true`. Render it normally. The server extends the limit only after an explicit `continue` answer; risk-finish permits approval only while keeping unresolved items visible in the final risk sections.

## Materialized progress protocol

`进度.md` starts at “计划完成，尚未实施” and stays short. It always includes: current goal, overall status, completed, in progress, next, blockers/risks, latest validation, key changed files, deviations from plan, and update time.

The managed `AGENTS.md` block requires future agents to read `计划.md` and `进度.md` before broad exploration, update progress in the same turn after every material state change, and correct stale progress through the smallest useful verification before continuing. Progress is a handoff index, not a command log and not a substitute for targeted verification.

## Recovery rules

- On interrupted ChatGPT context, recover from `session_get`; the current ChatGPT interviews and self-reviews without subagents.
- On an unavailable MCP App renderer, present the tool's structured text fallback and still submit through `answers_submit`.
- On an unavailable MCP service, stop writing and report the outage; resume through `session_get` once restored.
- On existing non-managed project documents, preview conflicts, obtain explicit confirmation, create `.grill-me-extended-backups/<session_id>/<timestamp>/`, then materialize.
