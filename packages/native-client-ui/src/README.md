# Native Client UI 边界

本包是 Desktop 与 Android 客户端共用的本地界面实现。它沿用 Web 版的业务和视觉规范，
但不从 `apps/web` 导入源码，也不要求 Web 版消费本包。

- Native 路由、状态、主题和页面组件在本目录统一演进。
- API DTO、Native 平台能力和工作区底层能力仍使用既有 `packages/*` 公共契约。
- 打开外部链接或预览必须使用 `ClientHostConfig.platform`，不要直接调用
  `window.open`。
- 平台差异必须经 `ClientHostConfig` 和 `PlatformApi` 表达，不能在业务页面直接判断系统 API。
