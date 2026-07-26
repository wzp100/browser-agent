---
name: pdf-processing
description: 在浏览器主线程检查、分页读取、渲染、创建或合并 PDF；适用于报告、归档、页面提取和 PDF 输出任务。
---

## 环境约束

PDF Engine 位于浏览器主线程，不需要 Shell、Python、PowerShell 或 EXE。PDF 不作为第一版模型附件直接发送。

## 工作流

1. 用 `pdf.inspect` 获取页数、元数据和 fingerprint。
2. 文本型 PDF 使用 `pdf.read` 分页提取，每次最多 50 页。
3. 只有确需视觉理解时才调用 `pdf.render_page` 生成 PNG；当前模型确认支持图片输入后才能分析该图片。
4. 创建 PDF 使用 `pdf.create`；合并使用 `pdf.merge`。覆盖已有目标前必须读取并携带最新 fingerprint。
5. 所有写入工具都会重新解析验证；完成后再用 `pdf.inspect` 复查实际页数。

扫描 PDF 可能没有可提取文本，此时应明确说明并转为逐页渲染，不能编造页面内容。
