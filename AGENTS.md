# AGENTS.md — RenrenCodex Desktop

本仓库是人人 Codex Desktop 的公开下游快照，默认使用中文沟通；私有 monorepo
仍是受控源码的权威上游。

- `desktop-shared-snapshot.json` 中列出的路径由同步脚本管理，不直接修改。
- 上游同步仅通过 `scripts/sync-from-upstream.ts` 从可信本地克隆执行，提交必须是
  `main` 或 `production` 对应分支可达的完整 SHA。
- 使用 Bun、ESM、TypeScript strict；只保留根 `bun.lock` 和 `Cargo.lock`。
- Rust 代码限于 Tauri Native Core/Plugin/IPC，共享 IPC 由
  `crates/client-protocol` 生成，不手写两份协议。
- 不提交或输出密钥、私钥、令牌、签名证书及完整连接串。
- 提交前按影响面运行 `sync:check`、格式、lint、类型、测试与构建。
- 提交使用 Conventional Commits，一个提交表达一个可评审目的。
