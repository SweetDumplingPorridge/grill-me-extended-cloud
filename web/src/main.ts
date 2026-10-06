import { App } from "@modelcontextprotocol/ext-apps";

type Option = { id: string; label: string; description?: string };
type Question = {
  id: string;
  prompt: string;
  kind: "single" | "multi" | "text";
  required: boolean;
  options?: Option[];
  recommendedOptionIds?: string[];
  recommendedText?: string;
  recommendationReason: string;
  allowOther: boolean;
};
type Snapshot = {
  session_id: string;
  status: string;
  revision: number;
  round: number;
  goal: string;
  decided_summary: string[];
  remaining_areas: string[];
  questions: Question[];
};
type DraftAnswer = { selectedOptionIds: string[]; text: string; otherText: string };

const root = document.querySelector<HTMLElement>("#app")!;
const app = new App(
  { name: "Grill Me Extended Questionnaire", version: "0.1.0" },
  { availableDisplayModes: ["inline", "fullscreen"] },
  { autoResize: true },
);
let snapshot: Snapshot | undefined;
let locked = false;
let pendingSubmission: { payload: string; key: string } | undefined;

const style = document.createElement("style");
style.textContent = `
:root{color-scheme:light dark;font-family:Inter,"Segoe UI","Microsoft YaHei",sans-serif;--bg:#f7f7f5;--card:#fff;--ink:#20211f;--muted:#686b65;--line:#dcded8;--accent:#196746;--accent-soft:#e3f2ea;--warn:#8b5d00;--danger:#a12b2b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink)}button,input,textarea{font:inherit}.shell{max-width:900px;margin:auto;padding:20px}.top{display:flex;gap:14px;justify-content:space-between;align-items:flex-start}.eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);font-weight:700}.title{margin:5px 0 4px;font-size:clamp(22px,4vw,34px);line-height:1.12}.meta{color:var(--muted);font-size:13px}.full{border:1px solid var(--line);background:var(--card);border-radius:10px;padding:8px 11px;cursor:pointer}.summary{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:18px 0}.summary section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:13px}.summary h2{font-size:13px;margin:0 0 7px}.summary ul{margin:0;padding-left:19px;color:var(--muted);font-size:13px}.questions{display:grid;gap:14px}.question{background:var(--card);border:1px solid var(--line);border-radius:15px;padding:18px}.question:focus-within{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 18%,transparent)}.qhead{display:flex;gap:9px}.num{display:grid;place-items:center;min-width:27px;height:27px;border-radius:50%;background:var(--accent);color:white;font-size:13px;font-weight:700}.prompt{font-weight:650;line-height:1.45}.required{color:var(--danger);margin-left:4px}.choices{display:grid;gap:8px;margin:14px 0}.choice{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:start;padding:11px;border:1px solid var(--line);border-radius:10px;cursor:pointer}.choice:has(input:checked){border-color:var(--accent);background:var(--accent-soft)}.choice input{margin-top:3px;accent-color:var(--accent)}.desc{color:var(--muted);font-size:12px;margin-top:2px}.badge{font-size:11px;background:var(--accent-soft);color:var(--accent);padding:3px 7px;border-radius:99px;font-weight:700}.recommend{border-left:3px solid var(--accent);padding:8px 11px;margin:10px 0 14px;background:var(--accent-soft);font-size:13px}.recommend strong{color:var(--accent)}label.field{display:grid;gap:6px;color:var(--muted);font-size:13px}textarea{width:100%;min-height:72px;resize:vertical;background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:9px;padding:10px}textarea:focus{outline:2px solid color-mix(in srgb,var(--accent) 35%,transparent);border-color:var(--accent)}.actions{position:sticky;bottom:0;display:flex;flex-wrap:wrap;gap:9px;margin-top:18px;padding:13px;background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(10px);border-top:1px solid var(--line)}button.action{border-radius:9px;border:1px solid var(--line);padding:10px 14px;cursor:pointer;background:var(--card);color:var(--ink)}button.primary{background:var(--accent);color:white;border-color:var(--accent);font-weight:700}button.danger{color:var(--danger)}button:disabled{opacity:.55;cursor:not-allowed}.status{min-height:22px;margin:10px 0;color:var(--muted);font-size:13px}.status.error{color:var(--danger)}.status.ok{color:var(--accent)}
@media(max-width:620px){.shell{padding:13px}.summary{grid-template-columns:1fr}.question{padding:14px}.choice{grid-template-columns:auto 1fr}.badge{grid-column:2}.actions{padding-inline:0}.actions button{flex:1 1 42%}}
@media(prefers-color-scheme:dark){:root{--bg:#161816;--card:#20231f;--ink:#f0f2ed;--muted:#adb2a9;--line:#3b4038;--accent:#6fd3a5;--accent-soft:#18392b;--warn:#f1c05f;--danger:#ff9999}}
`;
document.head.append(style);
const adaptiveStyle = document.createElement('style');
adaptiveStyle.textContent = `
body{overflow-wrap:anywhere}.top>div{min-width:0}.full{flex-shrink:0;min-height:44px}.choice{min-height:48px}textarea{font-size:16px}button.action{min-height:44px}.download-list{display:grid;gap:12px;margin-top:24px}.download-list button{padding:16px;border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--ink);text-align:left;cursor:pointer;font:inherit}
:root[data-theme="light"]{color-scheme:light;--bg:#f7f7f5;--card:#fff;--ink:#20211f;--muted:#686b65;--line:#dcded8;--accent:#196746;--accent-soft:#e3f2ea;--danger:#a12b2b}
:root[data-theme="dark"]{color-scheme:dark;--bg:#161816;--card:#20231f;--ink:#f0f2ed;--muted:#adb2a9;--line:#3b4038;--accent:#6fd3a5;--accent-soft:#18392b;--danger:#ff9999}
`;
document.head.append(adaptiveStyle);

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}

function storageKey(): string {
  return `grill-me-extended:${snapshot?.session_id}:${snapshot?.round}`;
}

function readDrafts(): Record<string, DraftAnswer> {
  try {
    return JSON.parse(localStorage.getItem(storageKey()) ?? "{}") as Record<string, DraftAnswer>;
  } catch {
    return {};
  }
}

function collectAnswers(): Array<{ questionId: string; selectedOptionIds?: string[]; text?: string; otherText?: string }> {
  if (!snapshot) return [];
  return snapshot.questions.map((question) => {
    const selected = [...document.querySelectorAll<HTMLInputElement>(`input[name="q-${CSS.escape(question.id)}"]:checked`)].map((input) => input.value);
    const text = document.querySelector<HTMLTextAreaElement>(`textarea[data-answer="${CSS.escape(question.id)}"]`)?.value.trim();
    const otherText = document.querySelector<HTMLTextAreaElement>(`textarea[data-other="${CSS.escape(question.id)}"]`)?.value.trim();
    return {
      questionId: question.id,
      ...(selected.length ? { selectedOptionIds: selected } : {}),
      ...(text ? { text } : {}),
      ...(otherText ? { otherText } : {}),
    };
  });
}

function saveDraft(): void {
  if (!snapshot || locked) return;
  const answers = Object.fromEntries(collectAnswers().map((answer) => [answer.questionId, {
    selectedOptionIds: answer.selectedOptionIds ?? [],
    text: answer.text ?? "",
    otherText: answer.otherText ?? "",
  }]));
  try { localStorage.setItem(storageKey(), JSON.stringify(answers)); } catch { /* UI draft persistence is best-effort only. */ }
}

function questionHtml(question: Question, index: number, draft?: DraftAnswer): string {
  const recommended = new Set(question.recommendedOptionIds ?? []);
  const choices = question.kind === "text" ? "" : `<div class="choices" role="group" aria-label="${escapeHtml(question.prompt)}">${(question.options ?? []).map((option) => {
    const type = question.kind === "single" ? "radio" : "checkbox";
    const checked = draft?.selectedOptionIds.includes(option.id) ? " checked" : "";
    const description = option.description ? `<div class="desc">${escapeHtml(option.description)}</div>` : "";
    const badge = recommended.has(option.id) ? `<span class="badge">推荐</span>` : "";
    return `<label class="choice"><input type="${type}" name="q-${escapeHtml(question.id)}" value="${escapeHtml(option.id)}"${checked}${locked ? " disabled" : ""}><span><span>${escapeHtml(option.label)}</span>${description}</span>${badge}</label>`;
  }).join("")}</div>`;
  const recommendedText = question.recommendedText ? `<div><strong>推荐填写：</strong>${escapeHtml(question.recommendedText)}</div>` : "";
  const textField = question.kind === "text" ? `<label class="field">你的回答<textarea data-answer="${escapeHtml(question.id)}"${locked ? " disabled" : ""}>${escapeHtml(draft?.text ?? "")}</textarea></label>` : "";
  return `<article class="question" data-question="${escapeHtml(question.id)}"><div class="qhead"><span class="num">${index + 1}</span><div class="prompt">${escapeHtml(question.prompt)}${question.required ? '<span class="required" aria-label="必答">*</span>' : ""}</div></div>${choices}<div class="recommend">${recommendedText}<strong>推荐理由：</strong>${escapeHtml(question.recommendationReason)}<div class="desc">推荐项仅作高亮，不会自动替你选择。</div></div>${textField}<label class="field">其他 / 补充说明<textarea data-other="${escapeHtml(question.id)}" placeholder="可填写未覆盖的情况、限制或自定义答案"${locked ? " disabled" : ""}>${escapeHtml(draft?.otherText ?? "")}</textarea></label></article>`;
}

function list(items: string[], empty: string): string {
  return `<ul>${(items.length ? items : [empty]).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function render(): void {
  if (!snapshot) return;
  const drafts = readDrafts();
  root.innerHTML = `<div class="shell"><header class="top"><div><div class="eyebrow">Grill Me Extended</div><h1 class="title">第 ${snapshot.round} 轮决策问卷</h1><div class="meta">${escapeHtml(snapshot.goal)} · revision ${snapshot.revision}</div></div><button class="full" id="fullscreen" type="button" aria-label="展开全屏">全屏</button></header><div class="summary"><section><h2>已经确定</h2>${list(snapshot.decided_summary, "尚无已确定决策")}</section><section><h2>仍需关注</h2>${list(snapshot.remaining_areas, "等待本轮确认")}</section></div><form id="questionnaire"><div class="questions">${snapshot.questions.map((question, index) => questionHtml(question, index, drafts[question.id])).join("")}</div><div id="status" class="status" role="status"></div><footer class="actions"><button class="action primary" id="submit" type="submit">提交本轮</button><button class="action" id="pause" type="button">保存并稍后继续</button><button class="action danger" id="cancel" type="button">终止会话</button></footer></form></div>`;
  root.querySelector("form")?.addEventListener("input", saveDraft);
  root.querySelector("form")?.addEventListener("submit", submit);
  root.querySelector("#pause")?.addEventListener("click", pause);
  root.querySelector("#cancel")?.addEventListener("click", cancel);
  root.querySelector("#fullscreen")?.addEventListener("click", fullscreen);
}

function setBusy(busy: boolean, message = "", kind: "" | "error" | "ok" = ""): void {
  root.querySelectorAll<HTMLButtonElement>("button").forEach((button) => button.disabled = busy || locked);
  const status = root.querySelector<HTMLElement>("#status");
  if (status) { status.textContent = message; status.className = `status ${kind}`; }
}

function validateRequired(): string | undefined {
  if (!snapshot) return "问卷尚未载入";
  const answers = new Map(collectAnswers().map((answer) => [answer.questionId, answer]));
  for (const question of snapshot.questions) {
    if (!question.required) continue;
    const answer = answers.get(question.id);
    if (!answer?.selectedOptionIds?.length && !answer?.text?.trim() && !answer?.otherText?.trim()) return `请回答必答题：${question.prompt}`;
  }
  return undefined;
}

async function submit(event: Event): Promise<void> {
  event.preventDefault();
  if (!snapshot || locked) return;
  const validation = validateRequired();
  if (validation) { setBusy(false, validation, "error"); return; }
  saveDraft();
  const answers = collectAnswers();
  const payload = JSON.stringify(answers);
  if (!pendingSubmission || pendingSubmission.payload !== payload) {
    try {
      const cached = JSON.parse(localStorage.getItem(storageKey() + ':submission') ?? 'null') as typeof pendingSubmission;
      pendingSubmission = cached?.payload === payload ? cached : { payload, key: crypto.randomUUID() };
    } catch { pendingSubmission = { payload, key: crypto.randomUUID() }; }
    try { localStorage.setItem(storageKey() + ':submission', JSON.stringify(pendingSubmission)); } catch { /* best effort */ }
  }
  setBusy(true, "正在安全保存本轮答案…");
  try {
    const response = await app.callServerTool({ name: "answers_submit", arguments: {
      session_id: snapshot.session_id,
      expected_revision: snapshot.revision,
      idempotency_key: pendingSubmission.key,
      answers,
    }});
    if (response.isError) throw new Error(response.content?.map((item) => item.type === "text" ? item.text : "").join(" ") || "提交失败");
    const next = response.structuredContent as Partial<Snapshot> | undefined;
    locked = true;
    snapshot.revision = next?.revision ?? snapshot.revision + 1;
    root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea').forEach(field => field.disabled = true);
    try { localStorage.removeItem(storageKey()); localStorage.removeItem(storageKey() + ':submission'); } catch { /* ignored */ }
    setBusy(true, "提交成功。本轮已锁定，正在通知采访流程继续。", "ok");
    try {
      const continuation = await app.sendMessage({ role: 'user', content: [{ type: 'text', text: `继续 Grill Me Extended 会话 ${snapshot.session_id}，当前 revision ${snapshot.revision}。请读取 session_get 并继续采访或审核。` }] });
      if (continuation.isError) throw new Error('宿主未接受继续消息');
    } catch {
      setBusy(true, `答案已保存。请在聊天中发送“继续 Grill Me Extended 会话 ${snapshot.session_id}”，即可从已保存的答案继续。`, 'ok');
    }
  } catch (error) {
    setBusy(false, `提交失败，表单内容已保留：${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

async function pause(): Promise<void> {
  if (!snapshot || locked) return;
  saveDraft();
  setBusy(true, "正在保存并暂停…");
  try {
    const response = await app.callServerTool({ name: "session_pause", arguments: { session_id: snapshot.session_id, expected_revision: snapshot.revision } });
    if (response.isError) throw new Error("暂停失败");
    locked = true;
    setBusy(true, `已暂停。稍后用会话 ${snapshot.session_id} 恢复。`, "ok");
  } catch (error) { setBusy(false, String(error), "error"); }
}

async function cancel(): Promise<void> {
  if (!snapshot || locked) return;
  const button = root.querySelector<HTMLButtonElement>('#cancel');
  if (button?.dataset.confirm !== 'true') {
    if (button) { button.dataset.confirm = 'true'; button.textContent = '确认终止'; }
    setBusy(false, '再次点击“确认终止”将结束访谈，已提交历史会保留。也可以继续填写问卷。');
    return;
  }
  setBusy(true, "正在终止…");
  try {
    const response = await app.callServerTool({ name: "session_cancel", arguments: { session_id: snapshot.session_id, expected_revision: snapshot.revision } });
    if (response.isError) throw new Error("终止失败");
    locked = true;
    setBusy(true, "会话已终止。", "ok");
  } catch (error) { setBusy(false, String(error), "error"); }
}

async function fullscreen(): Promise<void> {
  try { await app.requestDisplayMode({ mode: "fullscreen" }); }
  catch { setBusy(false, "当前宿主不支持全屏模式，仍可在当前宽度填写。", "error"); }
}

app.ontoolresult = (toolResult) => {
  const candidate = (
    (toolResult._meta as Record<string, unknown> | undefined)?.["grillMeExtended/questionnaire"]
    ?? toolResult.structuredContent
  ) as Snapshot | undefined;
  if (candidate?.session_id && Array.isArray(candidate.questions)) {
    if (snapshot?.session_id !== candidate.session_id || snapshot.round !== candidate.round) pendingSubmission = undefined;
    snapshot = candidate;
    locked = candidate.status !== 'AWAITING_USER';
    render();
  }
  const documents = (toolResult._meta as Record<string, unknown> | undefined)?.['grillMeExtended/documents'] as { goal: string; downloads: Array<{ name: string; url: string }> } | undefined;
  if (documents) {
    root.innerHTML = `<div class="shell"><div class="eyebrow">Grill Me Extended</div><h1 class="title">计划已完成</h1><p>${escapeHtml(documents.goal)}</p><div class="download-list">${documents.downloads.map((item, index) => `<button type="button" data-download="${index}">下载 ${escapeHtml(item.name)}</button>`).join('')}</div><p class="meta">链接有效期为 15 分钟。过期后在聊天中请求重新获取下载链接。</p><div id="status" role="status"></div></div>`;
    root.querySelectorAll<HTMLButtonElement>('[data-download]').forEach(button => button.addEventListener('click', async () => {
      const item = documents.downloads[Number(button.dataset.download)];
      if (!item) return;
      try {
        const url = new URL(item.url); if (!['https:', 'http:'].includes(url.protocol)) throw new Error('下载地址无效');
        const opened = await app.openLink({ url: url.href }); if (opened.isError) throw new Error('宿主无法打开下载');
      } catch { setBusy(false, '请使用聊天消息中的文档下载链接。', 'error'); }
    }));
  }
};

app.onhostcontextchanged = (context) => {
  document.documentElement.lang = context.locale?.startsWith("zh") ? "zh-CN" : "zh-CN";
  document.documentElement.dataset.theme = context.theme ?? "auto";
};

app.connect().then(() => { document.documentElement.dataset.theme = app.getHostContext()?.theme ?? 'auto'; }).catch((error) => {
  root.innerHTML = `<div class="shell"><h1>问卷无法载入</h1><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p><p>请使用工具结果中附带的结构化文本问卷；提交仍会写入同一 MCP 会话。</p></div>`;
});
