# 后端 API 与 Gateway 契约 / Backend API and Gateway Contract

## 中文

本文描述 RenrenCodex Desktop 当前使用的客户端侧协议，供实现自有后端、授权站点和 WebSocket
Gateway 时参考。本仓库只提供客户端 SDK 与共享契约；服务端必须自行实现身份、租户隔离、资源调度、
持久化和机器代理通信。

接口的代码级事实来源：

- HTTP SDK：`packages/api-client/src/client.ts`
- REST DTO：`packages/api-client/src/types.ts`
- Desktop OAuth：`packages/api-client/src/desktop-oauth.ts`
- Gateway/文件契约：`packages/client-contracts/src`
- 客户端 WebSocket 状态机：`packages/native-client-ui/src/lib`、`packages/workspace-ui/src`

### 1. 服务地址

客户端使用三个独立基础地址：

| 配置                  | 示例                                | 用途                              |
| --------------------- | ----------------------------------- | --------------------------------- |
| `VITE_API_BASE_URL`   | `https://api.example.com`           | `/api/v1` JSON API                |
| `VITE_WEB_BASE_URL`   | `https://app.example.com`           | 浏览器登录与 `/desktop/authorize` |
| `VITE_GATEWAY_WS_URL` | `wss://gateway.example.com/gateway` | 终端、RPC、文件流和监听           |

生产环境必须使用 HTTPS/WSS。本地开发只接受成套的 localhost HTTP/WS 地址。自定义域名还需要更新
客户端原生 URL 白名单和 CSP，见[专属客户端改造指南](customization.md)。

### 2. HTTP 通用规则

- API 路径以 `/api/v1` 开头，JSON 请求使用 `Content-Type: application/json`。
- 已登录请求使用 `Authorization: Bearer <access-token>`。
- Desktop access token 仅保存在内存；refresh token 仅保存在操作系统安全存储。
- Desktop token、refresh 和 revoke 请求不依赖 Cookie，客户端使用 `credentials: omit`。
- 所有非 `GET`/`HEAD`/`OPTIONS` 请求自动携带 `x-requested-with: fetch`。
- 需要幂等的操作携带 `idempotency-key`；同一 key、同一主体和同一操作应返回同一业务结果。
- 成功且无响应体时返回 `204 No Content`，其他成功响应返回 JSON。
- 资源 ID 放入路径前会经过 `encodeURIComponent`，服务端必须按单个路径段解码。

标准错误体：

```json
{
  "error": {
    "code": "MACHINE_NOT_FOUND",
    "message": "Machine not found"
  }
}
```

客户端把它映射为 `ApiError { status, code, message }`。非 JSON 网关错误仍按 HTTP 状态处理。若普通
请求返回 `401`，客户端最多执行一次 refresh 并重放原请求；refresh/revoke/token 接口本身不能触发
递归 refresh。

服务端必须从已验证的 token/session 推导用户与租户，不能信任请求体或 query 中的 `userId`、租户 ID、
集群 ID 或资源所有者字段。

### 3. Desktop 浏览器授权与 PKCE

固定流程如下：

1. 客户端生成随机 `state`、`code_verifier` 和 S256 `code_challenge`。
2. 系统浏览器打开 `VITE_WEB_BASE_URL/desktop/authorize`，携带
   `response_type=code`、`client_id`、`redirect_uri`、`code_challenge_method=S256`、
   `code_challenge`、`state` 和 `device_name`。
3. Web 授权页要求用户登录并确认，然后以已认证会话调用授权码接口。
4. 服务端创建一次性、五分钟有效的授权码，浏览器跳转到桌面深链接
   `<scheme>://oauth/callback?code=...&state=...`。
5. Desktop 精确核对 scheme、host、path、参数数量和 `state`，再用 verifier 换取 token。
6. 服务端轮换 refresh token；旧 token 在成功 refresh 后立即失效。

#### 创建授权码

```http
POST /api/v1/auth/desktop/authorization-codes
Authorization: Bearer <web-access-token>
Content-Type: application/json
X-Requested-With: fetch
```

```json
{
  "clientId": "your-desktop-client",
  "redirectUri": "yourclient://oauth/callback",
  "codeChallenge": "43-character-base64url-value",
  "codeChallengeMethod": "S256",
  "deviceName": "Your Client (macOS)"
}
```

```json
{
  "authorizationCode": "43-character-single-use-code",
  "expiresInSeconds": 300
}
```

#### 换取、刷新和撤销 token

| 方法   | 路径                           | 请求体                                                                      |
| ------ | ------------------------------ | --------------------------------------------------------------------------- |
| `POST` | `/api/v1/auth/desktop/token`   | `grantType`, `clientId`, `redirectUri`, `authorizationCode`, `codeVerifier` |
| `POST` | `/api/v1/auth/desktop/refresh` | `{ "refreshToken": "..." }`                                                 |
| `POST` | `/api/v1/auth/desktop/revoke`  | `{ "refreshToken": "..." }`                                                 |
| `GET`  | `/api/v1/auth/me`              | 无；需要 Bearer token                                                       |

Token 响应：

```json
{
  "accessToken": "short-lived-access-token",
  "refreshToken": "43-character-rotating-token",
  "tokenType": "Bearer",
  "expiresInSeconds": 900
}
```

自定义客户端必须同时修改客户端 ID、回调 URI、Tauri scheme 和服务端注册；不要只放宽服务端回调 URL
匹配。

### 4. 核心 REST API

下面列出桌面核心界面使用的接口。完整输入/输出字段请直接复用 `packages/api-client` 和
`packages/client-contracts` 中的 TypeScript/Zod 类型。

#### 目录与云电脑

| 方法        | 路径                                      | 说明                         |
| ----------- | ----------------------------------------- | ---------------------------- |
| `GET`       | `/api/v1/public/plans`                    | 无认证公开套餐目录           |
| `GET`       | `/api/v1/plans`                           | 当前账号可用套餐             |
| `GET`       | `/api/v1/machine-images?planId=...`       | 可用系统镜像                 |
| `GET`       | `/api/v1/egress-lines`                    | 可用出口线路                 |
| `GET`       | `/api/v1/machines`                        | 列出当前账号云电脑           |
| `POST`      | `/api/v1/machines`                        | 创建云电脑；建议要求幂等 key |
| `GET`       | `/api/v1/machines/:id`                    | 获取云电脑                   |
| `PATCH`     | `/api/v1/machines/:id`                    | 更新名称等可变属性           |
| `DELETE`    | `/api/v1/machines/:id`                    | 使用 `deletionQuoteId` 删除  |
| `POST`      | `/api/v1/machines/:id/start`              | 开机                         |
| `POST`      | `/api/v1/machines/:id/stop`               | 关机                         |
| `POST`      | `/api/v1/machines/:id/reboot`             | 重启                         |
| `POST`      | `/api/v1/machines/:id/rebuild`            | 重建系统                     |
| `POST`      | `/api/v1/machines/:id/deletion-quote`     | 获取删除/退款报价            |
| `GET`       | `/api/v1/machines/:id/connection`         | Agent/Gateway 在线状态       |
| `GET`       | `/api/v1/machines/:id/provisioning`       | 创建进度与失败恢复动作       |
| `POST`      | `/api/v1/machines/:id/provisioning/retry` | 幂等重试履约                 |
| `GET`       | `/api/v1/machines/:id/events`             | `limit`/`before` 游标事件流  |
| `GET/PATCH` | `/api/v1/machines/:id/subscription`       | 订阅与自动续费               |
| `PUT`       | `/api/v1/machines/:id/egress-line`        | 幂等切换出口线路             |

#### 工作区与布局

| 方法               | 路径                                                       | 说明                                |
| ------------------ | ---------------------------------------------------------- | ----------------------------------- |
| `GET/POST`         | `/api/v1/machines/:machineId/workspaces`                   | 列表/创建工作区                     |
| `GET/PATCH/DELETE` | `/api/v1/workspaces/:workspaceId`                          | 读取、改名、删除工作区              |
| `GET`              | `/api/v1/workspaces/:workspaceId/status`                   | 检查磁盘目录和运行状态              |
| `GET`              | `/api/v1/workspaces/:workspaceId/diff`                     | 工作区变更摘要                      |
| `GET`              | `/api/v1/workspaces/:workspaceId/diff/file`                | 单文件 diff，query 使用文件定位字段 |
| `GET/PUT`          | `/api/v1/workspaces/:workspaceId/workbench-layout`         | 获取/保存工作台布局                 |
| `POST`             | `/api/v1/machines/:machineId/workspace-git-imports`        | 幂等启动 Git 导入                   |
| `GET`              | `/api/v1/machines/:machineId/workspace-git-imports/active` | 当前导入任务                        |
| `GET/DELETE`       | `/api/v1/workspace-git-imports/:operationId`               | 查询/取消导入任务                   |

#### 端口、快照、CLI 与救援

| 方法         | 路径                                                    | 说明                           |
| ------------ | ------------------------------------------------------- | ------------------------------ |
| `GET`        | `/api/v1/machines/:id/ports`                            | 端口列表                       |
| `PUT`        | `/api/v1/machines/:id/ports/:port/visibility`           | 设置 `private`/`public` 可见性 |
| `GET`        | `/api/v1/machines/:id/ports/shares`                     | 分享列表                       |
| `POST`       | `/api/v1/machines/:id/ports/:port/shares`               | 创建分享                       |
| `DELETE`     | `/api/v1/machines/:id/ports/:port/shares/:shareId`      | 撤销分享                       |
| `GET/POST`   | `/api/v1/machines/:id/snapshots`                        | 列表/创建快照                  |
| `POST`       | `/api/v1/machines/:id/snapshots/:snapshotId/restore`    | 恢复快照                       |
| `DELETE`     | `/api/v1/machines/:id/snapshots/:snapshotId`            | 删除快照                       |
| `GET`        | `/api/v1/cli-store/apps`                                | CLI 应用目录                   |
| `GET`        | `/api/v1/machines/:id/cli-apps`                         | 已安装 CLI                     |
| `POST`       | `/api/v1/machines/:id/cli-apps/operations`              | 幂等安装/升级/卸载             |
| `GET/DELETE` | `/api/v1/machines/:id/cli-apps/operations/:operationId` | 查询/取消操作                  |
| `POST`       | `/api/v1/machines/:id/rescue-sessions`                  | 幂等创建短期救援会话           |
| `DELETE`     | `/api/v1/machines/:id/rescue-sessions/:sessionId`       | 关闭救援会话                   |

#### 可选账号与商业功能

客户端还定义了账号配额、试用、钱包、通知、用量、订单、充值、续费、支付和推广相关接口。若启用
这些界面，应实现 `client.ts` 中 `account`、`orders` 和 `account.referrals` 的完整契约；若不启用，应从
客户端导航和查询中移除，而不是返回伪造成功结果。

### 5. 一次性连接票据

所有普通 Gateway 通道先通过 API 取票：

```http
POST /api/v1/machines/:id/connection-tickets
Authorization: Bearer <access-token>
Idempotency-Key: <uuid>
Content-Type: application/json
X-Requested-With: fetch
```

```json
{ "channel": "terminal" }
```

`channel` 只能是：

```text
terminal | rpc | upload | download | search | watch
```

响应：

```json
{
  "ticket": "43-character-base64url-ticket",
  "expiresAt": "2026-11-17T00:00:00.000Z"
}
```

票据应由服务端绑定到用户、租户、机器和单一 channel，短时有效且只能消费一次。Gateway 必须在升级
WebSocket 前原子消费票据，拒绝把 access token 直接放进 WebSocket query。

### 6. Gateway WebSocket

在 `VITE_GATEWAY_WS_URL` 后追加以下路径：

| Channel    | 路径                                | 数据用途                       |
| ---------- | ----------------------------------- | ------------------------------ |
| `terminal` | `/machines/:id/terminal?ticket=...` | 交互终端、多终端会话与滚动历史 |
| `rpc`      | `/machines/:id/rpc?ticket=...`      | `system.*` 与 `fs.*` JSON RPC  |
| `upload`   | `/machines/:id/upload?ticket=...`   | 文件上传控制帧与二进制帧       |
| `download` | `/machines/:id/download?ticket=...` | 文件/目录下载控制帧与二进制帧  |
| `search`   | `/machines/:id/search?ticket=...`   | 工作区全文搜索与取消           |
| `watch`    | `/machines/:id/watch?ticket=...`    | 文件变化失效通知               |

救援终端使用 API 返回的独立 ticket：

```text
/machines/:id/rescue/:sessionId?ticket=...
```

#### RPC 信封

客户端请求：

```json
{ "id": "c1", "method": "fs.list", "params": { "path": "/workspace" } }
```

成功响应：

```json
{ "id": "c1", "ok": true, "result": { "entries": [] } }
```

错误响应：

```json
{
  "id": "c1",
  "ok": false,
  "error": { "code": "FS_FORBIDDEN", "message": "Path is outside the workspace" }
}
```

客户端可见的 RPC 方法为：`system.info`、`system.metrics`、`fs.stat`、`fs.resolve`、`fs.list`、
`fs.read`、`fs.write`、`fs.mkdir`、`fs.rename`、`fs.remove`。参数、结果、块大小、二进制帧头、背压、
ACK 和错误码必须复用 `packages/client-contracts/src/cmp.ts`；不要根据本文重新手写另一套协议。

### 7. CORS、代理和安全清单

- 仅允许你的桌面 WebView Origin、授权站点和必要管理端 Origin；不要返回任意 `*` 加凭据。
- 允许 `Authorization`、`Content-Type`、`X-Requested-With`、`Idempotency-Key` 请求头。
- WebSocket 代理必须支持 Upgrade、长连接、二进制帧和合理的 payload/idle 限制。
- Gateway 只接受 API 签发的一次性票据，不直接信任客户端指定的用户或机器归属。
- 对创建、支付、重试、取票、Git 导入和 CLI 操作执行服务端幂等。
- 对文件路径做规范化和工作区沙箱校验，拒绝符号链接逃逸、`..` 穿越和超限负载。
- access/refresh token、连接票据、预览分享凭据和支付参数不得进入日志。
- 对 401/403、网络断开、重复请求和 refresh 轮换竞态编写集成测试。

## English

This document describes the client-facing protocol used by RenrenCodex Desktop. It is intended for
developers implementing their own backend, authorization website, and WebSocket Gateway. The
repository contains the client SDK and shared contracts, not server-side identity, tenancy,
scheduling, persistence, or machine-agent implementations.

Use these code-level sources of truth:

- `packages/api-client/src/client.ts` for HTTP behavior and paths;
- `packages/api-client/src/types.ts` for REST DTOs;
- `packages/api-client/src/desktop-oauth.ts` for Desktop OAuth;
- `packages/client-contracts/src` for Gateway and file contracts; and
- `packages/native-client-ui/src/lib` plus `packages/workspace-ui/src` for WebSocket state machines.

### Service origins and HTTP behavior

Configure an API origin (`VITE_API_BASE_URL`), a browser authorization origin
(`VITE_WEB_BASE_URL`), and a WebSocket origin (`VITE_GATEWAY_WS_URL`). Production requires
HTTPS/WSS. API routes live under `/api/v1`.

Authenticated calls use `Authorization: Bearer <access-token>`. Desktop access tokens remain in
memory and rotating refresh tokens remain in operating-system secure storage. Native token flows
do not use cookies. Every unsafe HTTP method includes `X-Requested-With: fetch`; selected write
operations also require `Idempotency-Key`.

Successful empty responses use `204`. Other successful responses use JSON. Errors use:

```json
{ "error": { "code": "ERROR_CODE", "message": "Human-readable message" } }
```

The client performs at most one refresh and replay after an ordinary `401`. Token, refresh, and
revoke calls must not recursively refresh. Derive users, tenants, and resource ownership from the
verified server-side identity context; never trust a client-supplied `userId` as authorization.

### Desktop authorization

The system browser opens `/desktop/authorize` with OAuth-style parameters, a random `state`, and a
PKCE S256 challenge. An authenticated web session creates a single-use, five-minute code through
`POST /api/v1/auth/desktop/authorization-codes`, then redirects to the registered desktop deep
link. Desktop validates the callback and exchanges the code through
`POST /api/v1/auth/desktop/token`.

Use `POST /api/v1/auth/desktop/refresh` to rotate refresh tokens,
`POST /api/v1/auth/desktop/revoke` to revoke them, and `GET /api/v1/auth/me` to load the current
user. The request and response examples in the Chinese section above are normative for the current
client. A custom brand must update the client ID, callback URI, Tauri scheme, native validation,
and server registration together.

### REST surface

The current Desktop UI uses the endpoint groups listed above:

- catalogs and machines: plans, images, egress lines, machine lifecycle, provisioning,
  subscriptions, events, deletion quotes, and connection status;
- workspaces: CRUD, runtime status, diffs, Git imports, and workbench layouts;
- ports, shares, snapshots, CLI catalog operations, and rescue sessions; and
- optional account, wallet, notification, billing, order, payment, trial, and referral features.

Reuse the TypeScript and Zod contracts instead of duplicating DTOs. If a custom backend omits an
optional capability, remove the corresponding client routes and queries.

### One-time tickets and WebSockets

Create a ticket with `POST /api/v1/machines/:id/connection-tickets` and one of these channel names:

```text
terminal | rpc | upload | download | search | watch
```

Bind every short-lived ticket to the authenticated user, tenant, machine, and exactly one channel,
then consume it atomically during WebSocket upgrade. Never place the access token directly in a
WebSocket query string.

Gateway paths are:

```text
/machines/:id/terminal?ticket=...
/machines/:id/rpc?ticket=...
/machines/:id/upload?ticket=...
/machines/:id/download?ticket=...
/machines/:id/search?ticket=...
/machines/:id/watch?ticket=...
/machines/:id/rescue/:sessionId?ticket=...
```

RPC messages use `{ id, method, params }` requests and either `{ id, ok: true, result }` or
`{ id, ok: false, error: { code, message } }` responses. The allowed client methods are
`system.info`, `system.metrics`, `fs.stat`, `fs.resolve`, `fs.list`, `fs.read`, `fs.write`,
`fs.mkdir`, `fs.rename`, and `fs.remove`. Treat `packages/client-contracts/src/cmp.ts` as the
normative definition for schemas, limits, binary frames, backpressure, acknowledgements, and error
codes.

### Security checklist

- Allow only the required WebView and web origins; do not combine credentialed CORS with `*`.
- Permit the required authorization, JSON, CSRF, and idempotency headers.
- Support WebSocket upgrades, binary frames, long-lived connections, and bounded payloads/timeouts.
- Normalize and sandbox file paths; reject traversal, symlink escape, and oversized payloads.
- Keep tokens, tickets, preview credentials, and payment parameters out of logs.
- Test 401/403 handling, disconnects, retries, duplicate writes, and refresh-token rotation races.
