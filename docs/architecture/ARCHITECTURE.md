# browser agent 浏览器架构（v0.3）

## 状态关系

```text
ThreadRecord -> projectId -> ProjectRecord -> FileSystemDirectoryHandle
                                        |-> ProjectFileService -> 真实项目目录
                                        |-> WorkspaceMirror <-> WebContainer 文件系统根
```

`ProjectRecord`、`ThreadRecord`、`MessageRecord` 和 `RunRecord` 持久化在 IndexedDB。目录句柄使用结构化克隆直接存入项目记录；打开历史对话时先恢复消息，再执行 `queryPermission({ mode: "readwrite" })`。权限为 `granted` 时自动连接，为 `prompt` 时只能在用户点击“恢复文件夹访问”后调用 `requestPermission()`。

旧 LocalStorage 对话会一次性迁移为 `legacyRelinkRequired` 项目。由于旧记录没有目录句柄，第一次必须重新关联文件夹。

## 真实目录

`ProjectFileService` 是项目文件操作入口，提供列出、读取、写入、精确补丁、搜索、移动和删除。路径在进入目录句柄前必须标准化并拒绝盘符、反斜杠、编码遍历和 `..`。

修改真实文件前，原内容和操作元数据写入 OPFS。已有文件的覆盖工具接受读取时返回的 fingerprint；文件在读取后被外部修改时抛出 `WorkspaceConflictError`，不得静默覆盖。

项目连接时，文件服务会幂等创建 `.browser-agent/state`、`.browser-agent/packages` 与 `.browser-agent/packages/installed`。Runtime 为 npm、pnpm、yarn 注入项目级缓存路径；检测到根 `node_modules` 变化后，导出 WebContainer 文件树，将文本、二进制和符号链接编码并压缩到 `installed/node-modules.snapshot`，命令结束与项目断开前强制落盘。新终端、页面刷新或项目重新挂载时直接把快照挂载回根 `node_modules`，无需用户再次安装，同时保留依赖结构。缓存目录不参与 Agent 文本搜索、产物链接和 OPFS 恢复备份，避免把依赖误当成用户成果或重复保存。

v0.3 不再把 `WorkspaceProjection`、Artifact 发布或隔离工作区放在浏览器主执行链路中；对应旧包已经删除，历史设计仅保留在标记为 Superseded 的 ADR 中。

产品面向需要在浏览器中处理文件、数据和 Office 产物的用户，不提供本地 Git 状态、历史、Diff、暂存或提交能力。`.git` 仅作为版本控制元数据从文件树、搜索、ChangeSet 和 Runtime 挂载中隔离。

## WebContainer

`WorkspaceMirror` 懒启动一个 WebContainer，并把真实目录挂载到 WebContainer 文件系统根。对 Agent 暴露的逻辑工作目录始终是 `/workspace`，映射层会将它转换为 WebContainer 根路径，禁止再拼接内部 `workdir`，避免出现 `/home/workspace/home/workspace`。WebContainer 实例、启动 Promise 和首次启动错误保存在页面级 `globalThis`，可跨 Vite 热更新复用；应用层和 Mirror 层均有并发启动锁。切换项目只关闭 watcher 与 jsh、清理文件系统根后重新挂载，不再反复 `teardown()` / `boot()`；一次真实的 `boot()` 失败后，本页面也不会再次消耗实例配额。

递归 `fs.watch` 将 Shell 产生的源文件变更写回真实目录；窗口重新获得焦点和 Agent 执行前，把真实目录的外部变化同步进 Runtime。

以下路径是 Runtime 缓存，不同步：`node_modules`、`.git`、`.pnpm-store`、`.npm`、`.cache`、`dist`、`build`、`coverage`。单文件挂载上限为 8 MB，单项目初始挂载预算为 80 MB。

Xterm.js 连接 WebContainer 自带的特殊 `jsh`，支持 stdin、stdout、终端尺寸和进程终止。它不是 PowerShell、CMD、宿主 Linux Bash 或完整操作系统，只保证 Node.js、npm 和纯 JavaScript。Shell 命令默认 120 秒超时。刷新后只恢复终端记录，不能恢复已经结束的进程。

普通 Chrome / Edge 在 `crossOriginIsolated` 模式下以 `coep: credentialless` 启动。启动前必须同时满足安全上下文、`crossOriginIsolated` 和 `SharedArrayBuffer` 三项能力；无法获得跨源隔离能力的内嵌 Chromium 页面会在 `boot()` 前停止，并提示用户改用启动脚本打开的独立浏览器页面。

开发与预览服务器必须返回：

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

## Agent 与 Skills

`AgentLoop` 使用 `@langchain/langgraph` 的 `StateGraph` 编排智能体。图状态保存模型消息、当前轮次、工具调用和最终回复，执行路径为：

```text
START -> model --有工具--> tools --继续--> model
                 |
                 +--无工具--> evidence gate --通过--> finalize -> END
                                      |
                                      +--拒绝--> grounding --> model
```

`model` 节点调用当前 `ModelProvider`；存在工具调用时由条件边进入 `tools` 节点，否则先进入完成证据门。工具注册必须声明作用域（workspace、runtime、skill、network、conversation）和效果（context、read、write、execute），只有成功执行的非 context 工具才构成任务证据。修改类任务以及声称已修改项目的答复必须包含成功的 workspace/write 证据。未通过校验的候选答复不会发到界面；图会注入纠正消息并强制模型调用工具，连续两次仍跳过工具则以可恢复失败结束。默认最多执行 40 轮模型调用，达到限制后以可恢复失败结束；连续两次工具失败时立即熔断当前任务。模型初始会收到应用注入的实际 Runtime、特殊 `jsh` 限制、逻辑工作目录和已安装 Skill 摘要，同时看到近期对话和工具 schema，但不会收到完整项目。

生产模型 Provider 由 LangChain 实现：OpenAI 使用 `ChatOpenAI` 并启用 Responses API，DeepSeek 使用 `ChatDeepSeek`。工具通过 `bindTools()` 绑定；证据未满足时优先使用 `tool_choice: required`，满足后恢复为 `auto`。若思考模式明确返回不支持 `tool_choice` 的兼容性错误，Provider 会在重试和该实例的后续工具回合中完全省略此参数；代码层的完成证据门仍然生效。DeepSeek 工具回合的 `reasoning_content` 会随内部 assistant 消息保留并在工具结果后的请求中传回。文本、思考内容与工具调用从 LangChain `AIMessageChunk` 汇总，不再由项目手写解析厂商 SSE 事件或拼接工具参数。`GatewayModelProvider` 只负责浏览器与本地 Gateway 之间的传输；Gateway 内部调用 OpenAI 时仍使用同一个 LangChain Provider。项目未连接时应用直接阻止发送，不再启动一个没有系统约束和工具的裸模型回合。

Command Bus 当前注册：

- `workspace.list/read/write/apply_patch/search/move/delete`
- `office.inspect/validate`
- `spreadsheet.read/create/transform`
- `document.create`、`presentation.create`
- `shell.exec`、`runtime.info`
- `skill.list/inspect/run/install`
- `network.fetch`
- `conversation.get_context`

Skill 摘要随每回合环境快照注入，完整 `SKILL.md` 仅在 `skill.inspect` 时加载。内置 Skill 随应用打包；用户和 Agent 生成的 Skill 保存在 OPFS `agent-home/skills`，脚本只能通过 WebContainer 中的 Node.js 执行。Office Skills 直接调用浏览器主线程工具，不经过 Shell，也不探测 Python。

## 数据边界

- 真实项目目录：用户文件唯一事实源。
- IndexedDB：项目、句柄、对话、消息、运行记录和非敏感设置。
- OPFS：修改前恢复数据、Skills、Runtime Home 和缓存。
- sessionStorage：API Key 和当前选中的对话。
- 网络：只有模型请求、显式 `network.fetch` 和用户明确触发的内容读取会离开浏览器；文件不会自动附加到模型请求。

## 诊断日志

`packages/logging` 使用 `loglevel` 提供标准日志级别，并把结构化 `AppLogRecord` 写入 IndexedDB `logs` store。每条记录包含 ISO 时间、级别、模块、消息、脱敏上下文及可选错误栈。设置界面显示最近 500 条，JSONL 导出读取全部记录。

日志记录应用、权限、模型、Agent、文件服务和 Runtime 关键事件，但不记录模型消息正文、工具结果正文、文件内容或认证凭据。上下文键名匹配 API Key、Authorization、密码、Token、Cookie、Secret 时由日志内核统一替换为 `[已隐藏]`。
