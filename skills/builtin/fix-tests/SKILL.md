---
name: fix-tests
description: 运行项目现有测试，定位失败根因，实施最小修复并重新验证；适用于修复测试失败、回归失败和构建检查错误。
permissions:
  - workspace-write
  - runtime-execute
---

## 工作流

1. 先读取包清单、测试配置和相关源码，确认项目实际使用的测试命令。
2. 用 `shell.exec` 运行最小范围的失败测试并保留原始错误；不要先改代码，也不要原样重复失败命令。
3. 沿失败堆栈定位根因，用 `workspace.read` 获取最新 fingerprint，再通过 `workspace.apply_patch` 或 `workspace.write` 实施最小范围修复。
4. 不修改与根因无关的用户代码，不通过跳过、删除或放宽断言来掩盖产品缺陷。
5. 先重跑失败测试，再运行与改动风险相称的相关测试、类型检查或构建；只报告实际通过的验证。
