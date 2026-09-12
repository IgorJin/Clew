/** AgentRuntime v1 contract checks for CLEW-127.
 *
 * Plugins implement a typed adapter per extension point. A generic
 * `execute(type, payload)` RPC is not part of this contract: execution,
 * telemetry, and pricing have different failure semantics and stay typed.
 */

import { PLUGIN_ERROR_CODE, PluginError } from './errors.js';

export const AGENT_RUNTIME_POINT = 'AgentRuntime';
export const AGENT_RUNTIME_VERSION = '1';

export const AGENT_RUNTIME_REQUIRED_METHODS = Object.freeze([
  'describe',
  'probe',
  'run',
  'dispose',
]);

export const AGENT_RUNTIME_OPTIONAL_METHODS = Object.freeze([
  'inspect',
  'reconcile',
  'prepareSurface',
  'listModels',
]);

export const RUNTIME_ERROR_CLASS = Object.freeze({
  CONFIGURATION: 'configuration',
  AUTHENTICATION: 'authentication',
  INCOMPATIBLE: 'incompatible',
  UNSUPPORTED_CAPABILITY: 'unsupported-capability',
  TIMEOUT: 'timeout',
  PROTOCOL: 'protocol',
  EXECUTION_FAILURE: 'execution-failure',
});

export const RUNTIME_TERMINAL_STATUS = Object.freeze(['completed', 'failed', 'interrupted']);

export function assertAgentRuntime(adapter, pluginId) {
  if (!adapter || (typeof adapter !== 'object' && typeof adapter !== 'function'))
    throw new PluginError(
      PLUGIN_ERROR_CODE.INCOMPATIBLE,
      `plugin "${pluginId}" adapter must be an object implementing AgentRuntime v1`,
      { pluginId },
    );

  for (const method of AGENT_RUNTIME_REQUIRED_METHODS)
    if (typeof adapter[method] !== 'function')
      throw new PluginError(
        PLUGIN_ERROR_CODE.INCOMPATIBLE,
        `plugin "${pluginId}" adapter must implement AgentRuntime v1 method "${method}"`,
        { pluginId },
      );

  return adapter;
}

export function createRuntimeError({ code, message, errorClass, cause } = {}) {
  if (typeof code !== 'string' || !code)
    throw new PluginError(
      PLUGIN_ERROR_CODE.INVALID_CONFIG,
      'runtime error requires a non-empty code',
    );

  if (typeof message !== 'string' || !message)
    throw new PluginError(
      PLUGIN_ERROR_CODE.INVALID_CONFIG,
      'runtime error requires a non-empty message',
    );

  if (!Object.values(RUNTIME_ERROR_CLASS).includes(errorClass))
    throw new PluginError(
      PLUGIN_ERROR_CODE.INVALID_CONFIG,
      `runtime error class must be one of ${Object.values(RUNTIME_ERROR_CLASS).join(', ')}`,
    );

  const error = { code, message, class: errorClass };

  if (cause !== undefined) error.cause = String(cause);

  return Object.freeze(error);
}

export function validateRuntimeResult(result, pluginId) {
  if (!result || typeof result !== 'object')
    throw new PluginError(
      PLUGIN_ERROR_CODE.PROTOCOL,
      `plugin "${pluginId}" run must resolve a result object`,
      { pluginId },
    );

  if (!RUNTIME_TERMINAL_STATUS.includes(result.status))
    throw new PluginError(
      PLUGIN_ERROR_CODE.PROTOCOL,
      `plugin "${pluginId}" result status must be one of ${RUNTIME_TERMINAL_STATUS.join(', ')}`,
      { pluginId },
    );

  const session = result.session;

  if (!session || typeof session !== 'object')
    throw new PluginError(
      PLUGIN_ERROR_CODE.PROTOCOL,
      `plugin "${pluginId}" result must include a session reference`,
      { pluginId },
    );

  if (
    typeof session.nativeSessionId !== 'string' &&
    !(result.status !== 'completed' && session.nativeSessionId == null)
  )
    throw new PluginError(
      PLUGIN_ERROR_CODE.PROTOCOL,
      `plugin "${pluginId}" result must include session.nativeSessionId`,
      { pluginId },
    );

  if (result.status !== 'completed') {
    const error = result.error;

    if (!error || typeof error.code !== 'string' || typeof error.message !== 'string')
      throw new PluginError(
        PLUGIN_ERROR_CODE.PROTOCOL,
        `plugin "${pluginId}" non-completed result must carry a diagnosable error`,
        { pluginId },
      );

    if (error.class !== undefined && !Object.values(RUNTIME_ERROR_CLASS).includes(error.class))
      throw new PluginError(
        PLUGIN_ERROR_CODE.PROTOCOL,
        `plugin "${pluginId}" error class must be one of ${Object.values(RUNTIME_ERROR_CLASS).join(', ')}`,
        { pluginId },
      );
  }

  return result;
}
