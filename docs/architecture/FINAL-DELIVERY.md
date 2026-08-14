# 最终交付清单

## 当前执行链路

- `BrowserAgentApp` 负责浏览器界面的组合与生命周期。
- `AgentLoop` 使用 LangGraph 编排模型、工具和完成证据校验。
- `ProjectFileService` 直接操作用户明确授权的项目目录，并在覆盖或删除前记录恢复数据。
- `VirtualRuntimeProvider` 通过 `ProjectVirtualFileSystem` 直连真实目录，并以 Virtual Bash、npm 安装器、esbuild 与 QuickJS/WASM Worker 提供受限执行能力。
- Office 工具按需加载 XLSX、DOCX 和 PPTX 引擎，生成后重新解析验证结构。

## 数据与密钥边界

- 项目文件只在工具明确请求时进入模型上下文，不自动上传完整目录。
- API Key 只保存在当前标签页的 `sessionStorage`，不会写入源码、IndexedDB、日志或部署环境。
- 项目、目录句柄、对话、运行记录和脱敏日志保存在浏览器 IndexedDB。
- `.browser-agent/` 是本地运行数据，必须被 Git 忽略。

## 验证命令

```powershell
corepack pnpm@11.7.0 typecheck
corepack pnpm@11.7.0 test
corepack pnpm@11.7.0 check:boundaries
corepack pnpm@11.7.0 audit --prod
corepack pnpm@11.7.0 build
```

历史 Copy Projection、Workspace Safety Kernel 和 Agent Shell 设计已由 ADR-016 取代，不再属于当前实现。
