import { createHash, randomUUID } from 'node:crypto';

const TOKEN_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
];
const SCALE = 12n;

function decimal(value) {
  const text = String(value ?? '0');

  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error(`invalid decimal: ${value}`);
  const [whole, fraction = ''] = text.split('.');

  return (
    BigInt(whole) * 10n ** SCALE +
    BigInt((fraction + '0'.repeat(Number(SCALE))).slice(0, Number(SCALE)))
  );
}
function formatDecimal(value) {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 10n ** SCALE;
  const fraction = (abs % 10n ** SCALE).toString().padStart(Number(SCALE), '0').replace(/0+$/, '');

  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}
function addAmount(a, b) {
  return formatDecimal(decimal(a) + decimal(b));
}
function multiplyRate(tokens, rate) {
  return formatDecimal((BigInt(tokens) * decimal(rate)) / 1_000_000n);
}

export function normalizeUsage(usage = {}, context = {}) {
  const values = Object.fromEntries(
    TOKEN_FIELDS.map((field) => [field, usage[field] == null ? null : Number(usage[field])]),
  );

  for (const [field, value] of Object.entries(values))
    if (value !== null && (!Number.isSafeInteger(value) || value < 0))
      throw new Error(`usage.${field} must be a non-negative integer`);
  const present = TOKEN_FIELDS.some((field) => values[field] !== null);

  return {
    id: randomUUID(),
    idempotencyKey: context.idempotencyKey ?? `${context.runId}:${context.turnId ?? 'unknown'}`,
    taskId: context.taskId,
    runId: context.runId,
    stageId: context.stageId ?? 'worker',
    attempt: context.attempt ?? 1,
    sessionId: context.sessionId ?? null,
    turnId: context.turnId ?? null,
    provider: usage.provider ?? context.provider ?? null,
    harness: context.harness ?? 'unknown',
    model: usage.model ?? context.model ?? null,
    ...values,
    completeness: usage.completeness ?? (present ? 'complete' : 'unknown'),
    source: usage.source ?? (present ? 'reported' : 'unknown'),
    recordedAt: new Date().toISOString(),
  };
}

export function extractUsage(value) {
  if (!value || typeof value !== 'object') return null;
  for (const key of ['usage', 'tokenUsage', 'usageMetadata', 'tokens']) {
    const candidate = value[key];

    if (candidate && typeof candidate === 'object') {
      const map = (keys) => keys.find((key) => candidate[key] != null);
      const input = map(['inputTokens', 'input_tokens', 'prompt_tokens', 'promptTokens']);
      const output = map([
        'outputTokens',
        'output_tokens',
        'completion_tokens',
        'completionTokens',
      ]);

      if (input || output)
        return {
          inputTokens: candidate[input],
          outputTokens: candidate[output],
          cacheReadTokens: candidate.cacheReadTokens ?? candidate.cache_read_tokens,
          cacheWriteTokens: candidate.cacheWriteTokens ?? candidate.cache_write_tokens,
          reasoningTokens: candidate.reasoningTokens ?? candidate.reasoning_tokens,
          model: candidate.model,
        };
    }
  }

  return null;
}

export function snapshotChecksum(catalog) {
  return createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
}
export function calculateUsageCost(usage, snapshot) {
  if (!usage || usage.completeness === 'unknown' || !usage.model)
    return { amount: null, currency: null, status: 'unknown' };
  const price =
    snapshot?.catalog?.[usage.model] ??
    snapshot?.catalog?.[`${usage.provider ?? ''}/${usage.model}`];

  if (!price) return { amount: null, currency: null, status: 'unknown' };
  let amount = '0';

  for (const [tokens, rate] of [
    ['input_tokens', price.inputPerMillion],
    ['output_tokens', price.outputPerMillion],
    ['cache_read_tokens', price.cacheReadPerMillion],
    ['cache_write_tokens', price.cacheWritePerMillion],
    ['reasoning_tokens', price.reasoningPerMillion],
  ])
    if (usage[tokens] != null && rate != null)
      amount = addAmount(amount, multiplyRate(usage[tokens], rate));

  return {
    amount,
    currency: snapshot.currency,
    status: usage.completeness === 'partial' ? 'partial' : 'priced',
  };
}

export function aggregateUsage(records, costs = []) {
  const costById = new Map(costs.map((item) => [item.usage_id ?? item.usageId, item]));
  const total = {};
  let unknown = 0;
  let partial = 0;

  for (const record of records) {
    if (record.completeness === 'partial') partial += 1;
    if (record.completeness === 'unknown') unknown += 1;
    const cost = costById.get(record.id);

    if (!cost?.amount) continue;
    total[cost.currency] = addAmount(total[cost.currency] ?? '0', cost.amount);
  }

  return {
    turns: records.length,
    unknownTurns: unknown,
    partialTurns: partial,
    pricedTurns: records.length - unknown - partial,
    total,
    status: unknown ? 'partial' : records.length ? 'complete' : 'unknown',
  };
}
