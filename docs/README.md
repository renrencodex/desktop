# Documentation / 文档

## 中文

这里收录 RenrenCodex Desktop 的开发者文档：

- [人人Codex平台 API 与 Gateway 客户端契约](backend-api.md)：定制客户端访问认证、云电脑、
  工作区和 WebSocket Gateway 所需的平台协议。
- [专属客户端改造指南](customization.md)：更换品牌、界面、安装包、更新服务和签名配置，同时保留
  人人Codex平台连接边界。

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

- [RenrenCodex platform API and Gateway client contract](backend-api.md): the platform protocol a
  customized client uses for authentication, cloud machines, workspaces, and the WebSocket
  Gateway.
- [Custom client guide](customization.md): branding, UI, installers, updates, and signing while
  retaining the RenrenCodex platform connection boundaries.

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
