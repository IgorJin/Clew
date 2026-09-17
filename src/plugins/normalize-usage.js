/** Shared native-usage normalization for CLEW-128/129.
 *
 * Both the Codex and OpenCode adapters translate `extractUsage()` output
 * into one canonical shape: reported token counts when the native payload
 * carries any, explicit `unknown` otherwise. Unknown usage stays
 * `null/unknown`, never zero — zero would fake a measurement.
 */

export function normalizeUsage(nativeUsage) {
  if (!nativeUsage || typeof nativeUsage !== 'object') return { status: 'unknown' };

  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, model } =
    nativeUsage;

  if (inputTokens == null && outputTokens == null) return { status: 'unknown' };

  return {
    status: 'reported',
    inputTokens: inputTokens ?? null,
    outputTokens: outputTokens ?? null,
    cacheReadTokens: cacheReadTokens ?? null,
    cacheWriteTokens: cacheWriteTokens ?? null,
    reasoningTokens: reasoningTokens ?? null,
    model: model ?? null,
  };
}
