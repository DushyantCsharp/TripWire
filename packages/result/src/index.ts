/**
 * Expected failures are values; exceptions are reserved for bugs.
 * See "Error handling" in CLAUDE.md.
 */
export type Result<T, E> = Ok<T> | Err<E>;

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/**
 * Calls a library that signals failure by rejecting, and maps the rejection to an Err.
 * Use at I/O edges only; our own code returns Results directly.
 */
export async function attempt<T, E>(
  fn: () => Promise<T>,
  onError: (cause: unknown) => E,
): Promise<Result<T, E>> {
  try {
    return ok(await fn());
  } catch (cause) {
    return err(onError(cause));
  }
}
