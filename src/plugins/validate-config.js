/** Structural config validator for CLEW-127.
 *
 * Validates a connection `config` value against the `configSchema` declared
 * in the plugin manifest. Only a documented subset of JSON Schema is
 * supported: `type`, `enum`, `required`, `properties`, `items`, `minLength`,
 * `minimum`, `maximum`. Unknown keywords are ignored. This keeps the core
 * dependency-free (ADR-0001) while the versioned JSON Schemas in
 * `schemas/plugin-*.v1.schema.json` remain the contract documentation.
 */

import { PLUGIN_ERROR_CODE, PluginError } from './errors.js';

const TYPES = new Set(['object', 'array', 'string', 'number', 'boolean', 'integer']);

function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (Number.isInteger(value)) return 'integer';

  return typeof value;
}

function matchesType(schemaType, value) {
  const actual = typeOf(value);

  if (Array.isArray(schemaType)) return schemaType.some((entry) => matchesType(entry, value));
  if (schemaType === 'number') return actual === 'number' || actual === 'integer';

  return actual === schemaType;
}

export function validateConfigValue(schema, value, path = 'config') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema))
    throw new PluginError(
      PLUGIN_ERROR_CODE.INVALID_CONFIG,
      `invalid config schema at ${path}: schema must be an object`,
    );

  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];

    for (const entry of expected)
      if (!TYPES.has(entry))
        throw new PluginError(
          PLUGIN_ERROR_CODE.INVALID_CONFIG,
          `invalid config schema at ${path}: unsupported type "${entry}"`,
        );

    if (!matchesType(schema.type, value))
      throw new PluginError(
        PLUGIN_ERROR_CODE.INVALID_CONFIG,
        `invalid config at ${path}: expected ${expected.join('/')} but received ${typeOf(value)}`,
      );
  }

  if (schema.enum !== undefined && !schema.enum.some((entry) => entry === value))
    throw new PluginError(
      PLUGIN_ERROR_CODE.INVALID_CONFIG,
      `invalid config at ${path}: value is not one of the allowed enum entries`,
    );

  if (
    typeof value === 'string' &&
    schema.minLength !== undefined &&
    value.length < schema.minLength
  )
    throw new PluginError(
      PLUGIN_ERROR_CODE.INVALID_CONFIG,
      `invalid config at ${path}: string is shorter than minLength ${schema.minLength}`,
    );

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum)
      throw new PluginError(
        PLUGIN_ERROR_CODE.INVALID_CONFIG,
        `invalid config at ${path}: number is below minimum ${schema.minimum}`,
      );

    if (schema.maximum !== undefined && value > schema.maximum)
      throw new PluginError(
        PLUGIN_ERROR_CODE.INVALID_CONFIG,
        `invalid config at ${path}: number is above maximum ${schema.maximum}`,
      );
  }

  if (typeOf(value) === 'object') {
    const required = schema.required ?? [];

    for (const key of required)
      if (value[key] === undefined)
        throw new PluginError(
          PLUGIN_ERROR_CODE.INVALID_CONFIG,
          `invalid config at ${path}: missing required field "${key}"`,
        );

    const properties = schema.properties ?? {};

    for (const [key, subschema] of Object.entries(properties))
      if (value[key] !== undefined) validateConfigValue(subschema, value[key], `${path}.${key}`);
  }

  if (Array.isArray(value) && schema.items !== undefined)
    value.forEach((entry, index) => validateConfigValue(schema.items, entry, `${path}[${index}]`));

  return value;
}
