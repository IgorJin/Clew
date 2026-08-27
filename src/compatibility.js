export const SUPPORTED_CODEX_CLI_VERSION = '0.148.0';
export const SUPPORTED_OPENCODE_CLI_VERSION = '1.18.23';

export function parseVersion(output) {
  return String(output).match(/\d+\.\d+\.\d+/)?.[0] ?? null;
}

export function isSupportedVersion(output, expectedVersion) {
  return parseVersion(output) === expectedVersion;
}
