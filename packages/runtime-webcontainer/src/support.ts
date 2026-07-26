export interface WebContainerSupport {
  supported: boolean;
  secureContext: boolean;
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  message?: string;
}

interface WebContainerEnvironment {
  isSecureContext?: boolean;
  crossOriginIsolated?: boolean;
  SharedArrayBuffer?: unknown;
}

const ISOLATION_HELP = "当前浏览器上下文未提供 WebContainer 必需的 SharedArrayBuffer 跨源隔离能力。请使用 start-dev.ps1 自动打开的独立 Chrome 或 Edge 页面，不要在内嵌浏览器中反复重试。";

export function inspectWebContainerSupport(environment: WebContainerEnvironment = globalThis): WebContainerSupport {
  const secureContext = environment.isSecureContext === true;
  const crossOriginIsolated = environment.crossOriginIsolated === true;
  const sharedArrayBuffer = typeof environment.SharedArrayBuffer === "function";
  if (!secureContext) return { supported: false, secureContext, crossOriginIsolated, sharedArrayBuffer, message: "当前页面不是安全上下文，无法启动浏览器 Runtime。请使用 http://127.0.0.1 或 HTTPS。" };
  if (!crossOriginIsolated || !sharedArrayBuffer) return { supported: false, secureContext, crossOriginIsolated, sharedArrayBuffer, message: ISOLATION_HELP };
  return { supported: true, secureContext, crossOriginIsolated, sharedArrayBuffer };
}
