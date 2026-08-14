# Browser Agent 浏览器架构（v0.2）

## 状态关系

```text
ThreadRecord -> projectId -> ProjectRecord -> FileSystemDirectoryHandle
                                        |-> ProjectFileService -> 真实项目目录
                                        |-> ProjectVirtualFileSystem -> Virtual Bash / npm / QuickJS
```

`ProjectRecord`、`ThreadRecord`、`MessageRecord` 和 `RunRecord` 持久化在 IndexedDB。目录句柄使用结构化克隆直接存入项目记录；打开历史对话时先恢复消息，再执行 `queryPermission({ mode: "readwrite" })`。权限为 `granted` 时自动连接，为 `prompt` 时只能在用户点击“恢复文件夹访问”后调用 `requestPermission()`。

旧 LocalStorage 对话会一次性迁移为 `legacyRelinkRequired` 项目。由于旧记录没有目录句柄，第一次必须重新关联文件夹。

## 真实目录

`ProjectFileService` 是项目文件操作入口，提供列出、读取、写入、精确补丁、搜索、移动和删除。路径在进入目录句柄前必须标准化并拒绝盘符、反斜杠、编码遍历和 `..`。

修改真实文件前，原内容和操作元数据写入 OPFS。已有文件的覆盖工具接受读取时返回的 fingerprint；文件在读取后被外部修改时抛出 `WorkspaceConflictError`，不得静默覆盖。

项目连接时，文件服务会幂等创建 `.browser-agent/state` 与 `.browser-agent/packages`。`ProjectVirtualFileSystem` 直接把 Runtime 文件操作映射到 `ProjectFileService`，因此不存在第二份容器文件树或双向同步竞态。安装包按名称与版本保存在 `.browser-agent/packages/store`，依赖图写入 `.browser-agent/virtual-lock.json`；这些内部目录不参与 Agent 文本搜索、产物链接和 OPFS 恢复备份。

v0.3 不再把 `WorkspaceProjection`、Artifact 发布或隔离工作区放在浏览器主执行链路中；对应旧包已经删除，历史设计仅保留在标记为 Superseded 的 ADR 中。

产品面向需要在浏览器中处理文件、数据和 Office 产物的用户，不提供本地 Git 状态、历史、Diff、暂存或提交能力。`.git` 仅作为版本控制元数据从文件树、搜索、ChangeSet 和 Runtime 挂载中隔离。

## Virtual Runtime

`VirtualRuntimeProvider` 实现通用 `ScriptRuntimeProvider`，由五层组成：

1. `ProjectVirtualFileSystem`：真实项目目录的受限适配层，逻辑根为 `/workspace`，拒绝路径穿越；
2. `VirtualShell`：词法/语法解析、变量、条件链、管道、重定向、glob 和基础 Bash 命令；
3. `VirtualPackageManager`：固定 HTTPS Registry、semver 依赖图、下载预算、SRI/SHA 校验、安全 tar 解包和持久锁文件；
4. `VirtualModuleBundler`：使用 `esbuild-wasm` 解析项目源码、TypeScript 与已安装 npm 依赖；
5. `QuickJsWorkerExecutor`：每次执行创建独立 Worker，在 QuickJS/WASM 中设置内存、栈、解释器截止时间和宿主强制终止计时器。

QuickJS 默认不拥有 DOM、网络、浏览器存储或宿主文件系统，只暴露受控 `console` 与只读 `process` 元数据。npm 生命周期脚本永不执行；原生扩展和未实现的 Node 内置模块会明确失败。Xterm.js 连接虚拟 Shell，支持提示符、命令历史、退格、Ctrl+L 与 Ctrl+C。Runtime 不需要 WebContainer、StackBlitz client key、`SharedArrayBuffer` 或跨源隔离。

完整安全预算、包格式和 Shell 语法见 [VIRTUAL-RUNTIME.md](VIRTUAL-RUNTIME.md)。

## Agent 与 Skills

`AgentLoop` 编排模型、工具调用、检查点和完成证据。状态保存模型消息、当前轮次、工具调用和最终回复，执行路径为：

```text
START -> model --有工具--> tools --继续--> model
                 |
                 +--无工具--> evidence gate --通过--> finalize -> END
                                      |
                                      +--拒绝--> grounding --> model
```

`model` 节点调用当前 `ModelProvider`；存在工具调用时进入 `tools`，否则进入完成证据门。工具注册必须声明作用域（workspace、runtime、skill、network、conversation）和效果（context、read、write、execute），只有成功执行的非 context 工具才构成任务证据。未通过校验的候选答复不会作为最终答复展示。模型初始会收到实际 Runtime、Virtual Bash 限制、逻辑工作目录和已安装 Skill 摘要，同时看到近期对话和工具 schema，但不会收到完整项目。

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

Skill 摘要随每回合环境快照注入，完整 `SKILL.md` 仅在 `skill.inspect` 时加载。内置 Skill 随应用打包；用户和 Agent 生成的 Skill 保存在 OPFS `agent-home/skills`，纯 JavaScript 脚本通过 QuickJS/WASM 执行。Office Skills 直接调用浏览器主线程工具，不经过 Shell，也不探测 Python。

## 数据边界

- 真实项目目录：用户文件唯一事实源。
- IndexedDB：项目、句柄、对话、消息、运行记录和非敏感设置。
- OPFS：修改前恢复数据、Skills、Runtime Home 和缓存。
- sessionStorage：API Key 和当前选中的对话。
- 网络：只有模型请求、显式 `network.fetch`、用户触发的 npm 安装和明确内容读取会离开浏览器；文件不会自动附加到模型请求。

## 诊断日志

`packages/logging` 使用 `loglevel` 提供标准日志级别，并把结构化 `AppLogRecord` 写入 IndexedDB `logs` store。每条记录包含 ISO 时间、级别、模块、消息、脱敏上下文及可选错误栈。设置界面显示最近 500 条，JSONL 导出读取全部记录。

日志记录应用、权限、模型、Agent、文件服务和 Runtime 关键事件，但不记录模型消息正文、工具结果正文、文件内容或认证凭据。上下文键名匹配 API Key、Authorization、密码、Token、Cookie、Secret 时由日志内核统一替换为 `[已隐藏]`。
