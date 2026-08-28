import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import {
  assertReplayCursor,
  validateApiEnvelope,
  validateContinuationGrant,
  validateOpenSessionRequest,
  validateOpenSessionResult,
  validateThreadPage,
  validateWebSocketEvent,
} from '../src/control-plane.js';

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../fixtures/control-plane/v1.json', import.meta.url)),
    'utf8',
  ),
);

test('v0.4 control-plane fixtures pass runtime validators and preserve unknown fields', () => {
  const command = validateApiEnvelope(fixture.api.command);

  assert.equal(command.futureField, 'ignored-by-v1-consumers');
  validateApiEnvelope(fixture.api.response);
  validateApiEnvelope(fixture.api.error);
  fixture.events.forEach(validateWebSocketEvent);
  validateThreadPage(fixture.thread);
  validateContinuationGrant(fixture.continuation);
  validateOpenSessionRequest(fixture.session.request);
  validateOpenSessionResult(fixture.session.result);
});

test('event cursors reject gaps outside the replay window and support reconnect', () => {
  assert.deepEqual(assertReplayCursor({ requestedAfter: 41, oldest: 40, newest: 42 }), {
    requestedAfter: 41,
    oldest: 40,
    newest: 42,
  });
  assert.throws(
    () => assertReplayCursor({ requestedAfter: 10, oldest: 20, newest: 42 }),
    /cursor has expired/,
  );
  assert.throws(
    () => validateWebSocketEvent({ ...fixture.events[0], cursor: 0 }),
    /positive integer/,
  );
});

test('control-plane validators reject identity loss and unsupported versions', () => {
  assert.throws(
    () => validateOpenSessionResult({ ...fixture.session.result, sessionId: '' }),
    /session.sessionId is required/,
  );
  assert.throws(
    () => validateApiEnvelope({ ...fixture.api.response, version: 2 }),
    /unsupported control protocol version/,
  );
  assert.throws(
    () => validateContinuationGrant({ ...fixture.continuation, runId: 42 }),
    /continuation.runId is required/,
  );
});
