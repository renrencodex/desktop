# 专属客户端改造指南 / Custom Client Guide

## 中文

RenrenCodex Desktop 可以作为团队专属云开发客户端、企业工作台或远程开发客户端的基础。MIT
许可证允许修改和分发源代码；本文描述的官方支持方式是保留人人Codex平台连接契约，并由分发者维护
自己的产品标识、更新渠道、代码签名和发行安全边界。

### 1. 品牌与应用身份

至少检查以下位置：

- `apps/desktop/src-tauri/tauri.conf.json`：`productName`、`identifier`、窗口标题、图标和深链接；
- `apps/desktop/src-tauri/tauri.windows.conf.json` 与 `apps/desktop/src-tauri/wix`：Windows
  安装器名称和文案；
- `apps/desktop/src-tauri/icons`：各平台应用图标；
- `apps/desktop/src/main.tsx` 与 `packages/native-client-ui/src`：界面名称、Logo、帮助链接和产品文案；
- `apps/desktop/package.json`：应用版本；
- 安装包文件名、GitHub Actions 工作流和发布说明。

使用新的反向域名应用标识，例如 `com.yourcompany.desktop`。不要让第三方构建继续使用官方应用标识、
更新密钥或让用户误认为它是官方发行版。RenrenCodex/人人Codex 品牌使用规则见
`TRADEMARKS.md`。

### 2. API、Web 与 Gateway 地址

官方生产构建固定使用：

```dotenv
VITE_API_BASE_URL=https://renrencodex.com
VITE_WEB_BASE_URL=https://renrencodex.com
VITE_GATEWAY_WS_URL=wss://renrencodex.com/gateway
```

API 与 Web 授权共用 `https://renrencodex.com`，Gateway 通过同一官方域名下的 `/gateway`
WebSocket 入口提供终端、RPC、文件流和监听。定制客户端连接人人Codex平台时必须保留这三个正式值。

人人Codex平台本地联调使用：

```dotenv
VITE_API_BASE_URL=http://localhost:3000
VITE_WEB_BASE_URL=http://localhost:5173
VITE_GATEWAY_WS_URL=ws://localhost:7444
```

`apps/desktop/src/config.ts`、Tauri `connect-src` CSP、Rust URL 白名单和正式构建工作流共同约束这些
平台地址。不要为了方便改成任意 `https:`、任意子域或关闭 CSP；否则恶意 URL、开放重定向或被接管
子域可能获得原生客户端能力。第三方发行版自己的更新地址与制品白名单单独按第 5 节配置，不能借此
放宽平台连接范围。

### 3. OAuth 与深链接

Desktop 使用浏览器授权和 PKCE S256。人人Codex平台当前只接受以下固定客户端身份：

```text
client_id: renrencodex-desktop
redirect_uri: renrencodex://oauth/callback
```

定制客户端连接人人Codex平台时必须保留这两个值，并保持 Tauri 深链接 scheme、Native 回调校验和
`packages/api-client/src/desktop-oauth.ts` 一致。不要自行更换 Client ID、回调 URI，或放宽回调 URL
匹配；新增客户端身份需要先成为平台契约的一部分。继续保留 `state`、单次授权码、五分钟过期和 PKCE
verifier 校验。Refresh token 只能存入系统安全存储，不能写入 localStorage、日志或 URL。

操作系统按 URL scheme 分派深链接，不能保证多个应用注册同一 `renrencodex://` scheme 时将回调交给
发起登录的应用。因此，当前定制发行版不保证与官方客户端同时安装后仍能正常登录；PKCE 可以阻止错误
应用兑换授权码，但不能避免回调错投导致的登录失败。需要并存时，必须先由平台增加独立 Client ID 和
回调 URI，再同步更新客户端契约，不能只在本地更换 scheme。

### 4. 平台能力

完整接口见[人人Codex平台 API 与 Gateway 客户端契约](backend-api.md)。定制客户端可以隐藏计费、
推广、CLI 商店或救援终端等界面；隐藏功能时应同时移除对应导航、路由和查询，不能改写接口地址或
伪造平台响应。

客户端把访问令牌放在内存中，并通过平台签发的一次性连接票据访问 Gateway。人人Codex服务端从
已验证的身份上下文确定租户和资源权限，不接受客户端提交的 `userId` 作为授权依据。

### 5. 更新与代码签名

自定义发行版必须生成自己的 Tauri Updater 密钥对：

- 公钥可以嵌入客户端；
- 私钥和密码只放在受保护的 CI Secret 或离线签名环境；
- 更新清单与制品地址必须使用你的 HTTPS 域名；
- 发布版本必须单调递增，制品签名必须与清单完全匹配；
- 绝不能提交私钥、PFX、P8、密码或完整凭据。

Tauri 更新签名不等于操作系统信任。公开分发时应另行配置 Windows Authenticode/RFC 3161 时间戳、
Apple Developer ID/公证/staple，以及适用的 Linux 包或仓库签名。

### 6. 改造检查清单

- [ ] 名称、图标、应用标识、窗口和安装器文案已替换；
- [ ] API、Web、Gateway 和预览使用人人Codex官方地址；
- [ ] CSP 与 Rust URL 白名单未放宽平台 Origin；
- [ ] OAuth 使用 `renrencodex-desktop` 与 `renrencodex://oauth/callback`；
- [ ] 已向用户说明定制版与官方客户端的深链接共存限制；
- [ ] 启用的界面严格使用已发布的 REST 与 WebSocket 客户端契约；
- [ ] Updater 使用独立密钥，生产私钥未进入源码或构建日志；
- [ ] 已运行 TypeScript、Rust、测试和平台安装包检查；
- [ ] 已核对 MIT、第三方许可证和你自己的品牌/隐私条款。

## English

RenrenCodex Desktop can be the foundation of a team-specific cloud development client, enterprise
workspace, or remote development client. The MIT License permits modification and distribution.
The officially supported model in this guide retains the RenrenCodex platform connection contract
while distributors maintain their own product identity, update channel, code signing, and release
security boundaries.

### 1. Branding and application identity

Review at least these locations:

- `apps/desktop/src-tauri/tauri.conf.json` for `productName`, `identifier`, window titles, icons,
  and deep links;
- `apps/desktop/src-tauri/tauri.windows.conf.json` and `apps/desktop/src-tauri/wix` for Windows
  installer names and copy;
- `apps/desktop/src-tauri/icons` for platform icons;
- `apps/desktop/src/main.tsx` and `packages/native-client-ui/src` for names, logos, help links, and
  product copy;
- `apps/desktop/package.json` for the application version; and
- artifact names, GitHub Actions workflows, and release notes.

Use a new reverse-domain identifier such as `com.yourcompany.desktop`. Third-party builds must not
reuse an official application identifier or updater key, or imply that they are official releases.
See `TRADEMARKS.md` for the RenrenCodex/人人Codex brand rules.

### 2. API, web, and Gateway origins

Official production builds use these fixed origins:

```dotenv
VITE_API_BASE_URL=https://renrencodex.com
VITE_WEB_BASE_URL=https://renrencodex.com
VITE_GATEWAY_WS_URL=wss://renrencodex.com/gateway
```

The API and browser authorization page share `https://renrencodex.com`. The Gateway uses the
`/gateway` WebSocket entry point on the same official domain for terminals, RPC, file streams, and
watching. A customized client that connects to the RenrenCodex platform must retain all three
production values.

Local RenrenCodex platform development uses:

```dotenv
VITE_API_BASE_URL=http://localhost:3000
VITE_WEB_BASE_URL=http://localhost:5173
VITE_GATEWAY_WS_URL=ws://localhost:7444
```

Production-origin validation in `apps/desktop/src/config.ts`, the Tauri `connect-src` CSP, Rust URL
allowlists, and release workflows jointly enforce these platform origins. Do not replace them with
arbitrary `https:`, arbitrary subdomains, or a disabled CSP. A malicious URL, open redirect, or
abandoned subdomain could otherwise gain access to native client capabilities. Configure a
third-party distribution's own update URL and artifact allowlist separately as described in
section 5; do not use them to widen the platform connection boundary.

### 3. OAuth and deep links

Desktop authorization uses the system browser and PKCE S256. The RenrenCodex platform currently
accepts only this fixed client identity:

```text
client_id: renrencodex-desktop
redirect_uri: renrencodex://oauth/callback
```

A customized client that connects to the RenrenCodex platform must retain both values and keep the
Tauri deep-link scheme, native callback validation, and
`packages/api-client/src/desktop-oauth.ts` consistent. Do not invent another client ID or callback
URI, or loosen callback matching; a new client identity must first become part of the platform
contract. Preserve `state`, single-use authorization codes, the five-minute expiry, and PKCE
verifier validation. Refresh tokens belong only in operating-system secure storage, never
localStorage, logs, or URLs.

Operating systems dispatch deep links by URL scheme and cannot guarantee that a callback reaches
the application that initiated sign-in when multiple applications register the same
`renrencodex://` scheme. A customized distribution therefore is not guaranteed to sign in
correctly when installed alongside the official client. PKCE prevents the wrong application from
redeeming the authorization code, but it cannot prevent login failure caused by callback
misrouting. Side-by-side installation requires a platform-registered client ID and callback URI,
followed by a matching client contract update; changing only the local scheme is not supported.

### 4. Platform capabilities

See the [RenrenCodex platform API and Gateway client contract](backend-api.md). A customized client
may hide billing, referrals, the CLI catalog, or rescue terminals. When hiding a capability,
remove the corresponding navigation, routes, and queries instead of rewriting endpoint origins or
fabricating platform responses.

The client keeps access tokens in memory and uses platform-issued one-time tickets for Gateway
connections. The RenrenCodex server derives tenant and resource authorization from verified
identity context and never trusts a client-supplied `userId` as an authorization boundary.

### 5. Updates and code signing

Generate a separate Tauri Updater key pair for every customized distribution:

- the public key may be embedded in the client;
- the private key and password belong only in protected CI secrets or an offline signing system;
- manifests and artifacts must use your HTTPS domain;
- release versions must increase monotonically and signatures must match the exact artifacts; and
- never commit private keys, PFX/P8 files, passwords, or complete credentials.

Tauri update signatures do not establish operating-system trust. Public distributions should also
configure Windows Authenticode and RFC 3161 timestamps, Apple Developer ID notarization and
stapling, and any applicable Linux package or repository signatures.

### 6. Customization checklist

- [ ] Names, icons, application identifiers, windows, and installer copy are replaced.
- [ ] API, web, Gateway, and preview use the official RenrenCodex origins.
- [ ] CSP and Rust URL allowlists do not widen the platform origins.
- [ ] OAuth uses `renrencodex-desktop` and `renrencodex://oauth/callback`.
- [ ] Users are informed about the deep-link coexistence limitation with the official client.
- [ ] Enabled UI features use only the published REST and WebSocket client contracts.
- [ ] The updater uses an independent key and no production private key enters source or logs.
- [ ] TypeScript, Rust, tests, and platform installers have been validated.
- [ ] MIT, third-party licenses, and your own branding/privacy terms have been reviewed.
