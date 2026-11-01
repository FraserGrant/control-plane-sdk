export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
Consumers supply every sensitive value; field-name heuristics are insufficient.
*/
export function redactValues(
  message: string,
  values: Iterable<string>,
  maxLength = 1500,
): string {
  let clean = message;
  for (const value of values)
    if (value.length > 0) clean = clean.replaceAll(value, "[redacted]");
  return clean.slice(0, maxLength);
}
