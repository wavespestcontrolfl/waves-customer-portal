const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const schemaBundle = require('../../../packages/blog-schema/schema.json');

const BLOG_FRONTMATTER_EXTENSIONS = new Set(['domains']);

// Validate against the binding schema with a real draft-2020 validator (ajv),
// not a hand-rolled subset. The previous implementation only understood a
// handful of keywords (enum/type/required/min·max/pattern/format:uri), so if
// the vendored schema ever gained anyOf/oneOf/allOf/const/if or a non-uri
// format, those constraints were silently ignored here and only failed later at
// the Astro build — after the PR had already merged. ajv enforces the whole
// schema, keeping "valid here" == "valid at the Astro build".
//
// strict:false keeps the validator resilient to future schema-authoring quirks
// (it won't throw at compile time on an unknown custom keyword) while still
// enforcing every standard keyword. allErrors:true accumulates all problems,
// matching the prior behavior of returning a full error list.
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateFrontmatter = ajv.compile(schemaBundle.frontmatter);

function validateBlogFrontmatter(frontmatter) {
  const data = { ...(frontmatter || {}) };

  // `domains` is an existing Astro collection convention used by the spoke
  // filters. The vendored schema stores that same value under tracking.domains,
  // so validate the schema projection while still allowing the emitted field.
  for (const key of BLOG_FRONTMATTER_EXTENSIONS) delete data[key];

  const ok = validateFrontmatter(data);
  if (ok) return { ok: true, errors: [] };
  const errors = (validateFrontmatter.errors || []).map(formatError);
  return { ok: false, errors };
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

// Map an ajv error to the same human-readable shape the previous hand-rolled
// validator produced — callers and tests key on these messages (e.g.
// "category must be one of: ...", "<field> is required").
function formatError(e) {
  const params = e.params || {};
  switch (e.keyword) {
    case 'required':
      return `${label(joinPath(e.instancePath, params.missingProperty))} is required`;
    case 'additionalProperties':
      return `${label(joinPath(e.instancePath, params.additionalProperty))} is not allowed`;
    case 'enum':
      return `${label(e.instancePath)} must be one of: ${(params.allowedValues || []).join(', ')}`;
    case 'type':
      return `${label(e.instancePath)} must be ${params.type}`;
    case 'minLength':
      return `${label(e.instancePath)} must be at least ${params.limit} character${params.limit === 1 ? '' : 's'}`;
    case 'maxLength':
      return `${label(e.instancePath)} must be at most ${params.limit} character${params.limit === 1 ? '' : 's'}`;
    case 'minItems':
      return `${label(e.instancePath)} must contain at least ${params.limit} item${params.limit === 1 ? '' : 's'}`;
    case 'maxItems':
      return `${label(e.instancePath)} must contain at most ${params.limit} items`;
    case 'minimum':
      return `${label(e.instancePath)} must be at least ${params.limit}`;
    case 'maximum':
      return `${label(e.instancePath)} must be at most ${params.limit}`;
    case 'pattern':
      return `${label(e.instancePath)} has invalid format`;
    case 'format':
      return params.format === 'uri'
        ? `${label(e.instancePath)} must be a valid URL`
        : `${label(e.instancePath)} must be a valid ${params.format}`;
    default:
      return `${label(e.instancePath)} ${e.message}`.trim();
  }
}

// Append a child segment to an ajv instancePath (a JSON pointer like
// "/author"). Used for `required`/`additionalProperties`, where the offending
// key lives in params rather than the instancePath.
function joinPath(instancePath, key) {
  return key ? `${instancePath}/${key}` : instancePath;
}

// Render an ajv JSON-pointer path as the dotted field path the prior messages
// used ("/author/bio_url" → "author.bio_url"). Idempotent on already-dotted
// input. Empty path (top-level value) → "frontmatter".
function label(path) {
  const dotted = String(path || '').replace(/^\//, '').replace(/\//g, '.');
  return dotted || 'frontmatter';
}

module.exports = { assertValidBlogFrontmatter, validateBlogFrontmatter };
