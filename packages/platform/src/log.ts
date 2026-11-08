const SECRET_KEY = /^(authorization|proxy-authorization|cookie|set-cookie|token|api[-_]?key|secret|password)$/i;

/**
 * Copy a log value, replacing secret-bearing properties at any depth. The
 * input is never mutated, so request/response objects can still be used by
 * their owners after logging.
 */
export function redactLog(value: unknown): unknown {
  return redact(value, new WeakSet<object>());
}

function redact(value: unknown, path: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    if (path.has(value)) {
      return "[Circular]";
    }
    path.add(value);
    const result = value.map((entry) => redact(entry, path));
    path.delete(value);
    return result;
  }
  if (path.has(value)) {
    return "[Circular]";
  }
  path.add(value);
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redact(entry, path);
  }
  path.delete(value);
  return result;
}
