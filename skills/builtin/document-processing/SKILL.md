---
name: document-processing
description: 在浏览器主线程检查或创建真实项目中的 DOCX 文档；适用于 Word、报告、说明文档和 DOCX 输出任务。
---

## 环境约束

当前 Shell 是特殊 WebContainer `jsh`，不是宿主系统 Shell。DOCX 引擎运行在浏览器主线程；不要使用 Shell、Python、PowerShell、EXE 或宿主绝对路径处理文档。

## 工作流

1. 检查已有 DOCX 时先用 `office.inspect`，记录 fingerprint。
2. 创建简单文档时用 `document.create` 的兼容参数，提供 `.docx` 输出路径、标题和正文段落。
3. 需要结构化版式时提供 `spec`：
   - `title`：可选文档标题。
   - `blocks`：按顺序使用 `heading`、`paragraph`、`list`、`table`、`image`。
   - `header` / `footer`：可选页眉和页脚文本。
   - `theme`：可设置字体、标题色、正文色和强调色。
   - 图片使用 PNG/JPEG base64 data URL，并提供合理的宽高和替代文本。
4. 默认创建新文件。只有用户明确要求覆盖时才覆盖，且必须把最新 fingerprint 传给 `document.create`。
5. 写入后必须用 `office.validate` 验证，再用 `office.inspect` 复查实际结构；检查摘要中的标题层级、段落、列表、表格、图片以及页眉页脚状态。

不要调用未注册的 `word validate`，不要承诺批注、修订追踪、目录自动更新等尚未实现的高级 Word 功能。
