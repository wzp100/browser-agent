# Browser Agent Virtual Runtime

## 1. 目标

Virtual Runtime 是 Browser Agent 自有的浏览器内执行环境，用来替代依赖第三方引导服务的 WebContainer。它必须在不上传整个工作区、不执行宿主系统命令的前提下提供：

- 可取消、可限时、可限制内存的 JavaScript / TypeScript 执行；
- 持久化虚拟文件系统，并与用户授权的项目目录安全同步；
- 包含引号、变量、管道、重定向、条件链和常用内置命令的 Shell；
- 从 npm Registry 安装、校验和使用纯 JavaScript 包；
- 与现有 `ScriptRuntimeProvider`、ChangeSet、日志和终端协议兼容；
- 不需要 StackBlitz、远程执行服务器或 WebContainer API Key。

Virtual Runtime 不是 POSIX 内核或完整 Node.js。兼容能力必须通过功能探测和真实测试声明，不能仅通过命令名称暗示。

## 2. 不变量

1. **项目目录是唯一真实来源。** Runtime 内缓存可以丢失并重建，用户文件不能只存在于易失内存中。
2. **所有项目写入都经过 `ProjectFileService`。** 这保证指纹冲突、ChangeSet、Diff 和恢复语义继续成立。
3. **不可信代码永不运行在页面主线程。** JavaScript 在专用 Worker 内的 QuickJS/WASM 实例中执行。
4. **能力默认拒绝。** Runtime 不提供 DOM、Cookie、浏览器存储、模型密钥、任意宿主网络或宿主文件句柄。
5. **安装不等于执行。** npm 包的 lifecycle scripts、原生扩展和下载后的可执行文件永不自动运行。
6. **会话显式拥有状态。** `cwd`、环境变量、终端状态和正在运行的任务属于一个 Session；任务取消或终止必须释放资源。
7. **每个边界均有限额。** 文件、包、依赖深度、网络响应、stdout/stderr、执行时间和内存都必须有硬上限。
8. **错误可归因。** 解析、权限、网络、包解析、打包、执行和同步错误使用不同错误码，不能统一伪装成 Shell 失败。

## 3. 分层架构

```text
BrowserAgentApp / AgentLoop / Terminal
                  │
                  ▼
       VirtualRuntimeProvider
                  │
        ┌─────────┴─────────┐
        ▼                   ▼
  VirtualShell          JavaScriptRunner
        │                   │
        │                   ├─ esbuild-wasm bundler
        │                   └─ QuickJS Worker pool
        ▼
  VirtualWorkspace ─── PackageManager
        │                   │
        ▼                   ▼
 ProjectFileService    npm Registry + verified tarballs
        │                   │
        └─────────┬─────────┘
                  ▼
       user project + .browser-agent/packages/virtual
```

### 3.1 `VirtualRuntimeProvider`

实现 `ScriptRuntimeProvider`，负责 Session 生命周期、命令取消、交互终端和统一错误映射。Provider 不直接解析 Shell 或 npm 元数据。

### 3.2 `VirtualWorkspace`

- 将逻辑 `/workspace` 和 `.` 映射到项目根；
- 规范化 `/`、`.`、`..`，拒绝越过根目录；
- 通过 `ProjectFileService` 读写真实项目；
- 对文本和二进制文件使用同一接口；
- Runtime 内部包存储位于 `/.browser-agent/packages/virtual`，不会进入普通项目搜索或产物列表；
- Shell 写入使用 `source: "terminal"`，Agent JavaScript 写入沿用当前运行的 ChangeSet。

### 3.3 `VirtualShell`

Shell 使用 lexer → parser → AST → executor 四阶段，不通过字符串拆分执行。第一稳定版支持：

- 单引号、双引号、反斜杠；
- `$NAME`、`${NAME}`、`$?`；
- `;`、换行、`&&`、`||`；
- `|` 和独立 stdout/stderr；
- `<`、`>`、`>>`、`2>`、`2>>`、`2>&1`；
- 命令前环境变量赋值；
- `*`、`?` 基础 glob；
- `Ctrl+C` 取消当前前台任务。

内置命令分为三类：

- 状态命令：`cd`、`pwd`、`export`、`unset`、`env`、`which`；
- 文件命令：`ls`、`cat`、`echo`、`printf`、`mkdir`、`touch`、`cp`、`mv`、`rm`、`head`、`tail`、`wc`、`grep`、`find`、`sort`、`uniq`；
- Runtime 命令：`node`、`npm`、`npx`、`true`、`false`、`sleep`、`clear`、`help`。

不支持命令替换、后台任务、作业控制、任意外部可执行文件、设备文件和宿主绝对路径。缺失能力必须返回 `127`，不能交给宿主执行。

### 3.4 `JavaScriptRunner`

1. 主线程构建只读文件视图和包依赖图。
2. `esbuild-wasm` 把 ESM/CommonJS、TypeScript 和已安装包打包为单个脚本。
3. 专用 Worker 创建 QuickJS Runtime，配置内存和中断处理器。
4. Worker 注入受控的 `console`、`process`、定时器和虚拟文件 API。
5. 执行结束返回 stdout、stderr、退出码和文件变更集。
6. 主线程验证变更路径和预算后，通过 `ProjectFileService` 提交。
7. 超时或取消直接终止 Worker；Worker 不复用于下一次不可信执行。

支持的 Node 兼容模块由版本化清单声明。首批为 `node:path`、`node:buffer`、`node:events`、`node:util`、`node:assert`、`node:url` 和受控的 `node:fs` / `node:fs/promises`。`child_process`、`cluster`、`net`、`tls`、`worker_threads`、原生扩展和系统动态库始终不可用。

### 3.5 `PackageManager`

安装流程是确定性的事务：

```text
parse spec
  → fetch registry metadata
  → resolve dist-tag / semver
  → build dependency graph with depth/count limits
  → fetch tarballs
  → verify Subresource Integrity
  → reject unsafe archive paths and lifecycle/native packages
  → commit versioned, integrity-verified package store
  → atomically write virtual-lock.json
  → optionally update project package.json
```

包存储按 `name@version+integrity` 寻址，不使用扁平 `node_modules` 表示依赖关系。`virtual-lock.json` 保存根依赖和每个包的精确依赖边，打包器按导入者所在包选择正确版本。

安全限制：

- Registry 默认只允许 `https://registry.npmjs.org`；
- 必须校验 `dist.integrity` 或受信任的摘要；
- 拒绝 tar 路径穿越、符号链接、设备节点和超限文件；
- 永不执行 `preinstall`、`install`、`postinstall`；
- 拒绝 `.node`、`node-gyp` 和声明必须使用宿主二进制的包；
- 单包、单文件、依赖数量、深度和总下载量均有预算；
- 先完整验证暂存区，再原子更新 lock；失败不留下半安装状态。

## 4. 生命周期与并发

- 一个已连接项目对应一个 `VirtualWorkspace`。
- 每个 Agent 工具调用获得独立 Runtime Session ID；交互终端拥有长期 Session。
- 文件写操作按路径串行化，读操作可并行。
- 包安装使用项目级互斥锁；同一内容地址的并发下载合并为一个 Promise。
- JavaScript Worker 一次只执行一个入口，结束后销毁。
- `terminate()` 取消进程、释放 Worker、清空易失会话，但不删除持久包存储。

## 5. 错误模型

| 代码 | 来源 |
|---|---|
| `SHELL_PARSE` | 引号、运算符或语法错误 |
| `COMMAND_NOT_FOUND` | 未注册命令 |
| `PATH_ESCAPE` | 路径越过项目根 |
| `FS_CONFLICT` | 真实目录指纹变化 |
| `PACKAGE_RESOLUTION` | npm 版本或依赖无法解析 |
| `PACKAGE_INTEGRITY` | tarball 摘要不匹配 |
| `PACKAGE_UNSUPPORTED` | lifecycle、原生扩展或不支持的 Node API |
| `BUNDLE_ERROR` | 模块解析或打包失败 |
| `EXECUTION_TIMEOUT` | 达到时间预算 |
| `EXECUTION_OOM` | 达到 QuickJS 内存预算 |
| `EXECUTION_ABORTED` | 用户或 Agent 取消 |

## 6. 验证门禁

完成声明需要同时满足：

1. Shell lexer/parser/AST 的表驱动单元测试；
2. 文件命令、管道、重定向、条件链和取消的集成测试；
3. npm exact、dist-tag、semver、传递依赖、完整性失败、路径穿越和预算测试；
4. QuickJS 普通 JS、ESM、CommonJS、TypeScript、异常、超时、内存限制和文件写回测试；
5. 至少一组真实 npm 包兼容矩阵；
6. 独立 Chromium 中完成启动、Shell、安装包、导入包、错误恢复、刷新后重用和重启；
7. 生产构建不包含 WebContainer API，不需要 `VITE_WEBCONTAINER_API_KEY`；
8. CI 的 Runtime E2E 不访问 StackBlitz；单元测试使用离线固定包夹具，真实浏览器测试验证 npm Registry 完整链路。

## 7. 交付顺序

1. VirtualWorkspace + Shell AST + 文件内置命令；
2. QuickJS Worker + JavaScript 执行；
3. Registry resolver + tarball verifier + package store；
4. esbuild 虚拟模块解析 + Node 兼容层；
5. App/Terminal/Agent 接入；
6. 删除 WebContainer 依赖和配置，并将旧架构文档标记为已取代；
7. 全量自动化、真实浏览器、CI 和生产部署验收。
