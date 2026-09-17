/** Agent role routing for CLEW-130: `role → connection → model`.
 *
 * Each role resolves exactly one connection and one model (or the runtime
 * default). Precedence per role: run/stage flag → environment → project →
 * user → defaults. A model is never silently substituted or carried over
 * to another connection: without a catalog (`listModels`, not implemented
 * by any bundled runtime yet) the resolver validates shape, and any
 * explicit value passes through unchanged.
 */

import { PLUGIN_ERROR_CODE, PluginError } from './errors.js';

export const AGENT_ROLES = Object.freeze(['worker', 'architect', 'reviewer', 'qa']);

export const DEFAULT_ROLE_CONNECTION = 'codex-default';

const ROUTE_SOURCES = Object.freeze(['flag', 'env', 'project', 'user', 'default']);

function pickSource(sources) {
  return routeSourceOf(sources).level;
}

/** Which precedence level provides the connection of one role source set. */
export function routeSourceOf(sourceSet) {
  for (const level of ['flag', 'env', 'project', 'user'])
    if (sourceSet?.[level]?.connection != null)
      return { level, connection: sourceSet[level].connection };

  return { level: 'default', connection: null };
}

export function resolveRoleRoute(role, sources = {}, options = {}) {
  if (!AGENT_ROLES.includes(role))
    throw new PluginError(
      PLUGIN_ERROR_CODE.INVALID_CONFIG,
      `unknown agent role "${role}": expected one of ${AGENT_ROLES.join(', ')}`,
    );

  const { allowedConnections = null, defaultConnection = DEFAULT_ROLE_CONNECTION } = options;
  const source = pickSource(sources);
  const at = (level) => sources?.[level] ?? {};
  const connection =
    at('flag').connection ??
    at('env').connection ??
    at('project').connection ??
    at('user').connection ??
    at('defaults').connection ??
    defaultConnection;
  const model =
    at('flag').model ??
    at('env').model ??
    at('project').model ??
    at('user').model ??
    at('defaults').model ??
    null;

  if (typeof connection !== 'string' || !connection)
    throw new PluginError(
      PLUGIN_ERROR_CODE.INVALID_CONFIG,
      `agent role "${role}" requires a non-empty connection id`,
    );

  if (allowedConnections !== null && !allowedConnections.includes(connection))
    throw new PluginError(
      PLUGIN_ERROR_CODE.HOST_POLICY_DENIED,
      `agent role "${role}" selects connection "${connection}", which is not available on this execution host`,
      { connectionId: connection },
    );

  if (model !== null && (typeof model !== 'string' || !model))
    throw new PluginError(
      PLUGIN_ERROR_CODE.INVALID_CONFIG,
      `agent role "${role}" model must be a non-empty string or null (runtime default)`,
      { connectionId: connection },
    );

  return { role, connection, model, source };
}

export function resolveAgentRoutes({ roles = AGENT_ROLES, sources = {}, options = {} } = {}) {
  const routes = {};

  for (const role of roles) routes[role] = resolveRoleRoute(role, sources[role], options);

  return routes;
}

export function routeSourceLevels() {
  return [...ROUTE_SOURCES];
}

export const ROLE_FLAGS = Object.freeze({
  worker: Object.freeze({ connection: '--connection', model: '--worker-model' }),
  architect: Object.freeze({ connection: '--architect-connection', model: null }),
  reviewer: Object.freeze({ connection: '--review-connection', model: null }),
  qa: Object.freeze({ connection: null, model: null }),
});

export const ROLE_ENV_PREFIX = Object.freeze({
  worker: 'WORKER',
  architect: 'ARCHITECT',
  reviewer: 'REVIEW',
  qa: 'QA',
});

/** Collect per-role route sources from CLI flags, environment, and the
 * config layers exposed by `loadConfig`. Legacy `models.*` entries act as
 * a model fallback below `agents.*` and produce a migration diagnostic.
 */
export function collectRoleSources({ getFlag = () => undefined, config = {}, env = {} } = {}) {
  const layers = config.layers ?? {};
  const projectAgents = layers.agents?.project ?? {};
  const userAgents = layers.agents?.user ?? {};
  const projectModels = layers.models?.project ?? {};
  const userModels = layers.models?.user ?? {};
  const diagnostics = [];
  const sources = {};

  for (const role of AGENT_ROLES) {
    const flags = ROLE_FLAGS[role];
    const prefix = ROLE_ENV_PREFIX[role];

    if (projectModels[role] != null || userModels[role] != null)
      diagnostics.push({
        role,
        source: 'models',
        message: `models.${role} is legacy; prefer agents.${role}.model with an explicit connection`,
      });

    sources[role] = {
      flag: {
        connection: flags.connection ? getFlag(flags.connection) : undefined,
        model: flags.model ? getFlag(flags.model) : undefined,
      },
      env: {
        connection: env[`CLEW_${prefix}_CONNECTION`],
        model: env[`CLEW_${prefix}_MODEL`],
      },
      project: {
        connection: projectAgents[role]?.connection,
        model: projectAgents[role]?.model ?? projectModels[role],
      },
      user: {
        connection: userAgents[role]?.connection,
        model: userAgents[role]?.model ?? userModels[role],
      },
      defaults: { connection: null, model: null },
    };
  }

  return { sources, diagnostics };
}
