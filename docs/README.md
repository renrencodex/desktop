# Documentation / 文档

## 中文

这里收录 RenrenCodex Desktop 的开发者文档：

- [后端 API 与 Gateway 契约](backend-api.md)：实现认证、云电脑、工作区和 WebSocket
  Gateway 所需的客户端协议。
- [专属客户端改造指南](customization.md)：更换品牌、域名、OAuth、深链接、更新服务和签名配置。

接口实现的代码级事实来源是：

- `packages/api-client/src/client.ts`：HTTP 方法、路径、认证重试和幂等头；
- `packages/api-client/src/types.ts`：主要 REST DTO；
- `packages/client-contracts/src`：连接票据、文件 RPC、救援终端等共享 Zod 契约；
- `packages/workspace-ui/src` 与 `packages/native-client-ui/src/lib`：Gateway WebSocket
  消息和客户端状态机；
- `crates/client-protocol`：Tauri Rust/TypeScript IPC 类型生成。

文档与代码不一致时以当前代码和测试为准，并在同一变更中修正文档。

## English

This directory contains developer documentation for RenrenCodex Desktop:

- [Backend API and Gateway contract](backend-api.md): the client-facing protocol required to
  implement authentication, cloud machines, workspaces, and the WebSocket Gateway.
- [Custom client guide](customization.md): branding, domains, OAuth, deep links, updates, and
  signing configuration.

The code-level sources of truth are:

- `packages/api-client/src/client.ts` for HTTP methods, paths, authentication retries, and
  idempotency headers;
- `packages/api-client/src/types.ts` for the primary REST DTOs;
- `packages/client-contracts/src` for connection tickets, file RPC, rescue terminal, and other
  shared Zod contracts;
- `packages/workspace-ui/src` and `packages/native-client-ui/src/lib` for Gateway WebSocket
  messages and client state machines; and
- `crates/client-protocol` for generated Tauri Rust/TypeScript IPC types.

If documentation and code disagree, treat the current code and tests as authoritative and update
the documentation in the same change.
