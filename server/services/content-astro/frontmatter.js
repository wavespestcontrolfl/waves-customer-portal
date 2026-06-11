/**
 * frontmatter.js — YAML frontmatter read/write on js-yaml.
 *
 * Replaces the original hand-rolled subset parser, which silently corrupted
 * pages on a parse→stringify round-trip (e.g. publishRefresh):
 *   - inline flow arrays of objects (the `schema:` JSON-LD line on 300+
 *     service/location pages) parsed as arrays of STRINGS and were re-emitted
 *     as quoted JSON strings, destroying the rendered JSON-LD;
 *   - unquoted scalars containing a mid-string ` #` were re-emitted unquoted,
 *     so real YAML parsers truncated them at the comment marker.
 *
 * Function signatures and return shapes are unchanged:
 *   parse(source)            -> { data: object, content: string }
 *   stringify(data, content) -> '---\n<yaml>---\n<content>'
 *
 * Parsing uses CORE_SCHEMA so date-like scalars stay strings (matching the
 * old parser and every consumer — `published`/`modified`/`updated` are
 * handled as strings throughout the publish pipeline). `json: true` keeps
 * the old "last duplicate key wins" leniency instead of throwing.
 *
 * Stringify uses the library's default (timestamp-aware) schema so date-like
 * strings are emitted QUOTED (plain `2026-06-11T12:00:00` would round-trip
 * as a timestamp under YAML 1.1 parsers), matching the existing convention
 * in the Astro content repo. JSON-LD values (objects/arrays of objects with
 * `@`-prefixed keys, i.e. the `schema:` field) are emitted as a single-line
 * JSON flow value — JSON is valid YAML — matching the repo convention for
 * those fields. Everything else is block-style YAML, insertion order
 * preserved.
 *
 * Options stick to the js-yaml v3/v4 common subset (the monorepo root pins
 * ^4.1.1 but a v3 copy can win hoisting locally): no `quotingType`, no
 * explicit dump schema (v3 names them DEFAULT_SAFE/FULL_SCHEMA).
 */

const yaml = require('js-yaml');

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

const DUMP_OPTIONS = {
  indent: 2,
  lineWidth: -1, // never fold long scalars (metaTitle/metaDescription run long)
  noRefs: true, // no anchors/aliases for repeated objects
  skipInvalid: true, // drop undefined/function values instead of throwing
  sortKeys: false, // preserve key insertion order
};

function parse(source) {
  const match = FRONTMATTER_RE.exec(source);
  if (!match) return { data: {}, content: source };
  const [, fm, content] = match;
  const loaded = yaml.load(fm, { schema: yaml.CORE_SCHEMA, json: true });
  const data = isPlainObject(loaded) ? loaded : {};
  return { data, content };
}

function stringify(data, content = '') {
  const body = content.startsWith('\n') ? content : '\n' + content;
  return `---\n${toYaml(data)}---${body}`;
}

function toYaml(data) {
  let out = '';
  for (const [key, value] of Object.entries(data || {})) {
    if (value === undefined) continue;
    if (isJsonLd(value)) {
      out += `${key}: ${JSON.stringify(value)}\n`;
    } else {
      out += yaml.dump({ [key]: value }, DUMP_OPTIONS);
    }
  }
  return out;
}

// JSON-LD arrays (the `schema: [{...}]` field on service/location pages) keep
// the repo's single-line JSON flow convention. Detected structurally — a
// non-empty array of objects where some object carries an `@`-prefixed key
// (@context/@type/...). Object-form schema (rare; block-style in the repo)
// stays block-style YAML.
function isJsonLd(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(isPlainObject) &&
    value.some(hasAtKey)
  );
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function hasAtKey(obj) {
  return Object.keys(obj).some((k) => k.startsWith('@'));
}

module.exports = { parse, stringify };
