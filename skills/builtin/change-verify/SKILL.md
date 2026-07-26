---
name: change-verify
description: 检查现状后实施用户要求的代码或配置修改，并运行与风险相称的验证；适用于修改并验证、功能调整、重构和缺陷修复。
permissions:
  - workspace-write
  - runtime-execute
---

## 工作流

1. 先用项目读取工具确认相关实现、约束和当前工作区状态，保留所有无关用户改动。
2. 明确最小修改范围；修改已有文件前用 `workspace.read` 获取最新 fingerprint，再用 `workspace.apply_patch` 或 `workspace.write`。
3. 不扩大到用户未授权的功能、远程写入或破坏性操作。发现任务范围外的问题时记录但不顺手改动。
4. 运行与风险相称的针对性测试；共享类型、配置或构建链发生变化时，再运行类型检查或构建。
5. 完成后重新读取关键文件，并在最终答复中区分已修改、已验证和仍未验证的内容。
