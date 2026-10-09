const UNIQUE_VIOLATION = '23505';

function readCode(value: unknown): unknown {
  return typeof value === 'object' && value !== null && 'code' in value
    ? (value as { code?: unknown }).code
    : undefined;
}

/** Drizzle may wrap the driver error, so check both levels. */
export function isUniqueViolation(error: unknown): boolean {
  if (readCode(error) === UNIQUE_VIOLATION) return true;
  const cause =
    typeof error === 'object' && error !== null && 'cause' in error
      ? (error as { cause?: unknown }).cause
      : undefined;
  return readCode(cause) === UNIQUE_VIOLATION;
}
