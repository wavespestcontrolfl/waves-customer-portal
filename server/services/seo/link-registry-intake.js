/**
 * Intake (plan v2 §4 + §3.4d, step 2): normalize → persist every reference as
 * a durable intake item → dedupe → upsert registry domains → resolve the
 * references whose host is not the target (shorteners, post URLs) on a sweep.
 *
 * Step 1 shipped the paste skeleton (normalize/dedupe/upsert, X posts reported
 * `unresolved` and thrown away). Step 2 keeps every reference: `seo_link_intake_items`
 * is idempotent on `item_key` (`${source}:${normalized raw_url}`), so a re-fed
 * list only bumps `last_seen_at` — but every feed still records the current
 * provenance touch on the domain (per-touch attribution, §3.4b).
 *
 * Never-a-target applies to the RESOLVED host, never the raw one: a bit.ly link
 * or an X post is a reference that has not resolved yet, not an `x.com` domain.
 * Investigation queueing (`agent_state='investigating'`) is left to step 3 — the
 * investigator owns that transition; writing it here with no investigator
 * running would misreport the registry.
 */

const { canonicalProspectDomain } = require('./prospect-domain-lock');
const { parse: parseCsv } = require('csv-parse/sync');
const registry = require('./link-registry');
const { LINK_SOURCES, isNeverTargetHost, intakeItemKey } = registry;
const { SPOKE_SITE_KEYS } = require('../content-astro/spoke-sites');

// Anything that looks like a host or URL. Emails are stripped first so
// `joe@example.com` does not contribute `example.com`.
const TOKEN_RE = /(?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?::\d{1,5})?(?:\/[^\s,;"'<>()[\]{}]*)?/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g;
const X_POST_RE = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/[^/\s]+\/status\/\d+/i;

// Our own hosts: a reference that resolves here is dropped `own_domain`, never
// a target and never parked (§4 step 1).
const OWN_HOSTS = Object.freeze(['wavespestcontrol.com', ...SPOKE_SITE_KEYS]);
function isOwnHost(host) {
  const h = canonicalProspectDomain(host);
  if (!h) return false;
  return OWN_HOSTS.some((n) => h === n || h.endsWith(`.${n}`));
}

function hasPath(token) {
  const t = token.replace(/^https?:\/\//, '');
  const rest = t.replace(/^[^/]+/, '');
  return rest.replace(/^\/+/, '').replace(/\/+$/, '').length > 0;
}

function toUrl(token) {
  return /^https?:\/\//i.test(token) ? token.replace(/^https?:\/\//i, (m) => m.toLowerCase()) : `https://${token}`;
}

// A reference is a pointer at something else — an X post (its outbound link
// is the opportunity) or a shortener link — and is resolved on the sweep,
// never dropped for its own host. Any other never-target host (a profile page
// on x.com, google.com, a bare shortener) points at nothing → dropped.
const SHORTENER_HOSTS = Object.freeze(['t.co', 'bit.ly', 'tinyurl.com', 'goo.gl', 'ow.ly', 'buff.ly', 'lnkd.in', 'rebrand.ly', 'cutt.ly', 'is.gd', 'youtu.be']);
function isShortenerHost(host) {
  const h = canonicalProspectDomain(host);
  return !!h && SHORTENER_HOSTS.some((n) => h === n || h.endsWith(`.${n}`));
}
function isReferenceToken(token) {
  if (X_POST_RE.test(token)) return true;
  return isShortenerHost(token) && hasPath(token);
}

/**
 * parseCsvOpportunities(text) → { rows: [{ raw, note }] } | null
 * Recognizes a header row with a website/domain/url column (the owner's
 * "Website, Primary Action" sheet). Other columns become the row's note, kept
 * on the touch's source_detail so the investigator (step 3) sees the hint.
 * Pure. Returns null when the text is not that shape.
 */
function parseCsvOpportunities(text) {
  let records;
  try {
    // Real CSV grammar (quoted commas, escaped quotes, quoted newlines) via the
    // existing csv-parse dependency; anything it cannot read is not a CSV.
    records = parseCsv(String(text || ''), { bom: true, trim: true, skip_empty_lines: true, relax_column_count: true });
  } catch { return null; }
  if (records.length < 2) return null;
  const header = records[0].map((h) => String(h).trim().toLowerCase());
  const col = header.findIndex((h) => ['website', 'domain', 'url', 'site', 'link'].includes(h));
  if (col < 0) return null;
  const rows = [];
  for (const cells of records.slice(1)) {
    const raw = String(cells[col] || '').trim();
    if (!raw) continue;
    const note = cells.filter((_, i) => i !== col).map((c) => c.trim()).filter(Boolean).join(' | ').slice(0, 160) || null;
    rows.push({ raw, note });
  }
  return { rows };
}

/**
 * parseOpportunities(text)
 *   → { candidates: [{ domain, url, raws: [raw], note }], unresolved: [raw], dropped: [{ token, reason, dropReason }] }
 * Pure. `url` is a submission-url HINT (kept only when the token carried a path).
 * `unresolved` = references that must be resolved before they name a host
 * (X posts, shortener links). `dropped` carries the §3.4d drop_reason.
 */
function parseOpportunities(text) {
  const csv = parseCsvOpportunities(text);
  const inputs = csv ? csv.rows : [{ raw: String(text || '').replace(EMAIL_RE, ' '), note: null }];
  const seen = new Map();
  const unresolved = [];
  const dropped = [];
  for (const input of inputs) {
    const src = csv ? input.raw : input.raw; // csv rows are already one reference each
    for (const rawMatch of src.match(TOKEN_RE) || []) {
      const token = rawMatch.replace(/[.,;:!?)]+$/, '');
      if (isReferenceToken(token)) { if (!unresolved.includes(token)) unresolved.push(token); continue; }
      const domain = canonicalProspectDomain(token);
      if (!domain || !domain.includes('.')) { dropped.push({ token, reason: 'not_a_host', dropReason: 'invalid_url' }); continue; }
      if (isOwnHost(domain)) { dropped.push({ token, reason: 'own_domain', dropReason: 'own_domain' }); continue; }
      if (isNeverTargetHost(domain)) { dropped.push({ token, reason: 'never_target', dropReason: 'never_a_target' }); continue; }
      const url = hasPath(token) ? toUrl(token) : null;
      const prev = seen.get(domain);
      if (!prev) seen.set(domain, { domain, url, raws: [token], note: input.note || null });
      else {
        if (!prev.url && url) prev.url = url;
        if (!prev.raws.includes(token)) prev.raws.push(token);
        if (!prev.note && input.note) prev.note = input.note;
      }
    }
  }
  return { candidates: [...seen.values()], unresolved, dropped };
}

// The persisted hint is bounded (a pasted URL can carry an arbitrary query string).
const URL_HINT_MAX = 500;
function touchDetail(batchDetail, url, note) {
  const parts = [String(batchDetail || '').trim()];
  if (note) parts.push(`note:${String(note).slice(0, 160)}`);
  if (url) parts.push(String(url).slice(0, URL_HINT_MAX));
  const out = parts.filter(Boolean).join(' ');
  return out || null;
}

// Upsert one intake item. On conflict only last_seen_at moves — state,
// attempts and resolution are owned by the sweep (idempotent re-feed).
async function upsertItem(q, item) {
  const row = {
    source: item.source,
    source_detail: item.sourceDetail || null,
    source_ref: item.sourceRef || null,
    raw_url: item.rawUrl,
    item_key: intakeItemKey(item.source, item.rawUrl),
    state: item.state || 'pending',
    resolved_url: item.resolvedUrl || null,
    resolved_host: item.resolvedHost || null,
    domain_id: item.domainId || null,
    drop_reason: item.dropReason || null,
    last_error: null,
  };
  const inserted = await q('seo_link_intake_items').insert(row).onConflict('item_key').ignore().returning(['id']);
  if (inserted && inserted.length) return { id: inserted[0].id, created: true };
  const existing = await q('seo_link_intake_items').where({ item_key: row.item_key }).first('id');
  await q('seo_link_intake_items').where({ id: existing.id }).update({ last_seen_at: q.fn.now() });
  return { id: existing.id, created: false };
}

/**
 * intake(db, { text, source, sourceDetail, sourceRef, dryRun })
 *   → { inserted, touched, existing, candidates, unresolved, dropped, items: { created, seen, pending }, dryRun }
 * Persists every reference as an intake item, upserts every resolvable
 * candidate through ensureDomain() in one transaction, and leaves references
 * (`unresolved`) pending for resolveIntakeItems(). dryRun reports what WOULD
 * be upserted with no writes. Accepts a pasted list, free text, or a CSV with a
 * website/domain/url column (same endpoint, plan §11).
 */
async function intake(db, { text, source = 'list_import', sourceDetail = null, sourceRef = null, dryRun = false } = {}) {
  if (!LINK_SOURCES.includes(source)) throw Object.assign(new Error(`invalid source '${source}'`), { code: 'invalid_source' });
  const parsed = parseOpportunities(text);
  const base = {
    ...parsed, source, sourceDetail, dryRun: !!dryRun,
    inserted: 0, touched: 0, existing: 0,
    items: { created: 0, seen: 0, pending: parsed.unresolved.length },
  };
  if (!parsed.candidates.length && !parsed.unresolved.length && !parsed.dropped.length) return base;

  if (dryRun) {
    const hosts = parsed.candidates.map((c) => c.domain);
    const known = hosts.length ? await db('seo_link_domains').whereIn('domain', hosts).select('domain') : [];
    const knownSet = new Set(known.map((k) => k.domain));
    base.existing = hosts.filter((h) => knownSet.has(h)).length;
    base.inserted = hosts.length - base.existing;
    base.candidates = parsed.candidates.map((c) => ({ ...c, existing: knownSet.has(c.domain) }));
    return base;
  }

  const results = await db.transaction(async (trx) => {
    const out = [];
    for (const c of parsed.candidates) {
      // A pasted URL is a submission-url HINT: persisted on the touch's
      // source_detail (and, for a new host, the first-touch detail) so the
      // investigator (step 3) can recover it — never on the domain's identity.
      const r = await registry.ensureDomain(trx, {
        domain: c.domain, source, sourceDetail: touchDetail(sourceDetail, c.url, c.note), sourceRef,
      });
      for (const raw of c.raws) {
        const it = await upsertItem(trx, {
          source, sourceDetail, sourceRef, rawUrl: raw, state: 'resolved',
          resolvedUrl: toUrl(raw), resolvedHost: c.domain, domainId: r.id,
        });
        base.items[it.created ? 'created' : 'seen'] += 1;
      }
      out.push({ ...c, id: r.id, existing: !r.created, touched: r.touched });
    }
    for (const raw of parsed.unresolved) {
      const it = await upsertItem(trx, { source, sourceDetail, sourceRef, rawUrl: raw, state: 'pending' });
      base.items[it.created ? 'created' : 'seen'] += 1;
    }
    for (const d of parsed.dropped) {
      const it = await upsertItem(trx, { source, sourceDetail, sourceRef, rawUrl: d.token, state: 'dropped', dropReason: d.dropReason });
      base.items[it.created ? 'created' : 'seen'] += 1;
    }
    return out;
  });
  base.candidates = results;
  base.inserted = results.filter((r) => !r.existing).length;
  base.existing = results.length - base.inserted;
  base.touched = results.filter((r) => r.touched).length;
  return base;
}

// ---------------------------------------------------------------------------
// Resolver sweep (§3.4d): pending/unresolved references → hosts.
// ---------------------------------------------------------------------------

// Backoff after each failed attempt; past the last step the item is dropped
// `retry_exhausted` (cap = 7 days, plan §3.4d).
const BACKOFF_MS = Object.freeze([60 * 60e3, 6 * 60 * 60e3, 24 * 60 * 60e3, 72 * 60 * 60e3, 7 * 24 * 60 * 60e3]);
const MAX_ATTEMPTS = BACKOFF_MS.length;
// A claimed item is invisible to a parallel tick for this long (fleet overlap
// during deploys); the final update always rewrites next_retry_at.
const CLAIM_HOLD_MS = 15 * 60e3;
// X posts need the X feeder (a later step) to read their outbound link — the
// hop-follower cannot resolve them. Re-queued a week out without spending an
// attempt so they neither churn nor exhaust.
const X_PARK_MS = 7 * 24 * 60 * 60e3;

/**
 * resolveIntakeItems(db, { limit, now, fetchPage })
 *   → { claimed, resolved, unresolved, dropped, parked, errors: [{ id, error }] }
 * Claims due items FOR UPDATE SKIP LOCKED (fleet-safe without a cron lock),
 * follows each reference through the SSRF-pinned fetchPage in resolveOnly mode,
 * and upserts the resolved host through ensureDomain with the item's own
 * provenance. Network happens outside the claim transaction.
 */
async function resolveIntakeItems(db, { limit = 50, now = new Date(), fetchPage = null, dryRun = false } = {}) {
  const fetcher = fetchPage || require('./contact-finder').fetchPage;
  const out = { claimed: 0, resolved: 0, unresolved: 0, dropped: 0, parked: 0, errors: [] };
  const due = (q) => q('seo_link_intake_items')
    .whereIn('state', ['pending', 'unresolved'])
    .andWhere((b) => b.whereNull('next_retry_at').orWhere('next_retry_at', '<=', now))
    .orderBy('first_seen_at', 'asc')
    .limit(Math.max(1, Math.min(Number(limit) || 50, 500)));

  if (dryRun) {
    // Report only: what the next sweep WOULD claim. No claim hold, no network,
    // no state change — the rows stay due for the real tick.
    const rows = await due(db);
    const wouldPark = rows.filter((r) => X_POST_RE.test(r.raw_url)).length;
    return { ...out, dryRun: true, due: rows.length, wouldPark, wouldFetch: rows.length - wouldPark };
  }

  const claimed = await db.transaction(async (trx) => {
    const rows = await due(trx).forUpdate().skipLocked();
    if (!rows.length) return rows;
    await trx('seo_link_intake_items').whereIn('id', rows.map((r) => r.id))
      .update({ next_retry_at: new Date(now.getTime() + CLAIM_HOLD_MS) });
    return rows;
  });
  out.claimed = claimed.length;

  for (const item of claimed) {
    try {
      if (X_POST_RE.test(item.raw_url)) {
        await db('seo_link_intake_items').where({ id: item.id }).update({
          state: 'unresolved', last_error: 'awaiting_x_feeder', next_retry_at: new Date(now.getTime() + X_PARK_MS),
        });
        out.parked += 1;
        continue;
      }
      const attempts = (item.attempts || 0) + 1;
      const page = await fetcher(toUrl(item.raw_url), { resolveOnly: true });
      const host = page && page.finalUrl ? canonicalProspectDomain(page.finalUrl) : null;

      if (page && (page.error === 'invalid_url' || page.error === 'unsupported_protocol' || page.blocked)) {
        await db('seo_link_intake_items').where({ id: item.id }).update({
          state: 'dropped', drop_reason: 'invalid_url', attempts, last_error: page.error || 'blocked_host', next_retry_at: null,
        });
        out.dropped += 1;
        continue;
      }
      if (host && isOwnHost(host)) {
        await db('seo_link_intake_items').where({ id: item.id }).update({
          state: 'dropped', drop_reason: 'own_domain', attempts, resolved_url: page.finalUrl, resolved_host: host, last_error: null, next_retry_at: null,
        });
        out.dropped += 1;
        continue;
      }
      if (host && !isNeverTargetHost(host)) {
        const r = await db.transaction(async (trx) => {
          const d = await registry.ensureDomain(trx, {
            domain: host, source: item.source, sourceDetail: touchDetail(item.source_detail, page.finalUrl, null), sourceRef: item.source_ref,
          });
          await trx('seo_link_intake_items').where({ id: item.id }).update({
            state: 'resolved', attempts, resolved_url: page.finalUrl, resolved_host: host, domain_id: d.id, last_error: null, next_retry_at: null,
          });
          return d;
        });
        out.resolved += 1;
        void r;
        continue;
      }

      // No usable host yet (network failure, or the chain ended on a
      // never-target host): back off, then exhaust.
      const err = page && page.error ? page.error : (host ? `resolved_to_never_target:${host}` : `status_${(page && page.status) || 0}`);
      if (attempts >= MAX_ATTEMPTS) {
        await db('seo_link_intake_items').where({ id: item.id }).update({
          state: 'dropped', drop_reason: 'retry_exhausted', attempts, last_error: err, next_retry_at: null,
        });
        out.dropped += 1;
      } else {
        await db('seo_link_intake_items').where({ id: item.id }).update({
          state: 'unresolved', attempts, last_error: err, next_retry_at: new Date(now.getTime() + BACKOFF_MS[attempts - 1]),
        });
        out.unresolved += 1;
      }
    } catch (e) {
      out.errors.push({ id: item.id, error: (e && e.message) || String(e) });
      // Leave the claim hold in place; the next due tick retries it.
    }
  }
  return out;
}

module.exports = {
  parseOpportunities, parseCsvOpportunities, intake, resolveIntakeItems,
  _internals: { TOKEN_RE, X_POST_RE, SHORTENER_HOSTS, isShortenerHost, hasPath, touchDetail, URL_HINT_MAX, isReferenceToken, isOwnHost, BACKOFF_MS, MAX_ATTEMPTS, CLAIM_HOLD_MS, X_PARK_MS, upsertItem, toUrl },
};
