export const WEBCONTAINER_API_KEY_ENV_NAME = "VITE_WEBCONTAINER_API_KEY";

type WebContainerBuildEnvironment = Record<string, unknown> | undefined;

export function resolveWebContainerApiKey(
  environment: WebContainerBuildEnvironment = (import.meta as ImportMeta & { env?: Record<string, unknown> }).env
): string {
  const value = environment?.[WEBCONTAINER_API_KEY_ENV_NAME];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      `未配置 ${WEBCONTAINER_API_KEY_ENV_NAME}。请先在 StackBlitz WebContainer API 设置中取得 client key，` +
      "再将它配置到 apps/web/.env.local 或部署平台的同名构建变量后完整刷新页面。"
    );
  }
  return value.trim();
}
