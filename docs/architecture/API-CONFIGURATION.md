# API 配置

全部配置都在左下角“设置”中完成，无需创建 `.env`。

- Endpoint、模型和 Provider 模式保存到 IndexedDB。
- API Key 仅保存到当前标签页的 sessionStorage，关闭浏览器会话后需要重新填写。
- API Key 不会写入项目文件、对话记录、LocalStorage 或源码。
- Agent 初始只向模型发送近期对话和工具 schema；项目文件仅在模型显式调用 `workspace.read` 后按需进入后续上下文，不会自动发送整个目录。

DeepSeek 默认配置：

```text
Provider: DeepSeek Chat Completions
Endpoint: https://api.deepseek.com/chat/completions
Model: deepseek-chat
```

该模式由 LangChain `ChatDeepSeek` 驱动。为兼容已有设置，既可以填写完整的 `/chat/completions` Endpoint，也可以填写 API Base URL；创建模型时会统一转换为 LangChain 所需的 Base URL。

OpenAI Responses 默认配置：

```text
Endpoint: https://api.openai.com/v1/responses
Model: gpt-5.6
```

该模式由 LangChain `ChatOpenAI` 驱动并固定启用 Responses API。已有 `/responses` Endpoint 会自动转换为 LangChain 所需的 Base URL。

如需使用本地或企业 Gateway：

```powershell
corepack pnpm@11.7.0 gateway
```

然后在浏览器选择“兼容 Gateway”，填写 `http://127.0.0.1:8787`。浏览器设置页提交的 Key 只保存在 Gateway 进程内存中。

任何已经出现在聊天、截图、日志或提交记录中的 API Key 都应视为已泄露并立即轮换。
