export type AppLocale = "zh-CN" | "en";
export type AppLocalePreference = "browser" | AppLocale;

export const APP_LOCALE_STORAGE_KEY = "browser-agent-runtime:locale";

const ENGLISH_TEXT: Readonly<Record<string, string>> = {
  "新建任务": "New task", "新建项目": "New project", "项目": "Projects", "项目和对话": "Projects and conversations", "还没有项目": "No projects yet",
  "项目工作区面板": "Project workspace panels", "文件": "Files", "运行": "Runs", "设置": "Settings", "插件": "Plugins",
  "外观与语言": "Appearance and language", "界面语言": "Interface language", "跟随浏览器": "Use browser language", "简体中文": "Simplified Chinese",
  "选择界面显示语言；设置会保存在当前浏览器中。": "Choose the interface language. This setting is saved in the current browser.",
  "更改语言后页面会自动重新载入。": "The page reloads automatically after you change the language.", "无法保存语言设置。": "Could not save the language setting.",
  "选择项目文件夹开始": "Select a project folder to get started", "未连接": "Disconnected",
  "在浏览器里操作真实项目": "Work with real projects in your browser",
  "点击左侧“新建任务”并选择一个文件夹。对话、项目关系和目录句柄都会保存在当前浏览器。": "Select New task on the left and choose a folder. Conversations, project links, and directory handles stay in this browser.",
  "点击左侧“新建项目”并选择一个文件夹。对话、项目关系和目录句柄都会保存在当前浏览器。": "Select New project on the left and choose a folder. Conversations, project links, and directory handles stay in this browser.",
  "输入任务…": "Describe a task…",
  "上下文尚未估算": "Context not estimated yet", "立即压缩": "Compress now", "添加图片": "Add images",
  "添加 JPEG、PNG 或 WebP 图片": "Add JPEG, PNG, or WebP images", "＋ 图片": "+ Image",
  "选择当前对话使用的供应商和模型": "Choose the provider and model for this conversation", "模型供应商": "Model provider",
  "供应商": "Provider", "模型": "Model", "刷新模型列表": "Refresh models", "请选择项目文件夹": "Select a project folder",
  "停止运行": "Stop run", "停止当前运行": "Stop the current run", "发送": "Send", "终端": "Terminal",
  "未启动": "Not started", "展开终端": "Expand terminal", "收起终端": "Collapse terminal", "启动 Runtime": "Start Runtime",
  "Runtime 已启动": "Runtime started", "清空": "Clear", "文件树": "File tree", "搜索、变更与 Diff": "Search, changes, and diff",
  "关闭文件面板": "Close files panel", "搜索项目文件": "Search project files", "搜索文件…": "Search files…",
  "选择项目后显示文件。": "Files appear after you select a project.", "没有匹配的文件。": "No matching files.",
  "状态": "Status", "历史": "History", "查看 Diff": "View diff",
  "关闭 Diff": "Close diff", "运行记录": "Run history", "状态、耗时与修改文件": "Status, duration, and changed files",
  "关闭运行面板": "Close runs panel", "最近运行": "Recent runs", "尚无运行记录。": "No runs yet.",
  "恢复记录": "Recovery history", "尚无 ChangeSet。": "No ChangeSets yet.", "所有配置均在浏览器中完成": "All settings are managed in your browser",
  "关闭": "Close", "项目权限与指令": "Project permissions and instructions",
  "新项目默认在写入或执行前确认；只读模式不会向模型暴露写入和执行工具。": "New projects ask before writes or execution. Read-only mode does not expose write or execution tools to the model.",
  "权限模式": "Permission mode", "只读": "Read only", "写入前确认": "Confirm writes", "自动允许": "Allow automatically",
  "启用项目指令": "Enable project instructions", "未发现 AGENTS.md 或 .browser-agent/instructions.md": "No AGENTS.md or .browser-agent/instructions.md found",
  "模型与 API": "Models and API",
  "Endpoint 和模型名持久保存；API Key 仅保留到当前浏览器会话结束。": "The endpoint and model name are saved. The API key lasts only for the current browser session.",
  "添加 OpenAI-compatible": "Add OpenAI-compatible", "兼容 Gateway": "Compatible Gateway", "保存模型配置": "Save model settings",
  "尚未测试当前模型。": "The current model has not been tested.", "正在测试文本、流式、工具调用和图片输入…": "Testing text, streaming, tool calling, and image input…",
  "已排队": "Queued", "撤回": "Withdraw", "排队发送": "Queue message", "从检查点继续": "Resume from checkpoint",
  "浏览器内 Virtual Bash / QuickJS / npm": "In-browser Virtual Bash / QuickJS / npm", "项目目录": "Project folder",
  "直接读写所选真实文件夹": "Reads and writes the selected folder directly", "限制": "Limitations",
  "不支持系统进程、Python、Docker 或 Node 原生扩展": "No system processes, Python, Docker, or native Node.js addons",
  "安装 Skill 文件夹": "Install Skill folder", "管理 Skills 与 MCP Server": "Manage Skills and MCP servers",
  "系统 Skills": "System Skills", "用户 Skills": "User Skills", "项目 Skills": "Project Skills", "随应用提供": "Included with the app",
  "刷新项目 Skills": "Refresh project Skills", "连接项目后，将自动读取 .browser-agent/skills。": "Project Skills are loaded automatically from .browser-agent/skills after a project is connected.",
  "系统 Skill 提供内置能力，用户 Skill 保存在浏览器中，项目 Skill 从当前项目的 .browser-agent/skills/<name>/SKILL.md 自动发现。同名时按“项目 → 用户 → 系统”生效。": "System Skills provide built-in capabilities, user Skills are stored in the browser, and project Skills are discovered from .browser-agent/skills/<name>/SKILL.md. Matching names resolve in project, user, then system order.",
  "MCP Server": "MCP Server", "名称": "Name", "添加 MCP Server": "Add MCP server", "尚未配置 MCP Server": "No MCP servers configured",
  "Streamable HTTP": "Streamable HTTP", "例如：团队知识库": "For example: Team knowledge base", "关闭插件": "Close Plugins",
  "添加远程 HTTP MCP Endpoint。连接与每次工具调用都经过当前项目的网络授权；Endpoint 不保存鉴权密钥。": "Add a remote HTTP MCP endpoint. Connections and tool calls use the current project's network authorization. Authentication secrets are not stored.",
  "测试连接": "Test connection", "移除": "Remove", "尚未测试": "Not tested",
  "诊断日志": "Diagnostic logs", "刷新": "Refresh", "导出 JSONL": "Export JSONL",
  "记录时间、级别、模块、运行状态和错误栈；不会记录 API Key、Authorization 或文件正文。": "Records timestamps, levels, modules, run status, and error stacks. API keys, authorization headers, and file contents are excluded.",
  "保存诊断日志": "Save diagnostic logs", "关闭后仅在控制台保留 WARN 和 ERROR。": "When disabled, only WARN and ERROR remain in the console.",
  "同时写入项目 .browser-agent": "Also write to project .browser-agent", "以脱敏 JSONL 写入项目日志目录。": "Write redacted JSONL to the project log directory.",
  "最低日志级别": "Minimum log level", "TRACE · 最完整": "TRACE · Most detail", "DEBUG · 排障推荐": "DEBUG · Recommended for troubleshooting",
  "INFO · 常规": "INFO · Standard", "WARN · 警告及错误": "WARN · Warnings and errors", "ERROR · 仅错误": "ERROR · Errors only",
  "本地数据": "Local data", "对话与项目": "Conversations and projects", "IndexedDB，保留到手动删除": "IndexedDB, retained until manually deleted",
  "Skills 与恢复数据": "Skills and recovery data", "存储使用": "Storage usage", "正在读取…": "Loading…",
  "导出项目数据": "Export project data", "导入项目数据": "Import project data", "尚无诊断日志": "No diagnostic logs yet",
  "尚未安装 Skill": "No Skills installed", "尚无系统 Skill": "No system Skills", "尚未添加用户 Skill": "No user Skills added",
  "当前项目尚无 Skill": "No Skills in the current project", "无需额外权限": "No additional permissions", "查看": "Inspect", "启用": "Enable",
  "禁用": "Disable", "卸载": "Uninstall", "已启用": "Enabled", "已禁用": "Disabled", "恢复": "Restore",
  "整次恢复": "Restore entire run", "基于当前状态重试": "Retry from current state", "回滚后重试": "Rollback and retry",
  "运行中": "Running", "运行已暂停": "Run paused", "运行完成": "Run completed", "运行失败": "Run failed", "运行已取消": "Run cancelled", "运行已中断": "Run interrupted", "已完成": "Completed", "失败": "Failed",
  "已取消": "Cancelled", "已中断": "Interrupted", "已恢复": "Restored", "已暂停": "Paused", "记录中": "Recording",
  "引导当前任务": "Steer current task", "完成后执行": "Run after completion", "等待引导当前任务": "Waiting to steer current task", "等待当前任务完成": "Waiting for current task to finish", "已投递到当前任务": "Delivered to current task", "已消费": "Consumed", "已撤回": "Withdrawn",
  "模型和项目已就绪": "Model and project are ready", "项目未连接，文件工具不可用": "Project disconnected; file tools unavailable",
  "项目未连接，工作模式暂不可用": "No project is connected; work mode is temporarily unavailable",
  "请先配置模型 API": "Configure a model API first", "请在设置中配置模型 API": "Configure the model API in Settings",
  "Agent 正在工作…": "Agent is working…", "正在恢复项目连接…": "Restoring project connection…", "需要恢复权限": "Permission required",
  "权限已拒绝": "Permission denied", "目录句柄已失效": "Directory handle is no longer valid", "恢复文件夹访问": "Restore folder access",
  "重新关联文件夹": "Relink folder", "运行已由用户停止。": "The run was stopped by the user.",
  "正在停止模型、工具与 Runtime…": "Stopping model, tools, and Runtime…", "运行变更已恢复。": "Run changes restored.",
  "待重新关联": "Relink required", "项目文件夹尚未连接。": "The project folder is not connected.",
  "当前浏览器缺少 WebAssembly 或 Web Worker，无法启动虚拟 Runtime。": "This browser lacks WebAssembly or Web Workers required by the virtual Runtime.",
  "所选文件夹不是该项目原来的目录；请重新选择。": "The selected folder is not the original project folder. Choose it again.",
  "请先完成模型 API 配置；当前输入已保留。": "Complete the model API settings first. Your current input has been preserved.",
  "项目尚未连接，已阻止无工具模型回合。请重新选择项目文件夹。": "The project is not connected, so a model turn without tools was blocked. Select the project folder again.",
  "无法取得当前模型的能力信息，请刷新模型列表。": "Could not load capabilities for the current model. Refresh the model list.",
  "供应商显示名称：": "Provider display name:", "默认模型 ID：": "Default model ID:",
  "模型配置已保存；发送任务前还需填写 API Key。": "Model settings saved. Enter an API key before sending a task.",
  "已保存。API Key 仅保留在当前浏览器会话。": "Saved. The API key is retained only for this browser session.",
  "Endpoint 和模型不能为空。": "Endpoint and model are required.", "API Endpoint 不是有效的网址。": "The API endpoint is not a valid URL.",
  "API Endpoint 仅支持 HTTP 或 HTTPS。": "The API endpoint must use HTTP or HTTPS.",
  "请勿在 API Endpoint 中包含用户名或密码。": "Do not include a username or password in the API endpoint.",
  "供应商名称和默认模型不能为空。": "Provider name and default model are required.", "模型 ID 不能为空。": "Model ID is required.",
  "模型列表 Endpoint": "Model list endpoint",
  "配置已保存，但 Gateway 连接超时。请确认服务已启动且地址正确。": "Settings saved, but the Gateway connection timed out. Confirm that the service is running and the address is correct.",
  "兼容供应商已添加；请填写本会话使用的 API Key。": "Compatible provider added. Enter the API key for this browser session.",
  "上下文滚动摘要已更新；原始消息仍完整保留。": "The rolling context summary was updated. Original messages remain intact.",
  "持久日志已关闭；控制台仅保留 warn/error。": "Persistent logging is off. Only warn/error entries remain in the console.",
  "没有找到可恢复的文件变更。": "No restorable file changes were found.",
  "内置 Skill 不能卸载，可选择禁用。": "Built-in Skills cannot be uninstalled, but they can be disabled.",
  "请先连接要导出的项目。": "Connect the project you want to export first.",
  "请先选择一个项目对话。": "Select a project conversation first.",
  "项目配置、对话、Skill、附件和恢复索引已导出；不含 API Key。": "Project settings, conversations, Skills, attachments, and recovery indexes were exported. API keys were excluded.",
  "导入会写入本地 Browser Agent 数据库；同 ID 记录将被覆盖。是否继续？": "Importing writes to the local Browser Agent database and overwrites records with matching IDs. Continue?",
  "没有文本差异。": "No text differences.",
  "未知": "Unknown", "无": "None", "模型未知": "Unknown model", "上下文未知": "Unknown context window",
  "工具": "Tools", "图片": "Images", "耗时": "Duration", "网络": "Network", "变更": "Changes",
  "读取项目": "Read project", "写入项目": "Write project", "访问网络": "Access network", "执行脚本": "Execute scripts",
  "调用参数": "Arguments", "输出": "Output", "等待工具输出…": "Waiting for tool output…",
  "工具未返回输出，运行已结束。": "The tool returned no output and the run has ended.", "步骤失败，正在重新规划": "Step failed; replanning",
  "点击展开或收起": "Click to expand or collapse", "Agent 工具": "Agent tool", "终端记录": "Terminal output", "执行错误": "Execution error",
  "运行中消息发送方式": "Message delivery while running", "选择消息是引导当前任务，还是在当前任务完成后执行": "Choose whether to steer the current task or run the message after it finishes",
  "仅支持 JPEG、PNG 和 WebP": "Only JPEG, PNG, and WebP are supported", "单张图片不能超过 8 MiB": "Each image must be 8 MiB or smaller",
  "单条消息的图片合计不能超过 16 MiB": "Images in one message must total 16 MiB or less",
  "项目健康检查": "Project health check", "修复测试": "Fix tests", "修复测试失败": "Fix failing tests",
  "只读审查": "Read-only review", "只读代码审查": "Read-only code review", "修改并验证": "Change and verify",
  "CSV 报告": "CSV report", "CSV 分析报告": "CSV analysis report", "Word 报告": "Word report",
  "PPT 汇报": "PowerPoint briefing", "PDF 输出": "PDF output",
  "在浏览器主线程检查或创建真实项目中的 DOCX 文档；适用于 Word、报告、说明文档和 DOCX 输出任务。": "Inspect or create DOCX documents in the real project from the browser main thread. Use for Word documents, reports, documentation, and DOCX output.",
  "在真实项目目录中读取、搜索、整理、移动或删除文件；适用于文件归类、重命名、目录清理和批量文本调整任务。": "Read, search, organize, move, or delete files in the real project. Use for file organization, renaming, directory cleanup, and batch text changes.",
  "在浏览器主线程检查、分页读取、渲染、创建或合并 PDF；适用于报告、归档、页面提取和 PDF 输出任务。": "Inspect, read by page, render, create, or merge PDFs in the browser main thread. Use for reports, archives, page extraction, and PDF output.",
  "在浏览器主线程检查或创建简洁 PPTX；适用于 PowerPoint、演示文稿、幻灯片和 PPTX 输出任务。": "Inspect or create concise PPTX files in the browser main thread. Use for PowerPoint presentations, slide decks, and PPTX output.",
  "在浏览器主线程读取、分析、转换或创建真实项目中的 XLSX、XLS、CSV；适用于 Excel、工作簿、表格、筛选、排序、去重和分组计数任务。": "Read, analyze, convert, or create XLSX, XLS, and CSV files in the real project from the browser main thread. Use for Excel, workbooks, tables, filtering, sorting, deduplication, and grouped counts.",
  "开始启动 Browser Agent": "Starting Browser Agent", "诊断日志系统已就绪": "Diagnostic logging is ready", "Browser Agent 启动完成": "Browser Agent started",
  "请检查当前项目的结构、依赖、构建、测试和明显风险，先读取证据，再给出按优先级排序的结论。": "Inspect the project structure, dependencies, build, tests, and obvious risks. Read evidence first, then provide prioritized findings.",
  "请运行测试定位失败原因，实施最小范围修复，并重新运行相关测试验证。": "Run the tests, identify the failure, implement the smallest appropriate fix, and rerun relevant tests.",
  "请以只读方式审查当前项目，不修改文件；列出有证据支持的问题、影响和建议。": "Review the project without changing files. List evidence-backed issues, impact, and recommendations.",
  "请完成我描述的修改，保留无关用户改动，并运行与风险相称的检查验证结果。\n\n修改目标：": "Implement the change described below, preserve unrelated user changes, and run checks proportionate to the risk.\n\nChange target:",
  "请分析相关项目数据并生成可复核的 CSV 报告，写入我指定的位置；完成后重新读取验证。": "Analyze the relevant project data and create a reviewable CSV report at the requested location, then reopen it to verify the result.",
  "请基于项目中的真实证据生成结构化 Word 报告（DOCX），写入我指定的位置；完成后验证并重新检查文档。": "Create a structured Word report (DOCX) from real project evidence at the requested location, then validate and inspect it again.",
  "请基于项目中的真实证据制作多页 PPT 汇报，写入我指定的位置；完成后验证并重新检查演示文稿。": "Create a multi-slide PowerPoint briefing from real project evidence at the requested location, then validate and inspect it again.",
  "请基于项目中的真实证据生成 PDF，写入我指定的位置；完成后验证并重新检查页面内容与结构。": "Create a PDF from real project evidence at the requested location, then validate and inspect its page content and structure again."
};

const DYNAMIC_RULES: ReadonlyArray<readonly [RegExp, string | ((...matches: string[]) => string)]> = [
  [/^当前来源：(.*)$/u, (_all, source) => `Current source: ${source}`],
  [/^已连接 · (\d+) 个文件$/u, (_all, count) => `Connected · ${count} files`],
  [/^(\d+) 个步骤$/u, (_all, count) => `${count} steps`],
  [/^Agent 正在执行第 (\d+) 轮…$/u, (_all, turn) => `Agent is running turn ${turn}…`],
  [/^Agent 正在执行第 (\d+) 个模型回合。$/u, (_all, turn) => `Agent is running model turn ${turn}.`],
  [/^运行 ([^ ]+)$/u, (_all, id) => `Run ${id}`],
  [/^(.*) · (\d+) 项变更 · (.*)$/u, (_all, status, count, date) => `${translateText(status)} · ${count} changes · ${date}`],
  [/^上下文 (.+) \/ (.+) · (\d+)% · 已压缩 (\d+) 条$/u, (_all, used, limit, percent, count) => `Context ${used} / ${limit} · ${percent}% · ${count} compressed`],
  [/^上下文 (.+) \/ (.+) · (\d+)%$/u, (_all, used, limit, percent) => `Context ${used} / ${limit} · ${percent}%`],
  [/^估算 (.+) tokens；上下文窗口 (.+) tokens$/u, (_all, used, limit) => `Estimated ${used} tokens; context window ${limit} tokens`],
  [/^删除对话：(.*)$/u, (_all, title) => `Delete conversation: ${title}`],
  [/^在 (.*) 中新建对话$/u, (_all, project) => `Create a conversation in ${project}`],
  [/^移除 (.*)$/u, (_all, name) => `Remove ${name}`],
  [/^查看 (.*) 的 Diff$/u, (_all, path) => `View diff for ${path}`],
  [/^恢复 (.*) 的最近一次变更$/u, (_all, path) => `Restore the latest change to ${path}`],
  [/^(.+) 秒$/u, (_all, seconds) => `${seconds} sec`],
  [/^(\d+)分 (\d+)秒$/u, (_all, minutes, seconds) => `${minutes}m ${seconds}s`],
  [/^已刷新 (\d+) 个模型。$/u, (_all, count) => `Refreshed ${count} models.`],
  [/^已导出 (\d+) 条诊断日志。$/u, (_all, count) => `Exported ${count} diagnostic log entries.`],
  [/^已暂存 (\d+) 个本地路径；未执行推送。$/u, (_all, count) => `Staged ${count} local paths; nothing was pushed.`],
  [/^项目权限模式已设为 (.+)。$/u, (_all, mode) => `Project permission mode set to ${mode}.`],
  [/^已迁移 (\d+) 条历史对话；旧项目需要重新关联一次文件夹。$/u, (_all, count) => `Migrated ${count} conversations. Existing projects must be relinked once.`],
  [/^模型 (.+) 的工具调用能力未知。\n\n只有确认该模型支持工具调用才能继续。是否由你声明支持？$/u, (_all, model) => `Tool-calling capability is unknown for model ${model}.\n\nContinue only if you confirm that the model supports tool calling. Do you want to declare it supported?`],
  [/^模型 (.+) 的图片输入能力未知。\n\n是否由你声明该模型支持图片输入？$/u, (_all, model) => `Image-input capability is unknown for model ${model}.\n\nDo you want to declare that this model supports image input?`],
  [/^(.+) 不是支持的 JPEG、PNG 或 WebP 图片。$/u, (_all, name) => `${name} is not a supported JPEG, PNG, or WebP image.`],
  [/^(.+) 超过单图 8 MiB 限制。$/u, (_all, name) => `${name} exceeds the 8 MiB per-image limit.`],
  [/^已保留手动模型；目录刷新有提示：(.+)$/u, (_all, warning) => `The manually entered model was retained; model discovery reported: ${warning}`],
  [/^模型列表刷新失败：(.+?)([。.])?$/u, (_all, reason, punctuation) => `Model list refresh failed: ${reason}${punctuation ? "." : ""}`],
  [/^找不到模型供应商：(.+)$/u, (_all, provider) => `Model provider not found: ${provider}`],
  [/^配置已保存，但 Gateway 返回 (\d+)。请检查地址和服务日志。$/u, (_all, status) => `Settings saved, but Gateway returned ${status}. Check the address and service logs.`],
  [/^配置已保存，但无法连接 Gateway：(.+)$/u, (_all, reason) => `Settings saved, but Gateway could not be reached: ${reason}`],
  [/^模型 (.+) 尚未通过工具调用测试。$/u, (_all, model) => `Model ${model} has not passed the tool-calling test.`],
  [/^模型 (.+) 尚未通过图片输入测试。$/u, (_all, model) => `Model ${model} has not passed the image-input test.`],
  [/^文本 (通过|失败) · 流式 (通过|失败) · 工具 (通过|失败) · 图片 (通过|失败|不支持)$/u, (_all, text, streaming, tools, images) => `Text ${text === "通过" ? "passed" : "failed"} · Streaming ${streaming === "通过" ? "passed" : "failed"} · Tools ${tools === "通过" ? "passed" : "failed"} · Images ${images === "通过" ? "passed" : images === "不支持" ? "not supported" : "failed"}`],
  [/^(.+ Endpoint) 不是有效的网址。$/u, (_all, label) => `${translateText(label, "en")} is not a valid URL.`],
  [/^(.+ Endpoint) 仅支持 HTTP 或 HTTPS。$/u, (_all, label) => `${translateText(label, "en")} must use HTTP or HTTPS.`],
  [/^请勿在 (.+ Endpoint) 中包含用户名或密码。$/u, (_all, label) => `Do not include a username or password in ${translateText(label, "en")}.`],
  [/^压缩失败，原始历史未受影响：(.+)$/u, (_all, reason) => `Compression failed; original history was not affected: ${reason}`],
  [/^无法打开项目文件：(.+)$/u, (_all, reason) => `Could not open the project file: ${reason}`],
  [/^已安装 Skill：(.+)$/u, (_all, name) => `Installed Skill: ${name}`],
  [/^Skill 安装失败：(.+)$/u, (_all, reason) => `Skill installation failed: ${reason}`],
  [/^已从当前项目加载 (\d+) 个 Skill。$/u, (_all, count) => `Loaded ${count} Skills from the current project.`],
  [/^MCP 连接正常：发现 (\d+) 个工具。$/u, (_all, count) => `MCP connection succeeded: ${count} tools discovered.`],
  [/^已添加 MCP Server：(.+)$/u, (_all, name) => `Added MCP server: ${name}`],
  [/^测试失败：(.+)$/u, (_all, reason) => `Test failed: ${reason}`],
  [/^是否把 (.+) 保存到当前项目的网络白名单？$/u, (_all, host) => `Save ${host} to this project's network allowlist?`],
  [/^导入完成：(\d+) 个对话、(\d+) 条消息、(\d+) 个附件。项目目录需要重新关联。$/u, (_all, threads, messages, attachments) => `Import complete: ${threads} conversations, ${messages} messages, and ${attachments} attachments. Project folders must be relinked.`]
];

const PHRASE_TRANSLATIONS: ReadonlyArray<readonly [string, string]> = [
  ["是否继续？", "Continue?"], ["是否仅允许此次访问？", "Allow this access once?"], ["仅允许此次调用？", "Allow this call once?"],
  ["最终 URL：", "Final URL: "], ["网页内容将作为不可信输入处理。", "Web content will be treated as untrusted input."],
  ["Agent 首次请求访问外部域名：", "The Agent is requesting this external domain for the first time:"],
  ["Agent 请求执行需要授权的工具：", "The Agent is requesting permission to run this tool:"],
  ["确定删除对话", "Delete conversation"], ["其中的消息和运行记录将永久删除。", "Its messages and run history will be permanently deleted."],
  ["确定卸载 Skill", "Uninstall Skill"], ["是否允许本次运行后续所有写入和执行操作？", "Allow all subsequent write and execution operations in this run?"],
  ["选择“取消”只授权刚才这一项。", "Choose Cancel to authorize only the previous operation."],
  ["当前模型明确不支持工具调用，不能运行项目 Agent。", "This model does not support tool calling and cannot run the project Agent."],
  ["当前模型不支持图片输入，请切换模型后重试。", "This model does not support image input. Switch models and try again."],
  ["工具调用能力未知", "tool-calling capability is unknown"], ["图片输入能力未知", "image-input capability is unknown"],
  ["是否由你声明支持？", "Do you want to declare it supported?"], ["是否由你声明该模型支持图片输入？", "Do you want to declare that this model supports image input?"],
  ["版本：", "Version: "], ["来源：", "Source: "], ["权限：", "Permissions: "], ["未声明版本", "unspecified version"], ["未声明", "unspecified"],
  ["项目未连接。", "Project is not connected."], ["项目尚未连接。", "Project is not connected."],
  ["用户拒绝执行工具：", "User denied tool execution: "], ["用户拒绝访问域名：", "User denied domain access: "],
  ["当前浏览器不支持文件夹读写，请使用桌面版 Chrome 或 Edge。", "This browser cannot read and write folders. Use desktop Chrome or Edge."],
  ["请先输入要查看的文件路径。", "Enter a file path to inspect first."], ["请先输入要暂存的文件路径。", "Enter file paths to stage first."],
  ["当前页面不支持 Runtime", "Runtime is unavailable on this page"], ["可启动 · 无需容器密钥", "Ready · no container key required"],
  ["正在启动…", "Starting…"], ["启动失败", "Startup failed"], ["Virtual Runtime 已连接", "Virtual Runtime connected"],
  ["请分析这些图片。", "Please analyze these images."], ["请检查 Gateway 配置。", "Check the Gateway configuration."],
  ["发送任务前需要填写 API Key。", "Enter an API key before sending a task."], ["配置已保存", "Settings saved"],
  ["正在保存…", "Saving…"], ["正在连接 Gateway…", "Connecting to Gateway…"], ["Gateway 连接失败", "Gateway connection failed"],
  ["消息已排队；可在消息旁撤回。", "Message queued. You can withdraw it beside the message."], ["已撤回排队消息。", "Queued message withdrawn."],
  ["该消息已开始执行，不能再撤回。", "This message has started and can no longer be withdrawn."],
  ["当前运行结束前不能切换对话；你仍可在当前对话中排队消息。", "You cannot switch conversations until the current run ends. You can still queue messages here."],
  ["请先运行 Quick Test，验证工具调用能力。", "Run Quick Test to verify tool-calling capability."],
  ["请先运行 Quick Test，验证图片输入能力。", "Run Quick Test to verify image-input capability."],
  ["该运行的检查点无效，不能安全继续。", "This run has an invalid checkpoint and cannot be resumed safely."],
  ["Gateway 配置需要检查", "Check Gateway settings"],
  ["模型列表刷新失败：", "Model list refresh failed: "], ["供应商显示名称：", "Provider display name:"], ["默认模型 ID：", "Default model ID:"],
  ["模型不会自动收到整个项目；文件内容只在工具按需读取后进入上下文。", "The model does not receive the whole project automatically. File contents enter context only when a tool reads them."],
  ["API Key 仅保留在当前浏览器会话。", "The API key is retained only for this browser session."],
  ["诊断日志设置已更新。", "Diagnostic log settings updated."], ["诊断日志已清空。", "Diagnostic logs cleared."],
  ["浏览器未提供存储统计", "Storage statistics are unavailable"], ["项目目录需要重新关联。", "The project folder must be relinked."],
  ["不含 API Key", "API keys excluded"], ["文件不包含 API Key", "The file does not contain API keys"],
  ["浏览器阻止了新窗口，文件已改为下载。", "The browser blocked the new window, so the file was downloaded instead."],
  ["终端显示和已保存的终端记录已清空。", "The terminal display and saved terminal history were cleared."],
  ["应用启动失败", "Application startup failed"], ["Browser Agent 启动失败", "Browser Agent failed to start"]
];

export function detectLocale(languages?: readonly string[]): AppLocale {
  const candidates = languages ?? (typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language]);
  return candidates[0]?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

function browserStorage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  try { return typeof localStorage === "undefined" ? undefined : localStorage; }
  catch { return undefined; }
}

export function readLocalePreference(storage: Pick<Storage, "getItem"> | undefined = browserStorage()): AppLocalePreference {
  try {
    const value = storage?.getItem(APP_LOCALE_STORAGE_KEY);
    return value === "zh-CN" || value === "en" ? value : "browser";
  } catch { return "browser"; }
}

export function saveLocalePreference(preference: AppLocalePreference, storage: Pick<Storage, "setItem"> | undefined = browserStorage()): boolean {
  try {
    storage?.setItem(APP_LOCALE_STORAGE_KEY, preference);
    return Boolean(storage);
  } catch { return false; }
}

export function resolveLocale(preference: AppLocalePreference, languages?: readonly string[]): AppLocale {
  return preference === "browser" ? detectLocale(languages) : preference;
}

export const appLocale: AppLocale = resolveLocale(readLocalePreference());

export function translateText(value: string, locale: AppLocale = appLocale): string {
  if (locale === "zh-CN" || !value) return value;
  const leading = value.match(/^\s*/u)?.[0] ?? "";
  const trailing = value.match(/\s*$/u)?.[0] ?? "";
  const core = value.slice(leading.length, value.length - trailing.length);
  const direct = ENGLISH_TEXT[core];
  if (direct) return `${leading}${direct}${trailing}`;
  for (const [pattern, replacement] of DYNAMIC_RULES) {
    if (pattern.test(core)) return `${leading}${core.replace(pattern, replacement as string)}${trailing}`;
  }
  let translated = value;
  for (const [source, target] of PHRASE_TRANSLATIONS) translated = translated.replaceAll(source, target);
  return translated;
}

export function t(chinese: string, english?: string): string { return appLocale === "zh-CN" ? chinese : english ?? translateText(chinese, "en"); }

const SKIP_LOCALIZATION = "#message-feed, #terminal-host, #diff-content, [data-no-localize]";
const LOCALIZED_ATTRIBUTES = ["aria-label", "placeholder", "title"] as const;

function shouldSkip(node: Node): boolean {
  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  return Boolean(element?.closest(SKIP_LOCALIZATION));
}

function localizeNode(node: Node): void {
  if (shouldSkip(node)) return;
  if (node.nodeType === Node.TEXT_NODE) {
    const current = node.nodeValue ?? "";
    const next = translateText(current);
    if (next !== current) node.nodeValue = next;
    return;
  }
  if (!(node instanceof Element)) return;
  for (const attribute of LOCALIZED_ATTRIBUTES) {
    const current = node.getAttribute(attribute);
    if (!current) continue;
    const next = translateText(current);
    if (next !== current) node.setAttribute(attribute, next);
  }
  for (const child of node.childNodes) localizeNode(child);
}

export function installBrowserLanguage(root: Document = document): AppLocale {
  root.documentElement.lang = appLocale;
  if (appLocale === "zh-CN") return appLocale;
  localizeNode(root.body);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "characterData") localizeNode(record.target);
      else for (const node of record.addedNodes) localizeNode(node);
    }
  });
  observer.observe(root.body, { childList: true, characterData: true, subtree: true });

  const originalAlert = window.alert.bind(window);
  const originalConfirm = window.confirm.bind(window);
  const originalPrompt = window.prompt.bind(window);
  window.alert = (message?: unknown): void => originalAlert(translateText(String(message ?? "")));
  window.confirm = (message?: string): boolean => originalConfirm(translateText(message ?? ""));
  window.prompt = (message?: string, defaultValue?: string): string | null => originalPrompt(translateText(message ?? ""), defaultValue === undefined ? undefined : translateText(defaultValue));
  return appLocale;
}
