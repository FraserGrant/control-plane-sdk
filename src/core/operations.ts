import { AppError } from "./errors.js";

/**
Process-local exclusion. Callers still hold their persistent deployment lock.
*/
export class OperationCoordinator {
  private readonly running = new Set<string>();

  constructor(private readonly notify: (id: string) => void) {}

  private async execute<T>(id: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } finally {
      this.running.delete(id);
      this.notify(id);
    }
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  run<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (this.running.has(id))
      throw new AppError({
        code: "CONFLICT",
        message: "An operation is already running for this deployment.",
      });
    this.running.add(id);
    this.notify(id);
    return this.execute(id, action);
  }
}

/**
Coalesces notifications and releases listeners when cancelled or closed.
*/
export async function* observeSnapshots<T>(
  source: {
    subscribe: (changed: () => void) => () => void;
    read: () => Promise<T>;
  },
  signal?: AbortSignal,
): AsyncGenerator<T> {
  let isDirty = true;
  let wake: (() => void) | undefined;
  const changed = () => {
    isDirty = true;
    wake?.();
  };
  const unsubscribe = source.subscribe(changed);
  signal?.addEventListener("abort", changed);
  try {
    while (!signal?.aborted) {
      if (!isDirty) {
        const pending = Promise.withResolvers<undefined>();
        wake = () => {
          pending.resolve(undefined);
        };
        await pending.promise;
      }
      wake = undefined;
      if (signal?.aborted) break;
      isDirty = false;
      yield await source.read();
    }
  } finally {
    unsubscribe();
    signal?.removeEventListener("abort", changed);
  }
}
