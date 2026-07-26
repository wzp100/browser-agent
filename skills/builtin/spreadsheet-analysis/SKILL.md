---
name: spreadsheet-analysis
description: 在浏览器主线程读取、分析、转换或创建真实项目中的 XLSX、XLS、CSV；适用于 Excel、工作簿、表格、筛选、排序、去重和分组计数任务。
---

## 环境约束

当前 Shell 是特殊 WebContainer `jsh`，不是 PowerShell、CMD、Linux Bash 或完整操作系统。表格引擎运行在浏览器主线程：不要调用 Shell，不要探测或声称使用 Python、python3、pip、conda，也不要使用宿主绝对路径。

## 工作流

1. 用 `workspace.list` 确认源文件路径，再用 `office.inspect` 获取工作表结构和 fingerprint。
2. 用 `spreadsheet.read` 读取指定工作表的列、概要与受限样本；大表不要完整放入模型上下文。
3. 求和、平均值、最小值、最大值、计数和分组财务汇总使用 `spreadsheet.aggregate`；完整数据的等值筛选、排序、去重或分组计数使用 `spreadsheet.transform`；新建表格使用 `spreadsheet.create`。
4. 默认输出新的 `.xlsx` 并保留原件。只有用户明确要求覆盖时才覆盖，且必须先读取目标文件并传入最新 fingerprint。
5. 写入后调用 `office.validate`，再用 `office.inspect` 或 `spreadsheet.read` 检查实际输出。
6. `.xls` 源文件保留不动，输出标准化为新的 `.xlsx`。

不要调用未注册的 `excel inspect`、`excel validate` 或虚构的 WorkbookResource。
所有 `workspace.*`、`office.*` 和 `spreadsheet.*` 路径都使用项目相对形式（例如 `/销售数据.xlsx`），不要添加逻辑 Shell 前缀 `/workspace`。
