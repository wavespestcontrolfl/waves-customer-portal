/**
 * Outside-link click tracking for customer prep guides (GATE_OUTLINK_TRACKING).
 *
 * Prep guides carry author-written markdown links to OUTSIDE sites (Amazon,
 * Chewy, Elanco, Bravecto, ...). At RENDER time — never by editing template
 * content — each external http(s) link is swapped for
 * `<portal>/go/<code>?k=…&c=…&v=…&p=…&s=…&g=…`. GET /go/:code (routes/outbound-redirect.js)
 * logs the click and 302s to the ORIGINAL url, so the customer lands exactly
 * where the template said. Nothing is appended to the destination (owner
 * ruling: no affiliate tags in email; never change the destination).
 *
 * No open redirect, by construction:
 *   - a destination is a pre-registered outbound_links row; the route looks
 *     the row up by `code` and never reads a URL from the request;
 *   - the code is sha256(target_url) truncated, so registering a link is
 *     idempotent, and a stored row whose target does not hash back to its
 *     code is never served;
 *   - only http(s) URLs are ever registered or served.
 *
 * Attribution rides in the query string as a small signed context (template
 * key, customer id, visit id OR project id, surface). The context carries row
 * ids only, NEVER the prep token: the token is a bearer credential, and the
 * request log (Morgan) would record it on every click. The prep token is
 * resolved to the visit/project ids at render time, server-side. It is HMAC-signed so a
 * forged or edited context is ignored (the click still redirects, it just
 * carries no attribution). No JWT_SECRET → nothing is rewritten at all.
 *
 * Rewrites fail OPEN: any error leaves the original blocks untouched, so a
 * tracking hiccup can never block a send or a page render.
 */

const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const { portalUrl, publicPortalUrl } = require('../utils/portal-url');
const { outlinkTrackingLive } = require('../config/feature-gates');

// Same shape as email-template-library's MD_LINK_RE and the prep page's:
// [label](https://…). Links are found in the raw template text.
const MD_LINK_RE = /\[([^\]\n]+)\]\((\S+?)\)/g;

const CODE_LEN = 20; // hex chars of sha256 → 80 bits
const CODE_RE = /^[a-f0-9]{20}$/;
const PREP_TEMPLATE_KEY_RE = /^prep\.[a-z0-9_]{1,60}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SURFACES = new Set(['email', 'page']);
const MAX_TARGET_LEN = 2000;

function ownDomains() {
  const domains = new Set(['wavespestcontrol.com']);
  try {
    for (const key of require('./content-astro/spoke-sites').SPOKE_SITE_KEYS) domains.add(String(key).toLowerCase());
  } catch { /* fleet registry unavailable — hub alone still protects own links */ }
  try {
    domains.add(new URL(publicPortalUrl()).hostname.toLowerCase());
  } catch { /* unparseable portal origin — ignore */ }
  return domains;
}

function isOwnHost(hostname, domains) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  for (const d of domains) {
    if (host === d || host.endsWith(`.${d}`)) return true;
  }
  return false;
}

// An OUTSIDE link: absolute http(s) URL whose host is not one of ours.
// mailto:/tel:/relative/anchor links and own-site links are never touched.
function isExternalHttpUrl(href, domains = ownDomains()) {
  const trimmed = String(href || '').trim();
  if (!/^https?:\/\//i.test(trimmed) || trimmed.length > MAX_TARGET_LEN) return false;
  let u;
  try { u = new URL(trimmed); } catch { return false; }
  if (u.username || u.password) return false;
  return !isOwnHost(u.hostname, domains);
}

function codeForUrl(url) {
  return crypto.createHash('sha256').update(String(url)).digest('hex').slice(0, CODE_LEN);
}

function signingKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update('outlink-context-v1').digest();
}

// The destination code is part of the signed payload, so a valid context
// cannot be replayed onto a different registered code.
function contextSignature({ k = '', c = '', v = '', p = '', s = '' }, code = '') {
  const key = signingKey();
  if (!key || !code) return null;
  return crypto.createHmac('sha256', key).update([code, k, c, v, p, s].join('|')).digest('hex').slice(0, 24);
}

function cleanContext(ctx = {}) {
  const k = PREP_TEMPLATE_KEY_RE.test(String(ctx.templateKey || '')) ? ctx.templateKey : '';
  const uuid = (val) => (UUID_RE.test(String(val || '')) ? String(val).toLowerCase() : '');
  const c = uuid(ctx.customerId);
  const v = uuid(ctx.scheduledServiceId);
  const p = uuid(ctx.projectId);
  const s = SURFACES.has(ctx.surface) ? ctx.surface : '';
  return { k, c, v, p, s };
}

function goUrl(code, ctx) {
  const parts = cleanContext(ctx);
  const g = contextSignature(parts, code);
  const qs = new URLSearchParams();
  for (const name of ['k', 'c', 'v', 'p', 's']) if (parts[name]) qs.set(name, parts[name]);
  if (g) qs.set('g', g);
  const query = qs.toString();
  return portalUrl(`/go/${code}${query ? `?${query}` : ''}`);
}

// Verify the signed context from a click's query string, against the code in
// the path it arrived on. Anything that does not verify (bad signature, or a
// context signed for another code) yields null — the caller still redirects,
// without attribution.
function verifyContext(query = {}, code = '') {
  const pick = (name) => (typeof query[name] === 'string' ? query[name] : '');
  const parts = { k: pick('k'), c: pick('c'), v: pick('v'), p: pick('p'), s: pick('s') };
  const g = pick('g');
  const expected = contextSignature(parts, code);
  if (!expected || !g || g.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(g), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  const clean = cleanContext({
    templateKey: parts.k, customerId: parts.c, scheduledServiceId: parts.v, projectId: parts.p, surface: parts.s,
  });
  return {
    templateKey: clean.k || null,
    customerId: clean.c || null,
    scheduledServiceId: clean.v || null,
    projectId: clean.p || null,
    surface: clean.s || null,
  };
}

function collectExternalUrls(text, domains, out) {
  if (typeof text !== 'string' || !text) return;
  MD_LINK_RE.lastIndex = 0;
  let m;
  while ((m = MD_LINK_RE.exec(text))) {
    if (isExternalHttpUrl(m[2], domains)) out.add(m[2].trim());
  }
}

function mapBlockStrings(block, fn) {
  if (!block || typeof block !== 'object') return block;
  const next = { ...block };
  if (typeof next.content === 'string') next.content = fn(next.content);
  if (Array.isArray(next.items)) next.items = next.items.map((i) => (typeof i === 'string' ? fn(i) : i));
  if (Array.isArray(next.rows)) {
    next.rows = next.rows.map((row) => (row && typeof row === 'object'
      ? {
        ...row,
        label: typeof row.label === 'string' ? fn(row.label) : row.label,
        value: typeof row.value === 'string' ? fn(row.value) : row.value,
      }
      : row));
  }
  return next;
}

// Pure, sync rewrite of markdown links using an already-registered
// url → code map. A URL not in the map is left exactly as written.
function rewriteText(text, urlToCode, ctx, domains) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(MD_LINK_RE, (whole, label, href) => {
    const url = String(href).trim();
    if (!isExternalHttpUrl(url, domains)) return whole;
    const code = urlToCode.get(url);
    return code ? `[${label}](${goUrl(code, ctx)})` : whole;
  });
}

// Idempotent registration: same URL → same code → one row. A code that
// already holds a DIFFERENT url (a hash collision) is skipped, never served.
async function registerOutboundUrls(urls) {
  const list = [...urls];
  const map = new Map();
  if (!list.length) return map;
  const rows = list.map((url) => ({ code: codeForUrl(url), target_url: url }));
  await db('outbound_links').insert(rows).onConflict('code').ignore();
  const stored = await db('outbound_links').whereIn('code', rows.map((r) => r.code)).select('code', 'target_url');
  const byCode = new Map(stored.map((r) => [r.code, r.target_url]));
  for (const r of rows) {
    if (byCode.get(r.code) === r.target_url) map.set(r.target_url, r.code);
  }
  return map;
}

/**
 * Rewrite outside links in prep-guide content for one render.
 *
 *   blocks / textBody — the content to rewrite (either may be omitted)
 *   templateKey       — 'prep.flea', … (non-prep templates are left alone)
 *   prepToken         — the /prep/:token the guide belongs to, when known
 *   customerId        — when known
 *   surface           — 'email' | 'page'
 *
 * Returns { blocks, textBody, rewritten } — the inputs unchanged when the
 * gate is off, the template is not a prep guide, there is no signing secret,
 * nothing is external, or anything at all goes wrong.
 */
async function applyOutlinkTracking({
  blocks, textBody, templateKey, prepToken = null, customerId = null, surface,
} = {}) {
  const unchanged = { blocks, textBody, rewritten: 0 };
  try {
    if (!outlinkTrackingLive()) return unchanged;
    if (!PREP_TEMPLATE_KEY_RE.test(String(templateKey || ''))) return unchanged;
    if (!signingKey()) return unchanged;

    const domains = ownDomains();
    const urls = new Set();
    const list = Array.isArray(blocks) ? blocks : [];
    list.forEach((b) => mapBlockStrings(b, (text) => { collectExternalUrls(text, domains, urls); return text; }));
    collectExternalUrls(textBody, domains, urls);
    if (!urls.size) return unchanged;

    const urlToCode = await registerOutboundUrls(urls);
    if (!urlToCode.size) return unchanged;

    // The prep token is a bearer credential: resolve it to row ids here and
    // put only the ids in the URL. An unresolvable token → no visit linkage.
    const resolved = prepToken ? await resolvePrepToken(prepToken) : null;
    const ctx = {
      templateKey,
      customerId: customerId || resolved?.customerId || null,
      scheduledServiceId: resolved?.scheduledServiceId || null,
      projectId: resolved?.projectId || null,
      surface,
    };
    const rewriteOne = (text) => rewriteText(text, urlToCode, ctx, domains);
    return {
      blocks: Array.isArray(blocks) ? blocks.map((b) => mapBlockStrings(b, rewriteOne)) : blocks,
      textBody: typeof textBody === 'string' ? rewriteOne(textBody) : textBody,
      rewritten: urlToCode.size,
    };
  } catch (err) {
    logger.warn(`[outlink-tracking] rewrite skipped: ${err.message}`);
    return unchanged;
  }
}

// The prep token embedded in a payload's prep_url (the tokened /prep/:token
// link every prep send carries), or null.
function prepTokenFromUrl(url) {
  const m = /\/prep\/([a-f0-9]{32})(?:[/?#]|$)/i.exec(String(url || ''));
  return m ? m[1].toLowerCase() : null;
}

/**
 * Email leg: returns a copy of `version` whose blocks/text_body carry the
 * rewritten links (id and every other field preserved), or `version` itself
 * when nothing changed. The stored template version is never modified.
 */
async function withOutlinkTrackingForEmail({ template, version, payload, recipientType, recipientId }) {
  const templateKey = template?.template_key;
  if (!outlinkTrackingLive() || !PREP_TEMPLATE_KEY_RE.test(String(templateKey || ''))) return version;
  let blocks = version?.blocks;
  if (typeof blocks === 'string') {
    try { blocks = JSON.parse(blocks); } catch { return version; }
  }
  const out = await applyOutlinkTracking({
    blocks,
    textBody: version?.text_body,
    templateKey,
    prepToken: prepTokenFromUrl(payload?.prep_url),
    customerId: recipientType === 'customer' ? recipientId : null,
    surface: 'email',
  });
  if (!out.rewritten) return version;
  return { ...version, blocks: out.blocks, text_body: out.textBody };
}

// Resolve a verified prep token to the visit/project (+ customer) it belongs
// to. Read-only; null when the token owns nothing.
async function resolvePrepToken(token) {
  if (!token) return null;
  const service = await db('scheduled_services').where({ prep_token: token }).first('id', 'customer_id');
  if (service) return { scheduledServiceId: service.id, projectId: null, customerId: service.customer_id || null };
  const project = await db('projects').where({ prep_token: token }).first('id', 'customer_id');
  if (project) return { scheduledServiceId: null, projectId: project.id, customerId: project.customer_id || null };
  return null;
}

/**
 * Registered destination for a code, or null. Defense in depth: the stored
 * url must still be http(s) and must hash back to its own code.
 */
async function lookupDestination(code) {
  if (!CODE_RE.test(String(code || ''))) return null;
  const row = await db('outbound_links').where({ code }).first('id', 'code', 'target_url');
  if (!row) return null;
  if (!/^https?:\/\//i.test(row.target_url) || codeForUrl(row.target_url) !== row.code) return null;
  return row;
}

// One click row. Callers fire-and-forget and skip bots before calling. The
// context is already verified and carries row ids only.
async function recordClick({ link, context, ip, userAgent }) {
  await db('outbound_link_clicks').insert({
    outbound_link_id: link.id,
    clicked_at: new Date(),
    template_key: context?.templateKey || null,
    surface: context?.surface || null,
    scheduled_service_id: context?.scheduledServiceId || null,
    project_id: context?.projectId || null,
    customer_id: context?.customerId || null,
    ip_hash: ip ? crypto.createHash('sha256').update(String(ip)).digest('hex') : null,
    user_agent: userAgent ? String(userAgent).slice(0, 500) : null,
  });
}

module.exports = {
  applyOutlinkTracking,
  withOutlinkTrackingForEmail,
  lookupDestination,
  recordClick,
  verifyContext,
  codeForUrl,
  isExternalHttpUrl,
  prepTokenFromUrl,
  CODE_RE,
};
