---
name: presentation-generation
description: 在浏览器主线程检查或创建简洁 PPTX；适用于 PowerPoint、PPT 汇报、幻灯片和基于项目资料生成并验证演示文稿的任务。
---

## 环境约束

当前 Shell 是浏览器虚拟 Bash，不是宿主系统 Shell。PPTX 引擎运行在浏览器主线程；不要使用 Shell、Python、PowerShell、EXE 或宿主绝对路径处理演示文稿。

## 工作流

1. 检查已有 PPTX 时先用 `office.inspect`，记录 fingerprint。
2. 先明确受众、演示目标和中心结论，再组织有递进关系的幻灯片；每页只承担一个主要叙事任务。
3. 简单单页演示可以继续提供标题和要点；多页演示提供 `spec.slides`，按内容选择：
   - `title`：标题页，可包含副标题或图片。
   - `bullets`：标题和简明要点。
   - `two-column`：两栏对照文本或要点。
   - `table`：带表头的数据表。
   - `image`：主图片和可选说明。
   - `theme`：可设置背景、标题、正文、弱化色、强调色和字体。
4. 默认创建新文件。只有用户明确要求覆盖时才覆盖，且必须传入最新 fingerprint。
5. 写入后必须用 `office.validate` 验证，再用 `office.inspect` 复查每页标题、文本、表格数和图片数。
6. 用户要求“PPT 汇报”时，先读取项目中的真实证据，再制作有明确叙事顺序的多页演示；没有证据的内容不得作为事实写入。

可见内容必须面向最终受众，不能暴露内部计划或生成提示。不要调用未注册的 `ppt validate`，不要承诺动画、视频或复杂母版编辑等尚未实现的功能。
