import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

const iframe = document.querySelector<HTMLIFrameElement>("#questionnaire")!;
const mode = new URLSearchParams(location.search).get('mode');
const eventLog: unknown[] = [];
(window as unknown as { interviewEvents: unknown[] }).interviewEvents = eventLog;
let submissions = 0;
const snapshot = {
  session_id: "preview-session-0001",
  status: "AWAITING_USER",
  revision: 2,
  round: 1,
  goal: "验证 Grill Me Extended 问卷交互",
  decided_summary: ["使用服务端权威缓存", "每轮批量提问"],
  remaining_areas: ["目标平台", "离线策略", "补充约束"],
  questions: [
    {
      id: "platform", prompt: "首个版本应优先支持哪个平台？", kind: "single", required: true,
      options: [{ id: "desktop", label: "桌面端", description: "优先键盘效率与宽屏布局" }, { id: "mobile", label: "移动端", description: "优先触控与窄屏布局" }],
      recommendedOptionIds: ["desktop"], recommendationReason: "当前 Codex 工作流主要在桌面环境完成。", allowOther: true,
    },
    {
      id: "features", prompt: "本轮需要同时验证哪些能力？", kind: "multi", required: true,
      options: [{ id: "keyboard", label: "键盘操作" }, { id: "retry", label: "失败重试" }, { id: "theme", label: "深浅色模式" }],
      recommendedOptionIds: ["keyboard", "retry"], recommendationReason: "它们直接影响问卷可用性和答案安全。", allowOther: true,
    },
    {
      id: "constraint", prompt: "还有哪些必须保留的约束？", kind: "text", required: true,
      recommendedText: "写出一个可验收、可验证的约束。", recommendationReason: "自由文本能覆盖预设选项遗漏的边界。", allowOther: true,
    },
  ],
};

iframe.addEventListener("load", async () => {
  const bridge = new AppBridge(
    null,
    { name: "Grill Me Extended Test Host", version: "0.1.0" },
    { serverTools: {}, message: { text: {} } },
    { hostContext: { theme: "light", locale: "zh-CN", displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"], containerDimensions: { width: 900, maxHeight: 1200 } } },
  );
  bridge.oncalltool = async (params) => {
    eventLog.push(params);
    if (params.name === 'answers_submit' && (mode === 'stale' || mode === 'refresh')) return { isError: true, content: [{ type: 'text', text: 'revision conflict' }], structuredContent: { error: { code: 'REVISION_CONFLICT' } } };
    if (params.name === 'session_get' && mode === 'refresh') return { content: [{ type: 'text', text: 'Updated' }], structuredContent: { status: 'AWAITING_USER', revision: 4 } };
    if (params.name === 'questionnaire_render' && mode === 'refresh') return { content: [{ type: 'text', text: 'Refreshed' }], structuredContent: { status: 'AWAITING_USER', revision: 4 }, _meta: { 'grillMeExtended/questionnaire': { ...snapshot, revision: 4, round: 2 } } };
    if (params.name === 'answers_submit' && mode === 'retry' && submissions++ === 0) throw new Error('Simulated network failure');
    return { content: [{ type: 'text', text: 'Saved' }], structuredContent: { session_id: snapshot.session_id, status: 'SYNTHESIZING', revision: 3, round: 1 } };
  };
  bridge.onmessage = async () => { if (mode === 'messagefail') throw new Error('Host cannot continue'); return { isError: false }; };
  bridge.onrequestdisplaymode = async ({ mode }) => {
    iframe.classList.toggle("fullscreen", mode === "fullscreen");
    return { mode };
  };
  bridge.oninitialized = () => {
    void bridge.sendToolInput({ arguments: { session_id: snapshot.session_id } });
    void bridge.sendToolResult({
      content: [{ type: "text", text: "preview" }],
      structuredContent: { session_id: snapshot.session_id, status: snapshot.status, revision: snapshot.revision, round: snapshot.round },
      _meta: { "grillMeExtended/questionnaire": snapshot },
    });
  };
  await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
});
