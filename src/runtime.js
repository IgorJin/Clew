import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateRuntimeNamespace } from './domain.js';

export function createRuntimeNamespace(taskId, runId, { prefix = 'clew' } = {}) {
  const value = `${prefix}-${createHash('sha256').update(`${taskId}:${runId}`).digest('hex').slice(0, 16)}`;

  return validateRuntimeNamespace({ taskId, runId, value });
}

export function createCodexLiveEndpoint(runtimeNamespace, { tempDirectory = tmpdir() } = {}) {
  if (!runtimeNamespace?.value || typeof runtimeNamespace.value !== 'string')
    throw new Error('runtime namespace is required for a live Codex endpoint');

  return `unix://${join(tempDirectory, `${runtimeNamespace.value}.sock`)}`;
}
