import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTask } from '../src/task-analysis.js';

test('recommends Quick for a clear bounded low-risk task', () => {
  const analysis = analyzeTask({
    title: 'Update copy',
    goal: 'Update the empty-state label',
    acceptance: [{ id: 'AC-1', criterion: 'The empty state displays the new label' }],
    risk: 'low',
    base_ref: 'main',
  });

  assert.equal(analysis.kind.value, 'feature');
  assert.equal(analysis.readiness.score, 100);
  assert.equal(analysis.recommendation.profile, 'quick');
  assert.equal(analysis.recommendation.action, 'start');
});

test('routes an unclear bug to investigation and independent review', () => {
  const analysis = analyzeTask({
    title: 'Random payment 500 error',
    goal: 'Fix the production payment error',
    acceptance: [{ id: 'AC-1', criterion: 'Fix the production payment error' }],
    risk: 'medium',
    base_ref: 'main',
  });

  assert.equal(analysis.kind.value, 'bug');
  assert.equal(analysis.recommendation.action, 'investigate');
  assert.equal(analysis.recommendation.profile, 'deep');
  assert.ok(analysis.readiness.unresolved.includes('Bug reproduction is described'));
});

test('recommends Deep for architecture-sensitive work', () => {
  const analysis = analyzeTask({
    title: 'Auth migration',
    goal: 'Migrate authorization storage safely',
    acceptance: [{ id: 'AC-1', criterion: 'Existing authorization records remain valid' }],
    risk: 'high',
    base_ref: 'main',
  });

  assert.equal(analysis.recommendation.profile, 'deep');
  assert.equal(analysis.recommendation.action, 'plan');
});

test('classifies Cyrillic bug and security signals', () => {
  const analysis = analyzeTask({
    title: 'Падает авторизация',
    goal: 'Исправить ошибку авторизации и добавить шаги воспроизведения',
    acceptance: [{ id: 'AC-1', criterion: 'Ошибка больше не воспроизводится' }],
    risk: 'medium',
    base_ref: 'main',
  });

  assert.equal(analysis.kind.value, 'bug');
  assert.equal(analysis.recommendation.profile, 'deep');
  assert.equal(analysis.recommendation.action, 'plan');
});
