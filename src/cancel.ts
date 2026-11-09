/**
 * A tool call the client cancelled, or whose session closed, stops waiting.
 * The SDK never sends the answer of a cancelled request, so what it stops
 * with is for the log and the in-flight slot, which is released only once the
 * handler settles. Only waits stop this way: work that changes something,
 * once started, always runs to its end.
 */
import { WazapError } from "./errors.js";

export function callCancelled(): WazapError {
  return new WazapError("TIMEOUT", "The call was cancelled before it finished.", "Call it again if the answer is still wanted");
}

export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw callCancelled();
}

/** `work`, or callCancelled as soon as `signal` aborts; the work itself goes on for whoever else waits on it. */
export function orCancelled<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  if (signal.aborted) return Promise.reject(callCancelled());
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => reject(callCancelled());
    signal.addEventListener("abort", stop, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", stop);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", stop);
        reject(err);
      }
    );
  });
}
