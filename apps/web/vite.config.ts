import { defineConfig, loadEnv } from "vite";

const WEBCONTAINER_API_KEY_ENV_NAME = "VITE_WEBCONTAINER_API_KEY";

export default defineConfig(({ command, mode }) => {
  const environment = loadEnv(mode, process.cwd(), "");
  if (command === "build" && !environment[WEBCONTAINER_API_KEY_ENV_NAME]?.trim()) {
    throw new Error(
      `生产构建缺少 ${WEBCONTAINER_API_KEY_ENV_NAME}。` +
      "请配置合法的 StackBlitz WebContainer API client key；拒绝生成 Runtime 无法启动的部署产物。"
    );
  }

  return {
    server: {
      headers: {
        "Cross-Origin-Embedder-Policy": "credentialless",
        "Cross-Origin-Opener-Policy": "same-origin"
      }
    },
    preview: {
      headers: {
        "Cross-Origin-Embedder-Policy": "credentialless",
        "Cross-Origin-Opener-Policy": "same-origin"
      }
    }
  };
});
