export const SUPPORTED_CODEX_CLI_VERSION = '0.148.0';
export const SUPPORTED_OPENCODE_CLI_VERSION = '1.18.23';

export function parseVersion(output) {
  return String(output).match(/\d+\.\d+\.\d+/)?.[0] ?? null;
}

export function isSupportedVersion(output, expectedVersion) {
  return parseVersion(output) === expectedVersion;
}

export function isVersionAtLeast(output, minimumVersion) {
  const actual = parseVersion(output);
  const minimum = parseVersion(minimumVersion);

  if (!actual || !minimum) return false;
  const actualParts = actual.split('.').map(Number);
  const minimumParts = minimum.split('.').map(Number);

  for (let index = 0; index < 3; index += 1) {
    if (actualParts[index] > minimumParts[index]) return true;
    if (actualParts[index] < minimumParts[index]) return false;
  }

  return true;
}
