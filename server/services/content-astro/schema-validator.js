const schemaBundle = require('../../../packages/blog-schema/schema.json');

const BLOG_FRONTMATTER_EXTENSIONS = new Set(['domains']);

function validateBlogFrontmatter(frontmatter) {
  const data = { ...(frontmatter || {}) };

  // `domains` is an existing Astro collection convention used by the spoke
  // filters. The vendored schema stores that same value under tracking.domains,
  // so validate the schema projection while still allowing the emitted field.
  for (const key of BLOG_FRONTMATTER_EXTENSIONS) delete data[key];

  const errors = [];
  validateValue(data, schemaBundle.frontmatter, '', errors);
  return { ok: errors.length === 0, errors };
}

function assertValidBlogFrontmatter(frontmatter) {
  const result = validateBlogFrontmatter(frontmatter);
  if (!result.ok) {
    const err = new Error(`Astro frontmatter validation failed: ${result.errors.slice(0, 12).join('; ')}`);
    err.code = 'BLOG_FRONTMATTER_INVALID';
    err.details = result.errors;
    throw err;
  }
  return frontmatter;
}

function validateValue(value, schema, path, errors) {
  if (!schema) return;

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${label(path)} must be one of: ${schema.enum.join(', ')}`);
    return;
  }

  if (schema.type) {
    const ok = matchesType(value, schema.type);
    if (!ok) {
      errors.push(`${label(path)} must be ${schema.type}`);
      return;
    }
  }

  if (schema.type === 'object') {
    validateObject(value, schema, path, errors);
    return;
  }

  if (schema.type === 'array') {
    validateArray(value, schema, path, errors);
    return;
  }

  if (schema.type === 'string') {
    validateString(value, schema, path, errors);
    return;
  }

  if (schema.type === 'integer' || schema.type === 'number') {
    validateNumber(value, schema, path, errors);
  }
}

function validateObject(value, schema, path, errors) {
  const required = schema.required || [];
  for (const key of required) {
    if (value[key] === undefined) errors.push(`${label(joinPath(path, key))} is required`);
  }

  const properties = schema.properties || {};
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!properties[key]) errors.push(`${label(joinPath(path, key))} is not allowed`);
    }
  }

  for (const [key, childSchema] of Object.entries(properties)) {
    if (value[key] !== undefined) validateValue(value[key], childSchema, joinPath(path, key), errors);
  }
}

function validateArray(value, schema, path, errors) {
  if (schema.minItems != null && value.length < schema.minItems) {
    errors.push(`${label(path)} must contain at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}`);
  }
  if (schema.maxItems != null && value.length > schema.maxItems) {
    errors.push(`${label(path)} must contain at most ${schema.maxItems} items`);
  }
  if (schema.items) {
    value.forEach((item, i) => validateValue(item, schema.items, `${path}[${i}]`, errors));
  }
}

function validateString(value, schema, path, errors) {
  if (schema.minLength != null && value.length < schema.minLength) {
    errors.push(`${label(path)} must be at least ${schema.minLength} characters`);
  }
  if (schema.maxLength != null && value.length > schema.maxLength) {
    errors.push(`${label(path)} must be at most ${schema.maxLength} characters`);
  }
  if (schema.pattern) {
    const re = new RegExp(schema.pattern);
    if (!re.test(value)) errors.push(`${label(path)} has invalid format`);
  }
  if (schema.format === 'uri') {
    try { new URL(value); } catch { errors.push(`${label(path)} must be a valid URL`); }
  }
}

function validateNumber(value, schema, path, errors) {
  if (schema.minimum != null && value < schema.minimum) {
    errors.push(`${label(path)} must be at least ${schema.minimum}`);
  }
  if (schema.maximum != null && value > schema.maximum) {
    errors.push(`${label(path)} must be at most ${schema.maximum}`);
  }
}

function matchesType(value, type) {
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  return typeof value === type;
}

function joinPath(base, key) {
  return base ? `${base}.${key}` : key;
}

function label(path) {
  return path || 'frontmatter';
}

module.exports = { assertValidBlogFrontmatter, validateBlogFrontmatter };
