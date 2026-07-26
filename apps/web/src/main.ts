import "./style.css";
import { installGlobalErrorLogging, logger } from "../../../packages/logging/src/index";
import { BrowserAgentApp } from "./app";
import { installBrowserLanguage, t } from "./i18n";

installBrowserLanguage();
installGlobalErrorLogging();
const mainLog = logger("web.main");
const app = new BrowserAgentApp();
void app.boot().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  mainLog.error("应用启动失败", undefined, error);
  document.body.innerHTML = `<main style="padding:32px;color:#f0a0a0;background:#111;min-height:100vh;font-family:Segoe UI,sans-serif"><h1>${escapeHtml(t("Browser Agent 启动失败", "Browser Agent failed to start"))}</h1><pre style="white-space:pre-wrap">${escapeHtml(message)}</pre></main>`;
});

function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character] ?? character); }
