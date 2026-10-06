# Grill Me Extended · ChatGPT MCP 问卷

在 ChatGPT 聊天内完成需求访谈、决策问卷、自我审核和计划下载。由当前 ChatGPT 负责提问、整理与审核；服务器不调用模型，不要求额外模型 API 密钥或 Codex 子代理。

这是原本本地 `grill-me-extended` 插件的云端适配版，保留原有访谈状态机、每轮 3–7 题、12 轮决策门槛、推荐不预选、修订冲突处理和三个交接文档。

## 工作方式

```text
ChatGPT 手机 App / 网页
  ├─ ChatGPT 提问与自审
  ├─ 聊天内 MCP Apps 问卷
  └─ HTTPS /mcp → Node 服务 → 持久磁盘
                                  └─ 计划.md / 进度.md / AGENTS.md
```

手机和网页使用同一远程服务。UI 使用标准 MCP Apps 桥接，不要求浏览器扩展。支持单选、多选、自由文本、其他补充、手机窄屏、触控、宿主深浅主题、全屏（宿主支持时）、草稿、暂停和恢复。

**可用性边界：**本地浏览器验证不等同于真实 ChatGPT 手机 App 验证。账户套餐、工作区策略及客户端功能会影响是否能添加和运行自定义 MCP。需要在目标账号的网页与手机分别完成下文验收。GitHub 只保存源码，GitHub Pages 不能运行这个后端。

## 本机体验（Node 22 或更新版本）

```sh
npm ci
npm run build
npm run dev
```

本机 MCP 地址为 `http://127.0.0.1:3000/mcp`；健康检查为 `/healthz`。无认证开发模式仅绑定 `127.0.0.1`，用于 MCP Inspector/本机调试，**不能作为公网服务**。开发模式临时生成下载签名密钥，重启后旧链接失效；可设置固定 DOWNLOAD_SECRET。

UI 预览：另一个终端运行 `npm run preview`，打开 `http://127.0.0.1:4173`。预览是模拟 MCP Apps 宿主，回答不会成为实际访谈数据。演示支持 `?mode=retry` 或 `?mode=messagefail` 检查网络失败与继续通知失败的交互。

## 正式部署：云主机 + Docker Compose

需要一台可运行 Docker 的 Linux 主机，以及指向该主机的域名。开放 80/443；应用端口 3000 不对外开放。保持**单进程、单副本**，因为会话锁在进程内；暂不支持多副本或多进程共享磁盘。

1. 把仓库复制到主机，复制 `.env.example` 为 `.env`。
2. 配置 `DOMAIN` 为域名，`PUBLIC_URL` 为对应的 HTTPS 根地址（无路径或查询参数）。
3. 在 GitHub → Settings → Developer settings → OAuth Apps → New OAuth App 创建应用：Homepage URL 填 PUBLIC_URL，Authorization callback URL 填 `PUBLIC_URL/oauth/github/callback`。
4. 将 GitHub OAuth 的 Client ID 和 Client Secret 填入 `.env`。这里的 Client Secret 是**GitHub OAuth 应用密钥，不是 GitHub PAT，更不是模型 API 密钥**。
5. `ALLOWED_GITHUB_LOGINS` 默认只允许 `SweetDumplingPorridge`。若允许多人使用，以逗号分隔。身份隔离使用不可变 GitHub 数字 ID；可修改的登录名只用于访问名单。
6. 生成 DOWNLOAD_SECRET：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

7. 填好所有变量后启动：

```sh
docker compose up -d --build
docker compose ps
```

Caddy 负责申请 HTTPS 证书并转发 MCP；初次申请要求域名解析和端口都正常。部署后检查 `https://你的域名/healthz`。不要启用含完整查询字符串的访问日志，因为下载 URL 包含短期授权签名。

## 使用托管容器平台

也可部署 Dockerfile 到已有云平台。设置容器端口 3000、健康检查 `/healthz`、HTTPS 域名和以上环境变量；给 `/app/data` 挂载**持久磁盘**，只运行一个副本。平台代理必须保留 Authorization 和 OAuth 路径。不要使用没有持久存储的临时实例，否则重启会丢失会话与授权。平台费用和域名由部署者自行管理。

## 添加到 ChatGPT

1. 服务上线后，在 ChatGPT 的 Plugins/应用设置中添加自定义 MCP 服务，填写 `https://你的域名/mcp`，认证选择 OAuth。具体入口取决于客户端和账户策略。
2. 首次连接打开授权页：查看客户端名称和回调地址，同意后用允许的 GitHub 账号登录。服务器支持动态客户端注册、PKCE S256、资源绑定、令牌刷新与撤销。
3. 启用该应用，在新聊天中选择它，并发送：

> 请用 Grill Me Extended 帮我澄清这个项目，先显示决策问卷，完成后审核并生成计划。

4. 问卷填写后点击“提交本轮”。若宿主不能自动发送继续消息，界面会提示在聊天中发送“继续 Grill Me Extended 会话 …”；答案已经保存。
5. 完成后下载 `计划.md`、`进度.md`、`AGENTS.md`。下载链接 15 分钟有效，过期后请求重新获取文档。
6. 修改服务工具或 UI 后，在 ChatGPT 刷新连接元数据并开新聊天验证。

网页配置完成后，在同一账号的手机 App 中验证应用是否可选、问卷是否显示和答案是否能提交。如果宿主不能渲染 UI，ChatGPT 可调用 `questionnaire_render(text_fallback=true)` 展示文本问卷并通过 `answers_submit` 保存答案。如果手机客户端连 MCP 调用都不开放，文本回退不能绕过平台限制。

官方参考：[MCP 与 UI](https://developers.openai.com/plugins/build/app-quickstart)、[ChatGPT 接入](https://developers.openai.com/plugins/deploy/connect-chatgpt)、[认证](https://developers.openai.com/plugins/build/auth)。

## 权限、存储与恢复

- 所有生产 MCP 请求都校验 OAuth token；未登录请求返回 401 与标准发现信息。
- 每个身份拥有独立目录；知道别人的 session_id 不能读取其会话。远程客户端不能指定服务器文件路径，也不能写用户电脑。
- 下载链接是短期授权凭据，持有者在有效期内可下载对应文件；只分享给需要文档的人。链接绑定用户、会话、文件名和过期时间。
- 数据卷保存访谈 JSON、事件日志、候选与三个导出文档。OAuth tokens 保存哈希，GitHub 上游令牌仅用于登录确认，不保存在卷中。动态 OAuth 客户端信息也保存在卷中。
- 服务无全局会话列表。恢复时需在原聊天中提供 session_id；可以从问卷暂停提示复制。
- 服务不会自动删除历史数据。删除某个会话：停止 app，备份卷，删除对应 `users/<owner-hash>/sessions/<session_id>`，再启动。撤销整个连接可使用标准 `/revoke` 端点；移除登录名单不会自动撤销已发令牌，要立即撤销可停服并删除备份后的 `oauth.json`（所有用户需要重新连接）。
- 不要删除 `interview_data` 卷。更新前停止 app 后备份卷；恢复时保留 `.env` 与 DOWNLOAD_SECRET，否则旧链接失效。`docker compose down` 保留卷，`docker compose down -v` 会删除数据。
- 服务的鉴权与状态隔离有自动化测试；生产使用 GitHub 的真实登录流程仍需在实际部署域名完成联调。

## 测试与打包

```sh
npm run validate
npm audit --audit-level=moderate
npx playwright install chromium
npm run test:ui
npm run package
```

Windows 可复用本机 Chrome：设置 `CHROME_PATH` 为 Chrome 可执行文件绝对路径，再运行 UI 测试。CI 在 Linux 上运行测试、构建 Docker 并上传源代码包。

自动测试覆盖完整 stdio/HTTP 采访、拒绝客户端路径、身份隔离、重启恢复、答案幂等、修订冲突、12 轮门槛、文件冲突备份、OAuth 所有者校验、授权码绑定、刷新/撤销、签名下载、320/390/1280 宽度与提交失败恢复。

**真实 ChatGPT 验收清单：**网页添加并登录；新访谈完成一轮；手机同账号打开问卷并提交；暂停后恢复；自审退回后继续追问；三个文件能下载；服务重启后恢复；断开连接后重新登录。这些需要目标账户与真实部署，不能用本地模拟测试替代。

## 可选：本地 Codex 插件

`skills/grill-me-extended` 是当前 ChatGPT 自己采访与自审的适配协议。`.codex-plugin/plugin.json` 可供支持本地插件的宿主使用。先运行 `node scripts/configure-connection.mjs https://你的域名/mcp` 生成本地 `.mcp.json`，再按宿主安装插件。ChatGPT 手机和网页通过上面的应用设置接入，不需要这个文件。

原本 stdio 服务仍可用：`node server/dist/index.mjs`，`session_start_or_resume` 需提供本地 workspace 绝对路径。本地模式会写入该 workspace，原有文件冲突确认与备份逻辑继续有效。
# 无服务器聊天插件版

新增独立的 `plugins/grill-me-extended-chat/`，使用根目录 `plugin.json` 的 Agent Plugins 格式。运行 `npm run package:chat` 可生成上传包和普通聊天流程附件。安装入口、平台检查、功能差异与验收场景见 [聊天插件说明](plugins/grill-me-extended-chat/README.md)。

这个版本由当前 ChatGPT 直接采访和自审，使用聊天问答与检查点恢复。原 MCP 版保留完整问卷 GUI 与服务端存储，仍需部署。普通聊天上传 ZIP 不等于插件安装。
