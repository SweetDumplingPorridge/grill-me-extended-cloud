# Grill Me Extended Chat：无服务器插件包

本包是官方 Agent Plugins 格式：根目录 plugin.json、skills/、assets/。没有 MCP 配置，不依赖远程地址或本机路径。当前 ChatGPT 自己采访、写计划并自审。

## 安装入口与边界

- 官方 ZIP 上传入口是开发者平台的 Plugins 页面（https://platform.openai.com/plugins），选择 Upload new or existing plugin。上传会生成草稿并验证；公开目录使用还涉及开发者身份验证、检查、审核和发布，不保证上传即启用。
- ChatGPT Plugins 页面用于安装账号可用的插件；安装后开新聊天，通过 @ 或明确要求使用 Grill Me Extended 发起访谈。账号和工作区是否提供私人包导入入口需要实际查看，本包没有验证你的账号入口。
- 把 ZIP 作为普通聊天附件上传不会自动安装插件。若只想在某个聊天立即访谈，上传另附的 Grill-Me-Extended-Chat.md，并发送：“请阅读附件并按其中的访谈流程执行，由你自己采访和自审。我的目标是：……”。这只对该对话作为用户提供的流程生效。
- 已安装且账号可用的插件可在支持它的网页和手机 ChatGPT 中使用；未测试你的实际账号和手机端。

## 与原 MCP 版的区别

保留分轮提问、建议与补充选项、关键决策台账、12 轮门槛、计划自审、三份交接文档。使用聊天回答；暂停或跨聊天恢复用可复制检查点。没有可点击的 MCP 问卷或服务端持久化。真实下载文件取决于聊天是否有文件创建能力，否则提供完整 Markdown。

原项目的远程 MCP、响应式 GUI、OAuth 和独立存储仍在仓库中。要使用这些功能需部署服务并连接公网 HTTPS 地址；插件 ZIP 不托管代码。独立聊天版使用单独标识 grill-me-extended-chat，不与原 MCP 版本混用。

官方依据：
- https://developers.openai.com/plugins/build/plugins
- https://developers.openai.com/plugins/deploy/submission
- https://learn.chatgpt.com/docs/plugins

## 验证场景

1. “拷问我，做一个记账工具”：先问关键范围与约束，不直接写实现。
2. 一轮只回答两个问题：保留未答项，建议不视为同意。
3. “暂停”：停止提问并交付检查点；新聊天附检查点可恢复已知内容。
4. 到第 12 轮仍有争议：明确询问继续或带风险结束，不自动替用户选择。
5. “给我三份文件”但宿主无文件能力：提供完整文本，不伪造链接。
6. 自审发现验收标准不可执行：说明缺口，聚焦补问并修订。

包结构和引用已本地核查；以上是待在真实宿主验收的行为场景，不宣称已通过模型或平台扫描。
