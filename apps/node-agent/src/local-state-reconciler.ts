import type { NodeAgentDataPlaneAdapter } from './agent';

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface NodeAgentLocalStateReconciler {
  nextLocalReconcileAt(): Promise<number | null>;
  reconcileLocalState(): Promise<number | null>;
  subscribeToLocalStateChanges(listener: () => void): () => void;
}

export interface LocalReconcileClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

type WaitOutcome = 'aborted' | 'deadline' | 'reschedule' | 'state-changed';

const systemClock: LocalReconcileClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function hasLocalStateReconciler(
  adapter: NodeAgentDataPlaneAdapter,
): adapter is NodeAgentDataPlaneAdapter & NodeAgentLocalStateReconciler {
  const candidate = adapter as Partial<NodeAgentLocalStateReconciler>;
  return (
    typeof candidate.nextLocalReconcileAt === 'function' &&
    typeof candidate.reconcileLocalState === 'function' &&
    typeof candidate.subscribeToLocalStateChanges === 'function'
  );
}

export class LocalStateReconcileLoop {
  private readonly clock: LocalReconcileClock;
  private stateRevision = 0;
  private wakeWaiter: (() => void) | undefined;

  constructor(
    private readonly reconciler: NodeAgentLocalStateReconciler,
    private readonly options: {
      retryDelayMs: number;
      onError?: (error: unknown) => void;
      clock?: LocalReconcileClock;
    },
  ) {
    this.clock = options.clock ?? systemClock;
  }

  async run(signal: AbortSignal): Promise<void> {
    let reconcileRuntime = true;
    const unsubscribe = this.reconciler.subscribeToLocalStateChanges(() => {
      this.stateRevision += 1;
      this.wakeWaiter?.();
    });

    try {
      while (!signal.aborted) {
        const observedRevision = this.stateRevision;
        let deadlineAt: number | null;
        try {
          deadlineAt = reconcileRuntime
            ? await this.reconciler.reconcileLocalState()
            : await this.reconciler.nextLocalReconcileAt();
          reconcileRuntime = false;
        } catch (error) {
          this.options.onError?.(error);
          deadlineAt = this.clock.now() + this.options.retryDelayMs;
          reconcileRuntime = true;
        }

        const outcome = await this.waitUntil(
          deadlineAt,
          observedRevision,
          signal,
        );
        if (outcome === 'aborted') return;
        reconcileRuntime = outcome === 'deadline';
      }
    } finally {
      unsubscribe();
    }
  }

  private waitUntil(
    deadlineAt: number | null,
    observedRevision: number,
    signal: AbortSignal,
  ): Promise<WaitOutcome> {
    if (signal.aborted) return Promise.resolve('aborted');

    return new Promise((resolve) => {
      let settled = false;
      let timer: unknown;
      const finish = (outcome: WaitOutcome) => {
        if (settled) return;
        settled = true;
        this.wakeWaiter = undefined;
        signal.removeEventListener('abort', onAbort);
        if (timer !== undefined) this.clock.clearTimeout(timer);
        resolve(outcome);
      };
      const onAbort = () => finish('aborted');

      this.wakeWaiter = () => finish('state-changed');
      signal.addEventListener('abort', onAbort, { once: true });
      if (this.stateRevision !== observedRevision) {
        finish('state-changed');
        return;
      }

      if (deadlineAt !== null) {
        const remainingMs = Math.max(0, deadlineAt - this.clock.now());
        const reachesDeadline = remainingMs <= MAX_TIMER_DELAY_MS;
        timer = this.clock.setTimeout(
          () => finish(reachesDeadline ? 'deadline' : 'reschedule'),
          Math.min(remainingMs, MAX_TIMER_DELAY_MS),
        );
      }
    });
  }
}
