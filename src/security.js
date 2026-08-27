const SECRET_KEY_PATTERN =
  /(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|cookie)/i;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const TOKEN_ASSIGNMENT_PATTERN =
  /\b([A-Za-z0-9_-]*(?:token|secret|password|api[_-]?key))=([^\s&]+)/gi;

export const REDACTED_VALUE = '[REDACTED]';

export function redactSecrets(value, seen = new WeakSet()) {
  if (typeof value === 'string')
    return value
      .replace(BEARER_PATTERN, `Bearer ${REDACTED_VALUE}`)
      .replace(TOKEN_ASSIGNMENT_PATTERN, `$1=${REDACTED_VALUE}`);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, seen));

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEY_PATTERN.test(key) ? REDACTED_VALUE : redactSecrets(item, seen),
    ]),
  );
}
