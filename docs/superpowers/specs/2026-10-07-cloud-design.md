# Grill Me Extended 云端设计

用户已确认：ChatGPT 自己采访和审核；云端正式部署，本机保留测试方式。

## 目标与边界
将已有本地 TypeScript MCP 服务改为 ChatGPT 可连接的 Streamable HTTP 服务，提供标准 MCP Apps 问卷、持久会话、文档下载。服务器不调用模型，不需要模型 API 密钥。不承诺宿主账户未开放的功能；实际手机与网页 ChatGPT 连接需要用户账户验证。

## 组件与数据
- server/src/index.ts 导出服务工厂，继续支持 stdio。
- server/src/http.ts 提供 /mcp、OAuth 发现、GitHub 登录、健康检查及短期签名下载链接。
- server/src/auth.ts 使用 MCP SDK OAuth 路由完成 DCR、PKCE、授权码、刷新与撤销；GitHub OAuth 确认真实用户身份。ALLOWED_GITHUB_LOGINS 默认配置为部署者账号，不开放匿名访问。
- server/src/remote.ts 将身份映射到独立数据根目录，会话工作区由服务器分配，拒绝客户端指定服务器目录。
- 复用 SessionStore 与 DocumentMaterializer。所有同一用户的请求共享 SessionStore 的锁；单进程、单副本、持久磁盘部署。
- 问卷采用 MCP Apps 桥接，支持触摸、键盘、320px 窄屏、宽屏、宿主主题、暂停和恢复；答案提交成功后通知 ChatGPT 继续。

## 采访协议
每轮 3–7 题，推荐不预选，支持其他补充。ChatGPT 保存问题后打开问卷，提交后重新读取服务端状态；候选计划包含原规范的 13 个部分，ChatGPT 按审阅量表自审，失败退回追问。保留 12 轮上限及用户明确继续的门槛。工具和服务说明直接传递协议，不依赖用户本机技能安装。

## 恢复与权限
revision 冲突必须重读；提交使用稳定幂等键。失败不丢表单。各身份只能访问自己的会话，远程导出只写会话独立目录。OAuth 客户端和令牌持久保存；令牌只存哈希。下载链接是 15 分钟有效的 bearer capability，不写日志、不进入 Git。生产强制 HTTPS、OAuth 和固定下载签名密钥；无认证仅限绑定 127.0.0.1 的本机开发。

## 交付和验收
提供 Dockerfile、Compose+Caddy、环境配置模板、中文 README、安装包、测试与 CI。验证已有回归、HTTP 全流程、身份隔离、持久恢复、下载签名过期、OAuth PKCE/刷新/撤销、320/390/1280 宽度问卷。GitHub 按用户确认公开；无云端凭据时交付可部署包并明确尚未上线。
