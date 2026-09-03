import test from 'node:test';
import assert from 'node:assert/strict';
import { isSupportedVersion, isVersionAtLeast, parseVersion } from '../src/compatibility.js';

test('parses CLI versions from decorated output', () => {
  assert.equal(parseVersion('codex-cli 0.151.0-alpha.7.2'), '0.151.0');
});

test('accepts newer Codex CLI versions while preserving exact-version checks', () => {
  assert.equal(isVersionAtLeast('codex-cli 0.151.0-alpha.7.2', '0.148.0'), true);
  assert.equal(isVersionAtLeast('codex-cli 0.147.9', '0.148.0'), false);
  assert.equal(isSupportedVersion('opencode 1.18.24', '1.18.23'), false);
});
