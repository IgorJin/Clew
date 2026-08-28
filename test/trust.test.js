import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateEvidence, verificationEnvironment } from '../src/trust.js';

test('verification fingerprints are deterministic and secret-safe', () => {
  const first = verificationEnvironment({
    command: 'npm test',
    cwd: '/tmp/worktree',
    revision: 'abc',
    config: { apiKey: 'secret-value', mode: 'strict' },
  });
  const second = verificationEnvironment({
    command: 'npm test',
    cwd: '/tmp/worktree',
    revision: 'abc',
    config: { mode: 'strict', apiKey: 'secret-value' },
  });

  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.config.apiKey, '[REDACTED]');
});

test('evidence trust rejects stale, old, and incomplete records', () => {
  const environment = verificationEnvironment({
    command: 'npm test',
    cwd: '/tmp/worktree',
    revision: 'abc',
  });
  const evidence = {
    result: 'passed',
    revision: 'abc',
    environmentFingerprint: environment.fingerprint,
    endedAt: '2026-08-28T10:00:00.000Z',
  };

  assert.equal(
    evaluateEvidence(evidence, {
      revision: 'abc',
      environment,
      now: new Date('2026-08-28T10:30:00.000Z'),
    }).status,
    'reusable',
  );
  assert.equal(
    evaluateEvidence(evidence, {
      revision: 'def',
      environment,
      now: new Date('2026-08-28T10:30:00.000Z'),
    }).status,
    'stale',
  );
  assert.equal(
    evaluateEvidence(evidence, {
      revision: 'abc',
      environment,
      now: new Date('2026-08-30T10:30:00.000Z'),
    }).status,
    'stale',
  );
  assert.equal(
    evaluateEvidence({ result: 'passed' }, { revision: 'abc', environment }).status,
    'untrusted',
  );
});
