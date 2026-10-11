# v0.3.0 云端协作任务：Native Runtime Bridge 收口

## 起点与范围

仓库：`wzp100/browser-agent`。交接分支：`codex/native-runtime-cloud-handoff`。
该分支基于 main 的 v0.2.0，包含此前本机尚未提交的虚拟运行时增强及可选 Native Runtime Bridge 实现；这是开发快照，不是已验收的稳定版本。

请先阅读本文件、`NATIVE-RUNTIME-BRIDGE.md`、`VIRTUAL-RUNTIME.md`、仓库实际代码与工作流，核对事实后继续实现。使用中文说明与 UTF-8 文件；PowerShell 读取文件必须显式 `Get-Content -Encoding utf8`，不要使用 `-Raw`。

## 必须保持的安全边界

- 浏览器默认继续使用 Virtual Runtime，不重新引入 WebContainer；配对本机桥接不得把 `shell.exec` 或 `javascript.exec` 偷换成宿主执行。
- 宿主能力只能通过显式 `host.*` 工具、精确来源校验、配对会话与明确授权使用。readOnly 不应暴露宿主工具，auto 模式仍需逐次确认宿主调用。
- 不允许任意 shell、PATH 查找、通用子进程执行、Node vm 逃逸或原生 `.node` 扩展。
- 桥接凭证、配对码和 daemon grant ID 不得落盘或进入模型上下文、日志和持久化审计；审计仅保留脱敏元数据。
- 宿主文件写入不属于浏览器 ChangeSet，不得承诺自动回滚。撤销、取消与超时必须终止对应进程树。

## 实施任务（按顺序）

1. 修复交接分支的依赖安装与锁文件一致性，确保 `pnpm install --frozen-lockfile` 成功；不要顺带升级无关依赖或混入 Dependabot PR。
2. 将 `test:native` 纳入 `verify` 与 GitHub Actions。检查动作版本和 Node 版本警告，按实际兼容性处理，不把警告当作失败根因。
3. 安全复核并补测：Origin 缺失/错误、序号重放、过期及跨项目授权、readOnly/auto、路径穿越/符号链接、输出限额、取消/撤销、协议不匹配。Windows junction 与进程树行为在 Linux 云端无法验证时，明确列为本机复验项，不伪造通过。
4. 优化桥接配置和授权 UI：清晰区分虚拟与宿主环境、连接状态、权限范围、有效期、拒绝与撤销；优先提供安全预设，将原始 JSON 作为高级配置；错误需可理解、可恢复，不做无关 UI 重写。
5. 更新中英文 README 与架构文档，提供最小可运行的桥接配置和启动示例；核对 LangGraph、Node 版本及 COOP/COEP 等旧描述；准确说明当前 Virtual Runtime 限制和宿主写入不可自动回滚。
6. 使用现有版本机制准备 v0.3.0，检查新 workspace 包的版本覆盖，补充 CHANGELOG/迁移与验收说明。不要打发布标签或宣称已发布。
7. 运行全量 `verify`，使用真实浏览器验证核心用户流程，包括虚拟代码执行、桥接配对、授权/拒绝、取消、撤销与失败恢复。没有真实 API 凭证时使用明确标注的 mock，不索取或复用聊天历史中的密钥。

## 历史验证（不能当作本次结果）

此前本机曾报告 typecheck 通过、相关单测 26/26、Native E2E 11/11、生产依赖审计无漏洞；这些仅是历史结果。完整 verify 及 v0.3.0 发布验收仍待本次重跑。

## 交付与权限

基于交接分支继续开发，以单独开发分支和面向 main 的 PR 交付，保留交接提交及可追踪历史。PR 需包含变更摘要、真实测试结果、未验证平台、已知风险与剩余事项。
不要自动合并 main、部署生产、创建正式 release 或更改账户/云服务 secrets。不要修改无关营销材料。云端缺少仓库、依赖网络、浏览器或权限时，报告准确阻塞和完成情况，不用扩大权限的后门替代。
