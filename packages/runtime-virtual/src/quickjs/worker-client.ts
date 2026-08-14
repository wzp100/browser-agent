import type { QuickJsExecutionOptions, QuickJsExecutionResult, QuickJsWorkerRequest, QuickJsWorkerResponse } from "./types";

export interface QuickJsWorkerLike {
  onmessage: ((event: MessageEvent<QuickJsWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: QuickJsWorkerRequest): void;
  terminate(): void;
}

export type QuickJsWorkerFactory = () => QuickJsWorkerLike;

export class QuickJsWorkerExecutor {
  constructor(private readonly createWorker: QuickJsWorkerFactory = defaultWorkerFactory) {}

  execute(options: QuickJsExecutionOptions, signal?: AbortSignal): Promise<QuickJsExecutionResult> {
    if (signal?.aborted) return Promise.resolve(abortedResult());
    const worker = this.createWorker();
    const id = crypto.randomUUID();
    const timeoutMs = Math.min(60_000, Math.max(1, options.timeoutMs ?? 10_000));
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: QuickJsExecutionResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(hardDeadline);
        signal?.removeEventListener("abort", abort);
        worker.terminate();
        resolve(result);
      };
      const abort = (): void => finish(abortedResult());
      const hardDeadline = setTimeout(() => finish({
        exitCode: 124,
        stdout: "",
        stderr: `执行超时（${timeoutMs}ms），Worker 已强制终止\n`,
        errorCode: "TIMEOUT"
      }), timeoutMs + 250);
      worker.onmessage = ({ data }) => { if (data.id === id) finish(data); };
      worker.onerror = (event) => finish({ exitCode: 1, stdout: "", stderr: `${event.message || "QuickJS Worker 启动失败"}\n`, errorCode: "WORKER" });
      signal?.addEventListener("abort", abort, { once: true });
      worker.postMessage({ id, ...options });
    });
  }
}

function defaultWorkerFactory(): QuickJsWorkerLike {
  return new Worker(new URL("./quickjs-worker.ts", import.meta.url), { type: "module", name: "browser-agent-quickjs" });
}

function abortedResult(): QuickJsExecutionResult {
  return { exitCode: 130, stdout: "", stderr: "执行已取消\n", errorCode: "ABORTED" };
}
