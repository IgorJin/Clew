import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactSecrets, REDACTED_VALUE } from '../src/security.js';
import { Store } from '../src/store.js';

test('redacts nested secret fields and inline credentials', () => {
  const result = redactSecrets({
    authorization: 'Bearer top-secret',
    nested: {
      apiKey: 'abc123',
      message: 'token=abc123 and Bearer xyz.123',
    },
  });

  assert.equal(result.authorization, REDACTED_VALUE);
  assert.equal(result.nested.apiKey, REDACTED_VALUE);
  assert.equal(result.nested.message, `token=${REDACTED_VALUE} and Bearer ${REDACTED_VALUE}`);
});

test('persists redacted event payloads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-redaction-'));
  const store = new Store(join(dir, 'state.sqlite'));

  try {
    store.createTask({
      id: 'T-SECRET',
      title: 'Secret test',
      goal: 'Do not persist credentials',
      profile: 'quick',
      acceptance: [{ id: 'AC-1', criterion: 'redacted' }],
    });
    store.appendEvent('T-SECRET', 'HARNESS_EVENT', {
      accessToken: 'private-token',
      output: 'Authorization: Bearer private-token',
    });
    const event = store.listEvents('T-SECRET').at(-1);

    assert.equal(event.payload.accessToken, REDACTED_VALUE);
    assert.doesNotMatch(JSON.stringify(event), /private-token/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
