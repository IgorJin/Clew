import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { assertSecureRunnerEndpoint } from './runner-protocol.js';

const SECRET_KEY_PATTERN = /(?:authorization|api[_-]?key|token|password|secret|cookie)/i;

export const DEFAULT_CONFIG = Object.freeze({
  codexBin: 'codex',
  openCodeBin: 'opencode',
  openCodeUrl: 'http://127.0.0.1:4096',
  editorBin: 'code',
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
    ...(env.CLEW_EDITOR_BIN ? { editorBin: env.CLEW_EDITOR_BIN } : {}),
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
    openCodexDesktop: ['1', 'true', 'yes', 'on'].includes(
      String(env.CLEW_CODEX_OPEN_DESKTOP ?? '').toLowerCase(),
    ),
    worktreeRoot: resolve(projectRoot, merged.worktreeRoot),
    projectConfigPath,
    userConfigPath,
  };
}

export function loadRunnerConfig(env = process.env) {
  const userConfigPath = env.CLEW_USER_CONFIG || join(homedir(), '.config', 'clew', 'config.json');
  const userConfig = readJsonIfPresent(userConfigPath);
  const configured = userConfig.runner ?? {};
  const credentialFile = env.CLEW_RUNNER_CREDENTIAL_FILE ?? configured.credentialFile ?? null;
  const environmentCredential = env.CLEW_RUNNER_TOKEN ?? null;

  if (credentialFile && environmentCredential)
    throw new Error('configure exactly one of CLEW_RUNNER_TOKEN or a Runner credential file');
  let credential = environmentCredential;

  if (credentialFile) {
    const resolvedCredentialFile = resolve(credentialFile);
    const metadata = statSync(resolvedCredentialFile);

    if (!metadata.isFile()) throw new Error('Runner credential path must be a regular file');
    if ((metadata.mode & 0o077) !== 0)
      throw new Error('Runner credential file permissions must not be broader than 0600');
    credential = readFileSync(resolvedCredentialFile, 'utf8').trim();
  }
  if (!credential) throw new Error('Runner credential is required');
  const controllerUrl = env.CLEW_RUNNER_CONTROLLER ?? configured.controllerUrl;
  const runnerId = env.CLEW_RUNNER_ID ?? configured.id;

  if (!controllerUrl) throw new Error('Runner Controller URL is required');
  if (!runnerId) throw new Error('Runner identity is required');
  assertSecureRunnerEndpoint(controllerUrl);
  const stateDir = resolve(
    env.CLEW_RUNNER_STATE_DIR ??
      configured.stateDir ??
      join(homedir(), '.local', 'state', 'clew-runner'),
  );
  const workspaceEntries = Object.entries(configured.workspaces ?? {}).map(([id, path]) => {
    if (!id || typeof path !== 'string' || !isAbsolute(path))
      throw new Error('Runner workspace mappings require an id and absolute local path');

    return { id, path: resolve(path) };
  });

  return {
    controllerUrl,
    runnerId,
    credential,
    stateDir,
    workspaces: workspaceEntries,
    capabilities: [...new Set(configured.capabilities ?? ['execute', 'runner_local_terminal'])],
    reconnect: {
      minDelayMs: configured.reconnect?.minDelayMs ?? 250,
      maxDelayMs: configured.reconnect?.maxDelayMs ?? 30_000,
    },
    outbox: {
      maxEntries: configured.outbox?.maxEntries ?? 10_000,
      maxBytes: configured.outbox?.maxBytes ?? 64 * 1024 * 1024,
      reservedEntries: configured.outbox?.reservedEntries ?? 32,
    },
    adapterConfig: {
      codexBin: configured.codexBin ?? 'codex',
      openCodeUrl: configured.openCodeUrl ?? 'http://127.0.0.1:4096',
      openCodexDesktop: configured.openCodexDesktop === true,
    },
    userConfigPath,
  };
}

export function loadControllerRunnerConfig(env = process.env) {
  const userConfigPath = env.CLEW_USER_CONFIG || join(homedir(), '.config', 'clew', 'config.json');
  const configured = readJsonIfPresent(userConfigPath).controllerRunner ?? {};
  const runnerId = env.CLEW_CONTROLLER_RUNNER_ID ?? configured.runnerId ?? null;

  if (!runnerId) return null;
  const credentialFile =
    env.CLEW_CONTROLLER_RUNNER_CREDENTIAL_FILE ?? configured.credentialFile ?? null;
  const environmentCredential = env.CLEW_CONTROLLER_RUNNER_TOKEN ?? null;

  if (credentialFile && environmentCredential)
    throw new Error('configure exactly one Controller Runner token or credential file');
  let credential = environmentCredential;

  if (credentialFile) {
    const resolvedCredentialFile = resolve(credentialFile);
    const metadata = statSync(resolvedCredentialFile);

    if (!metadata.isFile()) throw new Error('Controller Runner credential must be a regular file');
    if ((metadata.mode & 0o077) !== 0)
      throw new Error('Controller Runner credential permissions must not be broader than 0600');
    credential = readFileSync(resolvedCredentialFile, 'utf8').trim();
  }
  if (!credential) throw new Error('Controller Runner credential is required');

  return {
    runnerId,
    credential,
    requiredCapabilities: configured.requiredCapabilities ?? ['execute'],
    heartbeatIntervalMs: configured.heartbeatIntervalMs ?? 10_000,
    registrationTimeoutMs: configured.registrationTimeoutMs ?? 5_000,
  };
}
