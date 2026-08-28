import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const SECRET_KEY_PATTERN = /(?:authorization|api[_-]?key|token|password|secret|cookie)/i;

export const DEFAULT_CONFIG = Object.freeze({
  codexBin: 'codex',
  openCodeBin: 'opencode',
  openCodeUrl: 'http://127.0.0.1:4096',
  worktreeRoot: '.clew/worktrees',
  models: Object.freeze({ worker: null, architect: null, reviewer: null, qa: null }),
  pricing: Object.freeze({ sources: [] }),
  observability: Object.freeze({
    enabled: false,
    serviceName: 'clew',
    endpoint: null,
    maxQueueSize: 256,
    exportTimeoutMs: 5_000,
  }),
});

function readJsonIfPresent(path) {
  if (!existsSync(path)) return {};

  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`invalid Clew config ${path}: ${error.message}`, { cause: error });
  }
}

function assertSafeProjectConfig(config) {
  const inspect = (value, path = []) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const fieldPath = [...path, key];

      if (SECRET_KEY_PATTERN.test(key))
        throw new Error(`project config must not contain secret field: ${fieldPath.join('.')}`);
      inspect(child, fieldPath);
    }
  };

  inspect(config);
  if (config.worktreeRoot && isAbsolute(config.worktreeRoot))
    throw new Error('project config worktreeRoot must be relative');
}

export function loadConfig(projectRoot = process.cwd(), env = process.env) {
  const userConfigPath = env.CLEW_USER_CONFIG || join(homedir(), '.config', 'clew', 'config.json');
  const projectConfigPath = join(projectRoot, '.clew.json');
  const userConfig = readJsonIfPresent(userConfigPath);
  const projectConfig = readJsonIfPresent(projectConfigPath);

  assertSafeProjectConfig(projectConfig);
  const merged = {
    ...DEFAULT_CONFIG,
    ...userConfig,
    ...projectConfig,
    ...(env.CLEW_CODEX_BIN ? { codexBin: env.CLEW_CODEX_BIN } : {}),
    ...(env.CLEW_OPENCODE_BIN ? { openCodeBin: env.CLEW_OPENCODE_BIN } : {}),
    ...(env.CLEW_OPENCODE_URL ? { openCodeUrl: env.CLEW_OPENCODE_URL } : {}),
    ...(env.CLEW_WORKTREE_ROOT ? { worktreeRoot: env.CLEW_WORKTREE_ROOT } : {}),
    observability: {
      ...DEFAULT_CONFIG.observability,
      ...(userConfig.observability ?? {}),
      ...(projectConfig.observability ?? {}),
      ...(env.CLEW_TELEMETRY_ENABLED ? { enabled: env.CLEW_TELEMETRY_ENABLED === 'true' } : {}),
      ...(env.OTEL_SERVICE_NAME ? { serviceName: env.OTEL_SERVICE_NAME } : {}),
      ...(env.OTEL_EXPORTER_OTLP_ENDPOINT ? { endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT } : {}),
    },
    models: {
      ...DEFAULT_CONFIG.models,
      ...(userConfig.models ?? {}),
      ...(projectConfig.models ?? {}),
      ...(env.CLEW_WORKER_MODEL ? { worker: env.CLEW_WORKER_MODEL } : {}),
      ...(env.CLEW_ARCHITECT_MODEL ? { architect: env.CLEW_ARCHITECT_MODEL } : {}),
      ...(env.CLEW_REVIEW_MODEL ? { reviewer: env.CLEW_REVIEW_MODEL } : {}),
      ...(env.CLEW_QA_MODEL ? { qa: env.CLEW_QA_MODEL } : {}),
    },
    pricing: {
      ...DEFAULT_CONFIG.pricing,
      ...(userConfig.pricing ?? {}),
      ...(projectConfig.pricing ?? {}),
    },
  };

  return {
    ...merged,
    worktreeRoot: resolve(projectRoot, merged.worktreeRoot),
    projectConfigPath,
    userConfigPath,
  };
}
