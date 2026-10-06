import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Session } from "./types.js";
import { GrillError } from "./types.js";

const MANAGED_START = "<!-- GRILL-ME-EXTENDED:START";
const MANAGED_END = "<!-- GRILL-ME-EXTENDED:END -->";

export interface MaterializePreview {
  conflicts: string[];
  files: string[];
  requiresConfirmation: boolean;
}

export interface MaterializeResult extends MaterializePreview {
  written: boolean;
  backupDirectory?: string;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function sessionMarker(sessionId: string): string {
  return `<!-- grill-me-extended:session=${sessionId} -->`;
}

function managedStart(sessionId: string): string {
  return `${MANAGED_START} session=${sessionId} -->`;
}

function isSameSession(content: string, sessionId: string): boolean {
  return content.includes(sessionMarker(sessionId)) || content.includes(managedStart(sessionId));
}

function progressDocument(session: Session): string {
  const now = new Date().toISOString();
  return `${sessionMarker(session.sessionId)}
# 进度

- 当前目标：${session.goal}
- 总体状态：计划完成，尚未实施
- 已完成：需求澄清、关键决策、实现计划与主审核
- 正在进行：无
- 下一步：按《计划.md》开始实施，并在每次实质状态变化后更新本文档
- 阻塞/风险：${session.candidate?.unresolved.length ? session.candidate.unresolved.join("；") : "无已知阻塞"}
- 最近验证：候选计划已通过 Grill Me Extended 主审核
- 关键改动文件：计划.md、进度.md、AGENTS.md
- 与计划的偏差：无
- 更新时间：${now}
`;
}

function planDocument(session: Session): string {
  const body = session.candidate?.markdown.trim();
  if (!body) throw new GrillError("NO_CANDIDATE_PLAN", "没有可生成的候选计划");
  return `${sessionMarker(session.sessionId)}\n${body}\n`;
}

function managedAgentsBlock(session: Session): string {
  return `${managedStart(session.sessionId)}
## Grill Me Extended 项目交接规则

- 在广泛探索或实施前，先阅读项目根目录的 \`计划.md\` 与 \`进度.md\`。
- \`进度.md\` 是快速交接索引，不替代必要的针对性验证，也不得退化为冗长命令日志。
- 每当完成步骤、修改文件、运行验证、发现或解除阻塞、改变决策、改变下一步时，必须在同一轮工作结束前实时、准确地更新 \`进度.md\`。
- 若实际项目状态与 \`进度.md\` 冲突，先做最小范围验证并纠正文档，再继续工作；禁止基于已知错误状态实施。
- 更新时保持固定字段：当前目标、总体状态、已完成、正在进行、下一步、阻塞/风险、最近验证、关键改动文件、与计划的偏差、更新时间。
${MANAGED_END}`;
}

function updateAgents(existing: string, session: Session): string {
  const block = managedAgentsBlock(session);
  const escapedStart = MANAGED_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedEnd = MANAGED_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const managed = new RegExp(`${escapedStart}[^\n]*-->[\\s\\S]*?${escapedEnd}`, "g");
  const matches = existing.match(managed) ?? [];
  if (matches.length > 1) throw new GrillError("DUPLICATE_MANAGED_BLOCK", "AGENTS.md 包含多个 Grill Me Extended 托管段");
  if (matches.length === 1) return `${existing.replace(managed, block).trimEnd()}\n`;
  return existing.trim() ? `${existing.trimEnd()}\n\n${block}\n` : `${block}\n`;
}

function safeChild(root: string, name: string): string {
  const target = path.resolve(root, name);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new GrillError("PATH_ESCAPE", `目标路径越界：${name}`);
  }
  return target;
}

async function assertSafeTarget(file: string): Promise<void> {
  if (!(await exists(file))) return;
  const info = await lstat(file);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new GrillError("UNSAFE_TARGET", `拒绝覆盖非普通文件或符号链接：${file}`);
  }
}

export class DocumentMaterializer {
  async preview(session: Session): Promise<MaterializePreview> {
    if (session.status !== "APPROVED") {
      throw new GrillError("INVALID_STATE", `只有 APPROVED 会话可以生成文档，当前为 ${session.status}`);
    }
    const workspace = await this.safeWorkspace(session.workspaceRoot);
    const files = ["计划.md", "进度.md", "AGENTS.md"].map((name) => safeChild(workspace, name));
    const conflicts: string[] = [];
    for (const file of files) {
      await assertSafeTarget(file);
      if (!(await exists(file))) continue;
      const content = await readFile(file, "utf8");
      if (!isSameSession(content, session.sessionId)) conflicts.push(path.basename(file));
    }
    return { conflicts, files, requiresConfirmation: conflicts.length > 0 };
  }

  async materialize(session: Session, confirmConflicts: boolean): Promise<MaterializeResult> {
    const preview = await this.preview(session);
    if (preview.requiresConfirmation && !confirmConflicts) return { ...preview, written: false };
    const workspace = await this.safeWorkspace(session.workspaceRoot);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    let backupDirectory: string | undefined;
    if (preview.conflicts.length > 0) {
      backupDirectory = safeChild(
        workspace,
        path.join(".grill-me-extended-backups", session.sessionId, timestamp),
      );
      await mkdir(backupDirectory, { recursive: true });
      for (const name of preview.conflicts) {
        await copyFile(safeChild(workspace, name), safeChild(backupDirectory, name));
      }
    }

    const planPath = safeChild(workspace, "计划.md");
    const progressPath = safeChild(workspace, "进度.md");
    const agentsPath = safeChild(workspace, "AGENTS.md");
    const existingAgents = (await exists(agentsPath)) ? await readFile(agentsPath, "utf8") : "";
    const writes = new Map<string, string>([
      [planPath, planDocument(session)],
      [progressPath, progressDocument(session)],
      [agentsPath, updateAgents(existingAgents, session)],
    ]);
    const staged: Array<{ temporary: string; target: string }> = [];
    for (const [target, content] of writes) {
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, content, "utf8");
      staged.push({ temporary, target });
    }
    for (const item of staged) await rename(item.temporary, item.target);
    return { ...preview, written: true, backupDirectory };
  }

  private async safeWorkspace(workspaceRoot: string): Promise<string> {
    if (!path.isAbsolute(workspaceRoot)) throw new GrillError("INVALID_WORKSPACE", "workspace 必须是绝对路径");
    const resolved = path.resolve(workspaceRoot);
    let actual: string;
    try {
      actual = await realpath(resolved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new GrillError("WORKSPACE_NOT_FOUND", `项目目录不存在：${resolved}`);
      }
      throw error;
    }
    const info = await stat(actual);
    if (!info.isDirectory()) throw new GrillError("INVALID_WORKSPACE", `workspace 不是目录：${actual}`);
    return actual;
  }
}

export const __test = { updateAgents, managedAgentsBlock, sessionMarker };
