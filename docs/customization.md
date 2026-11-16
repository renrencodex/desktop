# 专属客户端改造指南 / Custom Client Guide

## 中文

RenrenCodex Desktop 可以作为你自己的云开发产品、企业工作台或远程开发客户端的基础。MIT
许可证允许修改和分发源代码，但产品标识、服务端契约和安全边界需要由分发者自行配置并维护。

### 1. 品牌与应用身份

至少检查以下位置：

- `apps/desktop/src-tauri/tauri.conf.json`：`productName`、`identifier`、窗口标题、图标和深链接；
- `apps/desktop/src-tauri/tauri.windows.conf.json` 与 `apps/desktop/src-tauri/wix`：Windows
  安装器名称和文案；
- `apps/desktop/src-tauri/icons`：各平台应用图标；
- `apps/desktop/src/main.tsx` 与 `packages/native-client-ui/src`：界面名称、Logo、帮助链接和产品文案；
- `apps/desktop/package.json`：应用版本；
- 安装包文件名、GitHub Actions 工作流和发布说明。

使用新的反向域名应用标识，例如 `com.example.desktop`。不要让第三方构建继续使用官方应用标识、
更新密钥或让用户误认为它是官方发行版。RenrenCodex/人人Codex 品牌使用规则见
`TRADEMARKS.md`。

### 2. API、Web 与 Gateway 地址

开发地址来自：

```dotenv
VITE_API_BASE_URL=http://localhost:3000
VITE_WEB_BASE_URL=http://localhost:5173
VITE_GATEWAY_WS_URL=ws://localhost:7444
```

生产版本使用 HTTPS/WSS。自有域名需要同步修改：

- `apps/desktop/src/config.ts` 中的生产 Origin 校验；
- `apps/desktop/src-tauri/tauri.conf.json` 中的 `connect-src` CSP；
- `crates/client-native/src/lib.rs` 中外部导航、预览域名和更新制品 URL 白名单；
- `apps/desktop/src-tauri/src/lib.rs` 中的更新清单和制品地址；
- `apps/desktop/scripts/release-manifest.ts`、`prepare-*-release.ts` 中的发布 URL；
- `.github/workflows` 中生产构建使用的三个 `VITE_*` 地址。

保持白名单精确。不要为了方便改成任意 `https:`、任意子域或关闭 CSP；否则服务端返回的恶意 URL、
开放重定向或被接管子域可能获得原生客户端能力。

### 3. OAuth 与深链接

Desktop 使用浏览器授权和 PKCE S256。以下值必须在客户端、Tauri、操作系统注册和服务端保持一致：

- `packages/api-client/src/desktop-oauth.ts` 中的客户端 ID 与回调 URI；
- `packages/client-core/src/desktop-auth.ts` 中的授权页参数；
- `apps/desktop/src-tauri/tauri.conf.json` 中的深链接 scheme；
- `crates/client-native/src/lib.rs` 中的回调 URL 校验；
- 服务端允许的客户端 ID、回调 URI、授权码有效期和 PKCE 校验。

建议为每个品牌使用唯一 scheme，例如 `examplecloud://oauth/callback`，并保留 `state`、单次授权码、
五分钟过期和 PKCE verifier 校验。Refresh token 只能存入系统安全存储，不能写入 localStorage、日志或 URL。

### 4. 后端能力

完整接口见[后端 API 与 Gateway 契约](backend-api.md)。如果你的后端暂不实现计费、推广、CLI 商店或
救援终端，应同时从导航、路由和查询中移除对应功能，不能让界面反复请求不存在的接口。

客户端把访问令牌放在内存中，并通过一次性连接票据访问 Gateway。服务端必须从已验证的身份上下文确定
租户和资源权限，不接受客户端提交的 `userId` 作为授权依据。

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
- [ ] API、Web、Gateway、预览和更新域名均属于你的服务；
- [ ] CSP 与 Rust URL 白名单只包含所需 Origin；
- [ ] OAuth 客户端 ID、scheme、回调 URI 和服务端注册一致；
- [ ] 后端实现了启用界面所需的 REST 与 WebSocket 契约；
- [ ] Updater 使用独立密钥，生产私钥未进入源码或构建日志；
- [ ] 已运行 TypeScript、Rust、测试和平台安装包检查；
- [ ] 已核对 MIT、第三方许可证和你自己的品牌/隐私条款。

## English

RenrenCodex Desktop can be the foundation of your own cloud development product, enterprise
workspace, or remote development client. The MIT License permits modification and distribution,
but distributors are responsible for their own identity, backend contracts, and security
boundaries.

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

Use a new reverse-domain identifier such as `com.example.desktop`. Third-party builds must not
reuse an official application identifier or updater key, or imply that they are official releases.
See `TRADEMARKS.md` for the RenrenCodex/人人Codex brand rules.

### 2. API, web, and Gateway origins

Development origins are configured with:

```dotenv
VITE_API_BASE_URL=http://localhost:3000
VITE_WEB_BASE_URL=http://localhost:5173
VITE_GATEWAY_WS_URL=ws://localhost:7444
```

Production uses HTTPS/WSS. For your own domains, update all of the following:

- production-origin validation in `apps/desktop/src/config.ts`;
- the `connect-src` CSP in `apps/desktop/src-tauri/tauri.conf.json`;
- external-navigation, preview-domain, and update-artifact allowlists in
  `crates/client-native/src/lib.rs`;
- updater manifest and artifact URLs in `apps/desktop/src-tauri/src/lib.rs`;
- release URLs in `apps/desktop/scripts/release-manifest.ts` and `prepare-*-release.ts`; and
- the three production `VITE_*` values in `.github/workflows`.

Keep allowlists exact. Do not replace them with arbitrary `https:`, arbitrary subdomains, or a
disabled CSP. A malicious server URL, open redirect, or abandoned subdomain could otherwise gain
access to native client capabilities.

### 3. OAuth and deep links

Desktop authorization uses the system browser and PKCE S256. Keep these values consistent across
the client, Tauri, operating-system registration, and your server:

- the client ID and callback URI in `packages/api-client/src/desktop-oauth.ts`;
- authorization parameters in `packages/client-core/src/desktop-auth.ts`;
- the deep-link scheme in `apps/desktop/src-tauri/tauri.conf.json`;
- callback URL validation in `crates/client-native/src/lib.rs`; and
- the server's allowed client ID, callback URI, authorization-code lifetime, and PKCE checks.

Use a unique scheme for each brand, such as `examplecloud://oauth/callback`. Preserve `state`,
single-use authorization codes, the five-minute expiry, and PKCE verifier validation. Refresh
tokens belong only in operating-system secure storage, never localStorage, logs, or URLs.

### 4. Backend capabilities

See the [Backend API and Gateway contract](backend-api.md). If your backend does not implement
billing, referrals, the CLI catalog, or rescue terminals, remove the corresponding navigation,
routes, and queries so the UI does not repeatedly call unavailable endpoints.

The client keeps access tokens in memory and uses one-time tickets for Gateway connections. The
server must derive tenant and resource authorization from verified identity context and must never
trust a client-supplied `userId` as an authorization boundary.

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
- [ ] API, web, Gateway, preview, and update domains belong to your service.
- [ ] CSP and Rust URL allowlists contain only required origins.
- [ ] OAuth client ID, scheme, callback URI, and server registration match.
- [ ] The backend implements every REST and WebSocket contract exposed by the enabled UI.
- [ ] The updater uses an independent key and no production private key enters source or logs.
- [ ] TypeScript, Rust, tests, and platform installers have been validated.
- [ ] MIT, third-party licenses, and your own branding/privacy terms have been reviewed.
