// W100 — the S003 results interpreter: REFUSING, by construction.
//
// The versioned schema of record (tests/longitudinal/s003/schema/
// results.schema.json) is the contract every results document must satisfy
// EXACTLY. This interpreter implements a JSON-Schema subset evaluator that
// REFUSES to silently skip anything it does not implement:
//   * an unknown schemaVersion is a hard error;
//   * a schema keyword the evaluator does not implement is a hard error
//     (the schema author must not use it, or the evaluator must learn it —
//     there is no quiet pass-through);
//   * every structural violation is a hard error with a JSON path.
// The interpreter is NOT a test file (vitest picks up only **/*.test.ts —
// the executor.ts precedent).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The schema versions this interpreter understands. */
const SUPPORTED_SCHEMA_VERSIONS = [1] as const;

/** The keywords the evaluator implements — anything else REFUSES. */
const IMPLEMENTED_KEYWORDS = new Set([
  'type',
  'enum',
  'const',
  'required',
  'properties',
  'items',
  'minItems',
  'additionalProperties',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'pattern',
  'minLength',
  '$schema',
  '$id',
  'title',
  'description',
  'definitions',
  '$ref',
]);

export class InterpretationError extends Error {
  constructor(message: string, readonly path: string) {
    super(`S003 results interpretation refused at ${path}: ${message}`);
    this.name = 'InterpretationError';
  }
}

type Schema = Record<string, unknown>;

interface ResultShape {
  schemaVersion: number;
  [key: string]: unknown;
}

function resolveRef(schema: Schema, ref: string, root: Schema): Schema {
  if (!ref.startsWith('#/definitions/')) {
    throw new InterpretationError(`unsupported $ref '${ref}'`, '$ref');
  }
  const name = ref.slice('#/definitions/'.length);
  const definitions = root.definitions as Record<string, Schema> | undefined;
  const resolved = definitions?.[name];
  if (resolved === undefined) {
    throw new InterpretationError(`unresolvable $ref '${ref}'`, '$ref');
  }
  void schema;
  return resolved;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  return typeof value;
}

function checkType(expected: string | string[], value: unknown, path: string): void {
  const actual = typeOf(value);
  const accepts = Array.isArray(expected)
    ? expected.some((entry) =>
        entry === 'number' ? actual === 'number' || actual === 'integer' : entry === actual,
      )
    : expected === 'number'
      ? actual === 'number' || actual === 'integer'
      : expected === actual;
  if (!accepts) {
    throw new InterpretationError(
      `type mismatch: expected ${Array.isArray(expected) ? expected.join('|') : expected}, got ${actual}`,
      path,
    );
  }
}

function validate(value: unknown, schema: Schema, root: Schema, path: string): void {
  for (const keyword of Object.keys(schema)) {
    if (!IMPLEMENTED_KEYWORDS.has(keyword)) {
      throw new InterpretationError(`unimplemented schema keyword '${keyword}'`, path);
    }
  }

  if (schema.$ref !== undefined) {
    validate(value, resolveRef(schema, schema.$ref as string, root), root, path);
    return;
  }

  if (schema.const !== undefined && value !== schema.const) {
    throw new InterpretationError(
      `const mismatch: expected ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`,
      path,
    );
  }

  if (schema.enum !== undefined) {
    const options = schema.enum as unknown[];
    if (!options.some((option) => option === value)) {
      throw new InterpretationError(
        `enum mismatch: ${JSON.stringify(value)} is not one of ${JSON.stringify(options)}`,
        path,
      );
    }
    return;
  }

  if (schema.type !== undefined) {
    checkType(schema.type as string | string[], value, path);
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < (schema.minLength as number)) {
      throw new InterpretationError(`minLength ${schema.minLength} violated`, path);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern as string).test(value)) {
      throw new InterpretationError(`pattern ${schema.pattern} violated`, path);
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < (schema.minimum as number)) {
      throw new InterpretationError(`minimum ${schema.minimum} violated`, path);
    }
    if (schema.maximum !== undefined && value > (schema.maximum as number)) {
      throw new InterpretationError(`maximum ${schema.maximum} violated`, path);
    }
    if (schema.exclusiveMinimum !== undefined && value <= (schema.exclusiveMinimum as number)) {
      throw new InterpretationError(`exclusiveMinimum ${schema.exclusiveMinimum} violated`, path);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < (schema.minItems as number)) {
      throw new InterpretationError(`minItems ${schema.minItems} violated`, path);
    }
    if (schema.items !== undefined) {
      value.forEach((entry, index) => {
        validate(entry, schema.items as Schema, root, `${path}[${index}]`);
      });
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (schema.required !== undefined) {
      for (const key of schema.required as string[]) {
        if (!(key in record)) {
          throw new InterpretationError(`required property '${key}' is missing`, path);
        }
      }
    }
    if (schema.properties !== undefined) {
      const properties = schema.properties as Record<string, Schema>;
      const additional = schema.additionalProperties;
      for (const [key, entry] of Object.entries(record)) {
        const propertySchema = properties[key];
        if (propertySchema !== undefined) {
          validate(entry, propertySchema, root, `${path}.${key}`);
        } else if (additional === false) {
          throw new InterpretationError(`unknown property '${key}' refused`, `${path}.${key}`);
        } else if (additional !== undefined && additional !== true) {
          validate(entry, additional as Schema, root, `${path}.${key}`);
        }
      }
    }
  }
}

/** The parsed schema of record. */
export function loadResultsSchema(): Schema {
  const schemaPath = fileURLToPath(new URL('./schema/results.schema.json', import.meta.url));
  return JSON.parse(readFileSync(schemaPath, 'utf8')) as Schema;
}

/**
 * Interprets one results document against the schema of record. Refuses
 * loudly on any violation — an unknown schemaVersion, an unimplemented
 * keyword, or a structural mismatch. Returns the validated document.
 */
export function interpretS003Results(document: unknown): ResultShape {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new InterpretationError('the results document must be a JSON object', '$');
  }
  const record = document as Record<string, unknown>;
  const version = record.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new InterpretationError('schemaVersion must be an integer', '$.schemaVersion');
  }
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(version as 1)) {
    throw new InterpretationError(
      `unsupported schemaVersion ${version} (supported: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')})`,
      '$.schemaVersion',
    );
  }
  const schema = loadResultsSchema();
  const root = schema;
  // The root schema pins schemaVersion to const 1; the version gate above
  // gives the honest refusing message for future versions.
  validate(document, schema, root, '$');
  return record as ResultShape;
}

/** Interprets a results file from disk. */
export function interpretS003ResultsFile(path: string): ResultShape {
  return interpretS003Results(JSON.parse(readFileSync(path, 'utf8')));
}
