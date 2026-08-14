# ADR-008 Runtime Provider

状态：Superseded by Virtual Runtime（2026-08-15）。

`ScriptRuntimeProvider` 仍是 Agent Core 与执行引擎之间的边界，但具体实现已从 WebContainer 替换为 Browser Agent 自有的 `VirtualRuntimeProvider`。它组合持久化 VFS、Virtual Bash、npm Registry 安装器、esbuild-wasm 与 QuickJS/WASM Worker，不需要第三方容器引导服务或 client key。
