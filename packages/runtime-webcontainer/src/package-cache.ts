import { BROWSER_AGENT_PACKAGE_DIRECTORY } from "../../workspace-contracts/src/index";

export const RUNTIME_NODE_MODULES_DIRECTORY = "/node_modules";

export function runtimePackageEnvironment(workdir = "/workspace"): Record<string, string> {
  const root = `${workdir.replace(/\/$/, "")}${BROWSER_AGENT_PACKAGE_DIRECTORY}`;
  return {
    npm_config_cache: `${root}/npm-cache`,
    npm_config_prefer_offline: "true",
    npm_config_update_notifier: "false",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_store_dir: `${root}/pnpm-store`,
    YARN_CACHE_FOLDER: `${root}/yarn-cache`
  };
}

export function isRuntimeNodeModulesPath(path: string): boolean {
  const normalized = `/${path.replace(/^\/+/, "")}`.replace(/\/+/g, "/");
  return normalized === RUNTIME_NODE_MODULES_DIRECTORY || normalized.startsWith(`${RUNTIME_NODE_MODULES_DIRECTORY}/`);
}

export function isDependencyMutationCommand(command: string): boolean {
  return /\b(?:npm|pnpm|yarn)\s+(?:i|install|ci|add|remove|rm|uninstall|update|up|upgrade|dedupe|prune)\b/i.test(command);
}
