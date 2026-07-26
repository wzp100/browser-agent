---
name: file-organization
description: 在真实项目目录中读取、搜索、整理、移动或删除文件；适用于文件归类、重命名、目录清理和批量文本调整任务。
---

## 环境约束

当前 Shell 是特殊 WebContainer `jsh`，不是 Windows PowerShell、CMD、宿主 Linux Bash 或完整操作系统。文件管理直接使用 `workspace.*` 操作用户授权的真实项目目录；不要用 Shell 文件命令，也不要编造宿主绝对路径。只有确实需要 Node.js、npm 或纯 JavaScript 时才使用 `shell.exec`。

## 工作流

1. 先用 `workspace.list` 或 `workspace.search` 确认范围和真实相对路径。
2. 修改已有文本前调用 `workspace.read`，将 fingerprint 传给 `workspace.write` 或 `workspace.apply_patch`。
3. 移动使用 `workspace.move`；删除使用 `workspace.delete`。批量移动或删除前再次核对目标，不操作项目根目录。
4. 完成后重新列出或读取目标，只报告工具确认过的实际变更。
5. 工具报错后根据错误调整一次方案；不要原样重复失败操作。
