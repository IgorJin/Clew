import { createHash } from 'node:crypto';
import { validateRuntimeNamespace } from './domain.js';

export function createRuntimeNamespace(taskId, runId, { prefix = 'clew' } = {}) {
  const value = `${prefix}-${createHash('sha256').update(`${taskId}:${runId}`).digest('hex').slice(0, 16)}`;

  return validateRuntimeNamespace({ taskId, runId, value });
}
