/**
 * Response projection for the general admin read: a reviewed row may list
 * response keys that never reach the model (owner ruling 2026-10-13: "access to
 * everything", with payment-method tokens, tokenized links and the like left
 * out). The list lives in the row (admin-read-reviewed.json `omit`), is copied
 * into the catalog entry, and is applied to the parsed answer BEFORE the
 * credential and secret passes and BEFORE truncation. Route handlers are not
 * changed.
 *
 * Path syntax (response keys, not table columns):
 *   customer.stripe_customer_id   the key `stripe_customer_id` of the object `customer`
 *   estimates.token               an array is transparent: every element of `estimates`
 *   payments.*.card_token         `*` matches any one key of an object (never last)
 *   **.stripe_charge_id           that key at any depth
 * The generator validates the syntax with omitProblem(); a path that matches
 * nothing in a given answer is simply a no-op.
 */
const SEGMENT_RE = /^[A-Za-z0-9_]{1,60}$/;
const MAX_OMIT_PATHS = 60;
const MAX_SEGMENTS = 12;

// null when every path is well formed, else a message.
function omitProblem(paths) {
  if (!Array.isArray(paths) || !paths.length) return 'omit must be a non-empty list of response key paths';
  if (paths.length > MAX_OMIT_PATHS) return `omit may hold at most ${MAX_OMIT_PATHS} paths`;
  if (new Set(paths).size !== paths.length) return 'omit must not repeat a path';
  for (const path of paths) {
    if (typeof path !== 'string' || !path) return 'each omit path must be a string';
    const segments = path.split('.');
    if (segments.length > MAX_SEGMENTS) return `omit path "${path}" is deeper than ${MAX_SEGMENTS} keys`;
    const last = segments[segments.length - 1];
    if (last === '*' || last === '**') return `omit path "${path}" must end in a key name`;
    if (segments.some((segment, index) => !(SEGMENT_RE.test(segment) || segment === '*' || (segment === '**' && index === 0)))) {
      return `omit path "${path}" may hold only key names, "*" and a leading "**"`;
    }
    if (segments[0] === '**' && segments.length !== 2) return `omit path "${path}": "**" must be followed by exactly one key name`;
  }
  return null;
}

function dropAnywhere(node, key) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(item => dropAnywhere(item, key)); return; }
  delete node[key];
  Object.values(node).forEach(item => dropAnywhere(item, key));
}

function dropAt(node, segments, index) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(item => dropAt(item, segments, index)); return; }
  const segment = segments[index];
  const keys = segment === '*' ? Object.keys(node) : [segment];
  for (const key of keys) {
    if (!Object.hasOwn(node, key)) continue;
    if (index === segments.length - 1) delete node[key];
    else dropAt(node[key], segments, index + 1);
  }
}

// Removes the listed paths from `value` in place and returns it.
function omitPaths(value, paths) {
  for (const path of paths || []) {
    const segments = path.split('.');
    if (segments[0] === '**') dropAnywhere(value, segments[1]);
    else dropAt(value, segments, 0);
  }
  return value;
}

// The key names a reader should be told are absent (last segment of each path).
const omittedKeyNames = paths => [...new Set((paths || []).map(path => path.split('.').pop()))];

module.exports = { omitProblem, omitPaths, omittedKeyNames, MAX_OMIT_PATHS };
