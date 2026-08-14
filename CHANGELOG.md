# Changelog

## 0.1.1 - 2026-08-14

安全修复版本。

- 升级 PDF.js、Vue、PostCSS 与 NanoID，消除已公开的生产依赖漏洞。
- PDF 读取和渲染拒绝包含嵌入式 JavaScript 动作的文件，且不创建脚本管理器或注释脚本层。
- 从 PptxGenJS 浏览器依赖图中移除未使用的 Node `image-size` 解析器，彻底删除相关漏洞代码路径。
- WebContainer 启动改为在 `boot` 前配置正式 client key；缺少配置时，生产构建会直接失败，不再回退到已失效的匿名引导地址。
- 升级 GitHub Actions 到原生 Node.js 24 版本，恢复安全审计和自动部署门禁。

## 0.1.0 - 2026-08-02

首个稳定版本。

- 在浏览器中连接真实项目目录，并提供可审查的文件修改、Diff、运行记录与恢复能力。
- 支持 OpenAI、DeepSeek、Gateway 与 OpenAI-compatible 模型配置。
- 提供可恢复的 Agent 会话、运行中 Steering / Follow-up、上下文压缩与工具循环保护。
- 集成 WebContainer Runtime、终端、依赖快照、Skills、MCP 和 Office/PDF 工具。
- 完善中英文界面、窄屏布局、模型 Quick Test、诊断日志与本地数据导入导出。
