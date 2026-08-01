import assert from "node:assert/strict";
import test from "node:test";
import { APP_LOCALE_STORAGE_KEY, detectLocale, readLocalePreference, resolveLocale, saveLocalePreference, translateText } from "../apps/web/src/i18n";

test("界面语言根据浏览器首选语言选择中文或英文", () => {
  assert.equal(detectLocale(["zh-CN", "en-US"]), "zh-CN");
  assert.equal(detectLocale(["zh-TW"]), "zh-CN");
  assert.equal(detectLocale(["en-US", "zh-CN"]), "en");
  assert.equal(detectLocale(["ja-JP"]), "en");
  assert.equal(detectLocale([]), "en");
});

test("手动语言设置覆盖浏览器语言并可持久保存", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }
  };

  assert.equal(readLocalePreference(storage), "browser");
  assert.equal(resolveLocale(readLocalePreference(storage), ["zh-CN"]), "zh-CN");
  assert.equal(saveLocalePreference("en", storage), true);
  assert.equal(values.get(APP_LOCALE_STORAGE_KEY), "en");
  assert.equal(readLocalePreference(storage), "en");
  assert.equal(resolveLocale(readLocalePreference(storage), ["zh-CN"]), "en");

  assert.equal(saveLocalePreference("browser", storage), true);
  assert.equal(readLocalePreference(storage), "browser");
  assert.equal(resolveLocale(readLocalePreference(storage), ["en-US"]), "en");

  values.set(APP_LOCALE_STORAGE_KEY, "unsupported");
  assert.equal(readLocalePreference(storage), "browser");
});

test("英文界面翻译静态、动态和对话框文本", () => {
  assert.equal(translateText("新建项目", "en"), "New project");
  assert.equal(translateText("已连接 · 12 个文件", "en"), "Connected · 12 files");
  assert.equal(translateText("上下文 8k / 32k · 25% · 已压缩 9 条", "en"), "Context 8k / 32k · 25% · 9 compressed");
  assert.equal(translateText("Agent 正在执行第 2 轮…", "en"), "Agent is running turn 2…");
  assert.equal(translateText("Agent 正在执行第 3 个模型回合。", "en"), "Agent is running model turn 3.");
  assert.equal(translateText("文本 通过 · 流式 通过 · 工具 通过 · 图片 不支持", "en"), "Text passed · Streaming passed · Tools passed · Images not supported");
  assert.equal(translateText("Agent 请求执行需要授权的工具：workspace.write\n\n仅允许此次调用？", "en"), "The Agent is requesting permission to run this tool:workspace.write\n\nAllow this call once?");
});

test("英文界面覆盖模型配置与项目连接的常见提示", () => {
  assert.equal(
    translateText("无法取得当前模型的能力信息，请刷新模型列表。 ", "en"),
    "Could not load capabilities for the current model. Refresh the model list. "
  );
  assert.equal(
    translateText("项目尚未连接，已阻止无工具模型回合。请重新选择项目文件夹。 ", "en"),
    "The project is not connected, so a model turn without tools was blocked. Select the project folder again. "
  );
  assert.equal(translateText("供应商显示名称：", "en"), "Provider display name:");
  assert.equal(translateText("模型列表刷新失败：boom", "en"), "Model list refresh failed: boom");
  assert.equal(translateText("模型列表刷新失败：boom。", "en"), "Model list refresh failed: boom.");
  assert.equal(translateText("模型配置已保存；发送任务前还需填写 API Key。", "en"), "Model settings saved. Enter an API key before sending a task.");
  assert.equal(translateText("模型列表 Endpoint 仅支持 HTTP 或 HTTPS。", "en"), "Model list endpoint must use HTTP or HTTPS.");
});

test("英文界面翻译带变量的常见运行消息并保留用户值", () => {
  assert.equal(
    translateText("  已迁移 3 条历史对话；旧项目需要重新关联一次文件夹。 ", "en"),
    "  Migrated 3 conversations. Existing projects must be relinked once. "
  );
  assert.equal(
    translateText("模型 gpt-custom 的工具调用能力未知。\n\n只有确认该模型支持工具调用才能继续。是否由你声明支持？", "en"),
    "Tool-calling capability is unknown for model gpt-custom.\n\nContinue only if you confirm that the model supports tool calling. Do you want to declare it supported?"
  );
  assert.equal(translateText("报告.png 超过单图 8 MiB 限制。", "en"), "报告.png exceeds the 8 MiB per-image limit.");
  assert.equal(
    translateText("导入完成：2 个对话、5 条消息、1 个附件。项目目录需要重新关联。", "en"),
    "Import complete: 2 conversations, 5 messages, and 1 attachments. Project folders must be relinked."
  );
});

test("中文界面和未知内容保持原样", () => {
  assert.equal(translateText("新建项目", "zh-CN"), "新建项目");
  assert.equal(translateText("用户自己的项目名称", "en"), "用户自己的项目名称");
});
