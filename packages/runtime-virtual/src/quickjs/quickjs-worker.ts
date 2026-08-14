/// <reference lib="webworker" />
import { runQuickJsScript } from "./vm";
import type { QuickJsWorkerRequest, QuickJsWorkerResponse } from "./types";

const worker = self as unknown as DedicatedWorkerGlobalScope;
worker.onmessage = (event: MessageEvent<QuickJsWorkerRequest>) => {
  const request = event.data;
  void runQuickJsScript(request).then(
    (result) => worker.postMessage({ id: request.id, ...result } satisfies QuickJsWorkerResponse),
    (error: unknown) => worker.postMessage({
      id: request.id,
      exitCode: 1,
      stdout: "",
      stderr: `${error instanceof Error ? error.message : String(error)}\n`,
      errorCode: "WORKER"
    } satisfies QuickJsWorkerResponse)
  );
};
