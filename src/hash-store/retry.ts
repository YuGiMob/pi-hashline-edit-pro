import { isBusyError } from "./validation";

const sleepSab = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(sleepSab, 0, 0, ms);
}

const BUSY_RETRIES = 3;
const BUSY_RETRY_DELAY_MS = 50;

export function withBusyRetry<T>(fn: () => T): T {
  let lastError: unknown;
  for (let attempt = 0; attempt <= BUSY_RETRIES; attempt++) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
      if (!isBusyError(error) || attempt === BUSY_RETRIES) throw error;
      sleepSync(BUSY_RETRY_DELAY_MS * (1 << attempt));
    }
  }
  throw lastError;
}

export async function withBusyRetryAsync<T>(fn: () => T): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= BUSY_RETRIES; attempt++) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
      if (!isBusyError(error) || attempt === BUSY_RETRIES) throw error;
      await new Promise<void>((r) => setTimeout(r, BUSY_RETRY_DELAY_MS * (1 << attempt)));
    }
  }
  throw lastError;
}

export function retriedWrite(stmt: { run(...params: (string | number)[]): unknown }): (...params: (string | number)[]) => void {
  return (...params) => {
    withBusyRetry(() => { stmt.run(...params); });
  };
}

export async function openDbWithBusyRetryAsync<T>(fn: () => T): Promise<T> {
  return withBusyRetryAsync(fn);
}
