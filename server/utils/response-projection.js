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

// ── keep (allow-list) mode ───────────────────────────────────────────────
//
// A row that returns a whole table row or a broad object lists the response
// keys it KEEPS (`keep`, admin-read-reviewed.json) instead of the keys it
// leaves out. Every key that is not listed is dropped from the answer, so a
// column added to the table next month never reaches the model until a person
// reviews it. The kept keys still go through the free-text withholding and the
// secret scrubber afterwards.
//
// Path syntax (response keys, from the top of the answer):
//   customers.*.firstName   `*` is every item of an array (never a key of an object)
//   total                   a scalar at the top
//   filters.areas           a list of plain values (strings, numbers) is kept whole
//   pipelineCounts          a map of numbers (a count per name) is kept whole
// A path that names an object or a list of objects keeps nothing by itself:
// list the keys inside it ("estimates.*.status"). Arrays are NOT transparent:
// "estimates.*.status", not "estimates.status". A map that holds anything but
// numbers is dropped whole.
const MAX_KEEP_PATHS = 160;
// Operator- or customer-typed fields that must never be kept, whatever the
// row says (owner ruling 2026-10-20: free text stays out of the general read).
// Compared in lower case without underscores.
const KEEP_NEVER = new Set([
  'paymentreference', 'profilelabel', 'tags', 'tag', 'competitorname', 'title', 'serviceinterest', 'leadsynopsis', 'heardaboutprompt',
  'extracteddata', 'metadata', 'leadsourcedetail', 'ponumber', 'planlabel', 'servicedisplay', 'servicetyperaw', 'payload',
]);
const squash = key => String(key).toLowerCase().replace(/_/g, '');

// null when every path is well formed and keeps no free-text key, else a message.
// `isFreeText(name)` says a name looks like free text; `content` lists the names
// the row declares business reference text (freeText kind "content").
function keepProblem(paths, { isFreeText = () => false, content = [] } = {}) {
  if (!Array.isArray(paths) || !paths.length) return 'keep must be a non-empty list of response key paths';
  if (paths.length > MAX_KEEP_PATHS) return `keep may hold at most ${MAX_KEEP_PATHS} paths`;
  if (new Set(paths).size !== paths.length) return 'keep must not repeat a path';
  for (const path of paths) {
    if (typeof path !== 'string' || !path) return 'each keep path must be a string';
    const segments = path.split('.');
    if (segments.length > MAX_SEGMENTS) return `keep path "${path}" is deeper than ${MAX_SEGMENTS} keys`;
    if (segments.some(segment => !(SEGMENT_RE.test(segment) || segment === '*'))) return `keep path "${path}" may hold only key names and "*"`;
    if (segments[segments.length - 1] === '*') return `keep path "${path}" must end in a key name`;
    for (const segment of segments.filter(item => item !== '*')) {
      if (KEEP_NEVER.has(squash(segment))) return `keep path "${path}" names "${segment}", an operator-entered field that is never kept`;
      if (isFreeText(segment) && !content.includes(segment)) return `keep path "${path}" names "${segment}", which looks like free text (declare it "content" in freeText only if it is business reference text)`;
    }
  }
  return null;
}

const isScalar = value => value === null || ['string', 'number', 'boolean'].includes(typeof value);

function buildTrie(paths) {
  const root = { leaf: false, children: new Map() };
  for (const path of paths) {
    let node = root;
    for (const segment of path.split('.')) {
      if (!node.children.has(segment)) node.children.set(segment, { leaf: false, children: new Map() });
      node = node.children.get(segment);
    }
    node.leaf = true;
  }
  return root;
}

const DROPPED = Symbol('dropped');

function keepNode(value, node) {
  if (isScalar(value)) return node.leaf ? value : DROPPED;
  if (Array.isArray(value)) {
    const star = node.children.get('*');
    if (star) {
      // An item with nothing kept stays as {} so a count of items is not lost; a plain value that is not listed goes.
      return value.flatMap((item) => { const kept = keepNode(item, star); return kept !== DROPPED ? [kept] : (isScalar(item) ? [] : [{}]); });
    }
    // a list of plain values is kept whole when the path ends here
    return node.leaf && value.every(isScalar) ? value : DROPPED;
  }
  if (typeof value !== 'object') return DROPPED;
  const keys = Object.keys(value);
  // a map of numbers (a count per name) is kept whole when the path ends here
  if (node.leaf && keys.length && keys.every(key => typeof value[key] === 'number')) return { ...value };
  const out = {};
  let any = false;
  for (const key of keys) {
    const child = node.children.get(key);
    if (!child) continue;
    const kept = keepNode(value[key], child);
    if (kept !== DROPPED) { out[key] = kept; any = true; }
  }
  return any || !keys.length ? out : DROPPED;
}

// Returns a copy of `value` that holds only the listed paths. Nothing listed
// matches: an empty object (an answer that holds no reviewed field).
function keepPaths(value, paths) {
  const kept = keepNode(value, buildTrie(paths || []));
  return kept === DROPPED ? {} : kept;
}

module.exports = { omitProblem, omitPaths, omittedKeyNames, keepProblem, keepPaths, MAX_OMIT_PATHS, MAX_KEEP_PATHS };
