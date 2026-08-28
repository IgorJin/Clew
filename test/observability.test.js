import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Observability } from '../src/observability.js';
import { Store } from '../src/store.js';

test('observability is a no-op when disabled', async () => {
  const observability = new Observability({ config: { enabled: false } });

  observability.onEvent({ task_id: 'T-1', type: 'TASK_CREATED', payload: {} });
  assert.deepEqual(observability.status(), {
    state: 'disabled',
    installed: false,
    endpoint: null,
    dropped: 0,
    exportErrors: 0,
    error: null,
  });
  await observability.shutdown();
});

test('missing optional OpenTelemetry runtime is reported without throwing', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'clew-observability-'));
  const observability = new Observability({ cwd, config: { enabled: true } });

  assert.equal(observability.status().state, 'unavailable');
  assert.equal(observability.status().installed, false);
  observability.onEvent({ task_id: 'T-1', type: 'HARNESS_EVENT', payload: { token: 'secret' } });
  await observability.shutdown();
  rmSync(cwd, { recursive: true, force: true });
});

test('Store dispatches durable events to an observer without making it part of persistence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-observer-'));
  const store = new Store(join(dir, 'state.sqlite'));
  const events = [];

  store.setEventObserver({ onEvent: (event) => events.push(event) });
  store.createTask({
    id: 'OBS-1',
    title: 'Observer',
    goal: 'Observer',
    profile: 'quick',
    acceptance: [{ id: 'AC-1', criterion: 'works' }],
  });

  assert.equal(events[0].type, 'TASK_CREATED');
  assert.equal(store.listEvents('OBS-1')[0].type, 'TASK_CREATED');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
