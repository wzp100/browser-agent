import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, inspectDocument, summarizeDocument, validateDocument } from "../packages/document-engine/src/index";
import { createPresentation, inspectPresentation, summarizePresentation, validatePresentation } from "../packages/presentation-engine/src/index";

const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zf9sAAAAASUVORK5CYII=";

test("结构化 Word 支持标题、段落、列表、表格、图片和页眉页脚", async () => {
  const data = await createDocument({
    title: "季度报告",
    header: "Browser Agent · 内部资料",
    footer: "第 1 版",
    theme: { fontFamily: "Microsoft YaHei", accentColor: "0F766E", headingColor: "115E59" },
    blocks: [
      { type: "heading", level: 1, text: "核心结论" },
      { type: "paragraph", text: "收入与留存率同步提升。", bold: true },
      { type: "list", ordered: true, items: ["验证数据", "发布报告"] },
      { type: "table", headers: ["指标", "结果"], rows: [["收入", "+12%"], ["留存", "+4pp"]] },
      { type: "image", image: { data: pixel, width: 120, height: 80, altText: "示例图" }, caption: "图 1：趋势示意" }
    ]
  });
  assert.equal(await validateDocument(data), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const inspection = await inspectDocument("/quarterly.docx", data);
  assert.equal(inspection.tableCount, 1);
  assert.equal(inspection.summary.title, "季度报告");
  assert.deepEqual(inspection.summary.headings, [{ level: 1, text: "核心结论" }]);
  assert.deepEqual(inspection.summary.lists, [["验证数据", "发布报告"]]);
  assert.equal(inspection.summary.tables[0]?.rows[1]?.[0], "收入");
  assert.equal(inspection.summary.imageCount, 1);
  assert.equal(inspection.summary.hasHeader, true);
  assert.equal(inspection.summary.hasFooter, true);
  assert.deepEqual(await summarizeDocument(data), inspection.summary);
});

test("结构化 PPT 支持五种版式、主题与图片 data URL", async () => {
  const data = await createPresentation({
    title: "产品复盘",
    subject: "季度经营复盘",
    theme: { backgroundColor: "071A2B", accentColor: "2DD4BF", titleFontFace: "Microsoft YaHei", bodyFontFace: "Microsoft YaHei" },
    slides: [
      { layout: "title", title: "产品复盘", subtitle: "关键结果与下一步" },
      { layout: "bullets", title: "增长来自两个动作", bullets: ["缩短激活路径", "优化召回节奏"] },
      { layout: "two-column", title: "机会与风险需要同步管理", left: { heading: "机会", bullets: ["新市场验证"] }, right: { heading: "风险", text: "交付周期仍需压缩。" } },
      { layout: "table", title: "核心指标继续改善", headers: ["指标", "本期"], rows: [["激活率", "68%"], ["留存率", "42%"]] },
      { layout: "image", title: "用户路径已显著简化", image: { data: pixel, altText: "用户路径示意" }, caption: "新版路径示意" }
    ]
  });
  assert.equal(await validatePresentation(data), "application/vnd.openxmlformats-officedocument.presentationml.presentation");
  const inspection = await inspectPresentation("/review.pptx", data);
  assert.equal(inspection.slideCount, 5);
  assert.equal(inspection.summary.totalTables, 1);
  assert.equal(inspection.summary.totalImages, 1);
  assert.equal(inspection.summary.slides[1]?.title, "增长来自两个动作");
  assert.ok(inspection.summary.slides[2]?.texts.includes("机会"));
  assert.ok(inspection.summary.slides[3]?.texts.includes("激活率"));
  assert.deepEqual(await summarizePresentation(data), inspection.summary);
});

test("结构化 Office Spec 拒绝空内容和列数不一致的表格", async () => {
  await assert.rejects(createDocument({ blocks: [] }), /文档不能为空/);
  await assert.rejects(createPresentation({ slides: [] }), /至少需要一页/);
  await assert.rejects(createPresentation({ slides: [{ layout: "table", title: "错误表格", headers: ["A", "B"], rows: [["1"]] }] }), /列数必须一致/);
});

test("结构化 PPT 在进入 PptxGenJS 前拒绝未知版式和缺失图片数据", async () => {
  await assert.rejects(
    createPresentation({ slides: [{ layout: "content", title: "未知版式" }] } as never),
    /layout 不受支持：content/
  );
  await assert.rejects(
    createPresentation({ slides: [{ layout: "image", title: "缺少图片" }] } as never),
    /image 必须是图片对象/
  );
  await assert.rejects(
    createPresentation({ slides: [{ layout: "image", title: "缺少数据", image: {} }] } as never),
    /image\.data 必须是 PNG\/JPEG data URL 或 Uint8Array/
  );
});
