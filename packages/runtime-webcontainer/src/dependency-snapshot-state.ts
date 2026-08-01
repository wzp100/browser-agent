export type DependencySnapshotState = "clean" | "dirty" | "waiting_for_quiet" | "saving" | "failed_retryable";

export interface DependencySnapshotFailure {
  error: unknown;
  retryAttempt: number;
  retryDelayMs: number;
}

export interface DependencySnapshotTimers {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

const DEFAULT_TIMERS: DependencySnapshotTimers = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

/** 串行化依赖快照，保留 dirty 状态并在稳定窗口后指数退避重试。 */
export class DependencySnapshotCoordinator {
  private timer: unknown;
  private dirty = false;
  private retryAttempt = 0;
  private current: Promise<void> | undefined;
  private currentState: DependencySnapshotState = "clean";

  constructor(
    private readonly save: () => Promise<void>,
    private readonly onFailure: (failure: DependencySnapshotFailure) => void,
    private readonly timers: DependencySnapshotTimers = DEFAULT_TIMERS
  ) {}

  get state(): DependencySnapshotState { return this.currentState; }
  get isDirty(): boolean { return this.dirty; }

  markDirty(): void {
    this.dirty = true;
    if (this.currentState === "saving" || this.currentState === "failed_retryable") return;
    this.schedule(800, "waiting_for_quiet");
  }

  cancelPending(): void {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
    if (this.currentState === "waiting_for_quiet" || this.currentState === "failed_retryable") this.currentState = "dirty";
  }

  async waitForSaving(): Promise<void> {
    if (this.current) await this.current;
  }

  reset(): void {
    this.cancelPending();
    this.dirty = false;
    this.retryAttempt = 0;
    this.currentState = "clean";
  }

  private schedule(delayMs: number, state: DependencySnapshotState): void {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.currentState = state;
    this.timer = this.timers.set(() => {
      this.timer = undefined;
      this.currentState = "dirty";
      void this.flushDue();
    }, delayMs);
  }

  private async flushDue(): Promise<void> {
    if (this.current) {
      await this.current;
      // 当前保存失败时已安排退避，不能因为 await 返回而绕过计时器立即重试。
      if (this.timer !== undefined || this.currentState === "failed_retryable") return;
    }
    if (!this.dirty) { this.currentState = "clean"; return; }
    this.dirty = false;
    this.currentState = "saving";
    let failed = false;
    this.current = this.save().then(
      () => { this.retryAttempt = 0; },
      (error) => {
        failed = true;
        this.dirty = true;
        const retryDelayMs = dependencySnapshotRetryDelay(this.retryAttempt);
        try { this.onFailure({ error, retryAttempt: this.retryAttempt, retryDelayMs }); } catch { /* 诊断消费者不能破坏重试状态机。 */ }
        this.retryAttempt += 1;
        this.schedule(retryDelayMs, "failed_retryable");
      }
    ).finally(() => { this.current = undefined; });
    await this.current;
    if (failed) return;
    if (this.dirty) this.schedule(800, "waiting_for_quiet");
    else this.currentState = "clean";
  }
}

export function dependencySnapshotRetryDelay(retryAttempt: number): number {
  return Math.min(1_000 * (2 ** Math.max(0, Math.floor(retryAttempt))), 30_000);
}
