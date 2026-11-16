# RenrenCodex Desktop

[中文](#中文) · [English](#english)

## 中文

RenrenCodex Desktop 是一个面向开发者的跨平台云开发客户端，使用 Tauri 2、React、
TypeScript 与 Rust 构建，可运行于 Windows、macOS 和 Linux。本仓库作为独立项目维护，包含桌面
客户端、TypeScript API SDK、共享界面组件、Tauri 原生能力以及构建和发布配置。

客户端默认提供浏览器授权登录、云电脑与工作区管理、终端、文件浏览和编辑、上传下载、全文搜索、
端口预览、快照、CLI 应用管理及应用内更新等能力。要运行完整功能，需要接入与客户端契约兼容的
HTTP API、Web 授权页和 WebSocket Gateway。

### 用它构建你的专属客户端

本项目采用 [MIT License](LICENSE)。开发者可以自由复制、修改、分发和商业使用代码，并将它改造成
面向自己团队、产品或云平台的专属客户端。典型改造包括：

- 更换产品名称、Logo、图标、配色、文案和安装包信息；
- 使用自己的应用标识、深链接协议、OAuth 客户端 ID 和回调地址；
- 接入自己的 API、Web 授权站点、WebSocket Gateway 和预览域名；
- 增删云电脑、工作区、文件、终端、计费或团队协作功能；
- 使用自己的 Tauri Updater 密钥、更新地址及 Windows/macOS 代码签名证书；
- 按目标平台调整安装包、CI/CD、发布渠道和品牌资产。

开始改造前请阅读[专属客户端改造指南](docs/customization.md)。生产构建目前包含严格的可信域名、CSP、
深链接和更新地址校验；自定义部署必须成套修改这些边界，不能只替换环境变量或图标。

### 仓库结构

| 路径                        | 用途                                     |
| --------------------------- | ---------------------------------------- |
| `apps/desktop`              | React/Vite 桌面应用与 Tauri 壳           |
| `packages/api-client`       | `/api/v1` TypeScript SDK、认证流程和 DTO |
| `packages/client-contracts` | 客户端共享 Zod 契约与连接票据类型        |
| `packages/client-core`      | 路由、查询键与 Desktop PKCE 授权逻辑     |
| `packages/native-client-ui` | 云电脑、文件、终端、设置等共享界面       |
| `packages/workspace-ui`     | 工作区、编辑器、终端和 RPC 能力          |
| `packages/platform-api`     | Web/Tauri 平台能力适配层                 |
| `crates/client-native`      | Tauri 原生安全能力                       |
| `crates/client-protocol`    | Rust → TypeScript IPC 类型生成           |
| `docs`                      | 开发、定制和后端接入文档                 |
| `packaging`                 | 平台打包配置                             |

### 快速开始

开发环境需要 Bun 1.4.2、稳定版 Rust 工具链，以及 Tauri 2 对应操作系统的构建依赖。

```bash
bun install --frozen-lockfile
cp apps/desktop/.env.example apps/desktop/.env.local
bun run desktop:dev
```

默认开发配置连接：

```dotenv
VITE_API_BASE_URL=http://localhost:3000
VITE_WEB_BASE_URL=http://localhost:5173
VITE_GATEWAY_WS_URL=ws://localhost:7444
```

本地开发仅允许整组 `localhost` HTTP/WS 地址；生产构建必须使用 HTTPS/WSS。接入自有域名时还需修改
原生 URL 白名单、Tauri CSP、OAuth 和更新配置，详见[专属客户端改造指南](docs/customization.md)。

### 后端接入

本仓库提供客户端 SDK 和共享契约，不包含可直接部署的参考后端。实现自有服务时，从以下文档开始：

- [文档索引 / Documentation index](docs/README.md)
- [后端 API 与 Gateway 契约 / Backend API and Gateway contract](docs/backend-api.md)
- [专属客户端改造指南 / Custom client guide](docs/customization.md)

`packages/api-client/src/client.ts` 是 HTTP 调用的代码级入口，`packages/api-client/src/types.ts` 与
`packages/client-contracts/src` 定义请求/响应和连接契约。修改接口时应同时更新契约、SDK、测试和文档。

### 检查与构建

```bash
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

生成本机安装包：

```bash
bun run desktop:build
```

发布前请为自己的品牌配置更新公钥、签名私钥和发布地址。Tauri 更新签名只验证更新来源，不能替代
Windows Authenticode、Apple Developer ID 与公证，或 Linux 软件仓库签名。

### 贡献、安全与许可证

贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题请按
[SECURITY.md](SECURITY.md) 私下报告。源代码采用 [MIT License](LICENSE)；第三方组件继续遵循各自
许可证，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。MIT 许可证不授予 RenrenCodex 或
人人Codex 名称、Logo 和其他品牌资产的商标权，分发定制版本前请阅读
[TRADEMARKS.md](TRADEMARKS.md)。

## English

RenrenCodex Desktop is a cross-platform cloud development client for developers. It is built
with Tauri 2, React, TypeScript, and Rust, and runs on Windows, macOS, and Linux. This repository
is maintained as a standalone project and contains the desktop application, TypeScript API SDK,
shared UI packages, native Tauri capabilities, and build and release configuration.

The client includes browser-based authorization, cloud machine and workspace management,
terminals, file browsing and editing, uploads and downloads, full-text search, port previews,
snapshots, CLI application management, and in-app updates. A compatible HTTP API, web
authorization page, and WebSocket Gateway are required for the complete experience.

### Build your own client

The project is licensed under the [MIT License](LICENSE). You may copy, modify, distribute, and
commercially use the code to build a client for your own team, product, or cloud platform. Common
customizations include:

- replacing the product name, logo, icons, colors, copy, and installer metadata;
- using your own application identifier, deep-link scheme, OAuth client ID, and callback URI;
- connecting to your own API, authorization website, WebSocket Gateway, and preview domains;
- adding or removing machine, workspace, file, terminal, billing, or collaboration features;
- using your own Tauri Updater key, update endpoint, and Windows/macOS signing certificates; and
- adapting installers, CI/CD pipelines, release channels, and brand assets for your platforms.

Read the [custom client guide](docs/customization.md) before making a branded build. Production
builds currently enforce trusted origins, CSP rules, deep links, and updater URLs. A custom
deployment must update those boundaries together; changing only environment variables or icons is
not sufficient.

### Repository layout

| Path                        | Purpose                                                           |
| --------------------------- | ----------------------------------------------------------------- |
| `apps/desktop`              | React/Vite desktop app and Tauri shell                            |
| `packages/api-client`       | `/api/v1` TypeScript SDK, authentication, and DTOs                |
| `packages/client-contracts` | Shared Zod contracts and connection-ticket types                  |
| `packages/client-core`      | Routing, query keys, and Desktop PKCE authorization               |
| `packages/native-client-ui` | Shared machine, file, terminal, and settings UI                   |
| `packages/workspace-ui`     | Workspace, editor, terminal, and RPC features                     |
| `packages/platform-api`     | Web/Tauri platform abstraction                                    |
| `crates/client-native`      | Native Tauri security capabilities                                |
| `crates/client-protocol`    | Rust-to-TypeScript IPC type generation                            |
| `docs`                      | Development, customization, and backend integration documentation |
| `packaging`                 | Platform packaging configuration                                  |

### Quick start

Install Bun 1.4.2, the stable Rust toolchain, and the operating-system dependencies required by
Tauri 2.

```bash
bun install --frozen-lockfile
cp apps/desktop/.env.example apps/desktop/.env.local
bun run desktop:dev
```

The default development configuration connects to:

```dotenv
VITE_API_BASE_URL=http://localhost:3000
VITE_WEB_BASE_URL=http://localhost:5173
VITE_GATEWAY_WS_URL=ws://localhost:7444
```

Local development accepts only the complete localhost HTTP/WS set. Production builds require
HTTPS/WSS. When using your own domains, also update the native URL allowlists, Tauri CSP, OAuth,
and updater settings described in the [custom client guide](docs/customization.md).

### Backend integration

This repository provides the client SDK and shared contracts; it does not include a deployable
reference backend. Start with:

- [Documentation index / 文档索引](docs/README.md)
- [Backend API and Gateway contract / 后端 API 与 Gateway 契约](docs/backend-api.md)
- [Custom client guide / 专属客户端改造指南](docs/customization.md)

`packages/api-client/src/client.ts` is the code-level entry point for HTTP calls.
`packages/api-client/src/types.ts` and `packages/client-contracts/src` define request, response,
and connection contracts. Update the contracts, SDK, tests, and documentation together whenever an
interface changes.

### Checks and builds

```bash
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Build a native installer with:

```bash
bun run desktop:build
```

Before distributing a branded build, configure your own update public key, signing private key,
and release URL. Tauri update signatures authenticate application updates; they do not replace
Windows Authenticode, Apple Developer ID and notarization, or Linux repository signing.

### Contributing, security, and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and use the private reporting
process in [SECURITY.md](SECURITY.md) for vulnerabilities. The source code is licensed under the
[MIT License](LICENSE). Third-party components retain their respective licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The MIT License does not grant trademark rights
to the RenrenCodex or 人人Codex names, logos, or other brand assets. Read
[TRADEMARKS.md](TRADEMARKS.md) before distributing a customized build.
