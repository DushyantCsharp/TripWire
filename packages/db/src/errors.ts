import { attempt, type Result } from '@tripwire/result';

export interface DatabaseError {
  readonly kind: 'database_error';
  readonly message: string;
  /** Postgres SQLSTATE (e.g. 23505, unique violation) or a socket code such as ECONNREFUSED. */
  readonly code: string | undefined;
}

/** Drizzle wraps driver errors ("Failed query: …"); the error carrying the SQLSTATE is the cause. */
export function toDatabaseError(cause: unknown): DatabaseError {
  let error: unknown = cause;
  while (error instanceof Error && !hasCode(error) && error.cause !== undefined)
    error = error.cause;
  return {
    kind: 'database_error',
    message: error instanceof Error ? error.message : String(error),
    code: hasCode(error) ? error.code : undefined,
  };
}

function hasCode(error: unknown): error is { code: string } {
  return (
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
  );
}

/** Runs a query at the I/O edge, returning a driver failure as a DatabaseError value. */
export function dbCall<T>(fn: () => Promise<T>): Promise<Result<T, DatabaseError>> {
  return attempt(fn, toDatabaseError);
}
