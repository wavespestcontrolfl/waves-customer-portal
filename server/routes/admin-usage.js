/**
 * Admin portal usage tracking — /api/admin/usage
 *
 * First-party replacement for the analytics /admin never gets (PostHog is
 * deliberately excluded from admin surfaces — see
 * client/src/lib/analytics/posthog.js). AdminLayoutV2 fires a
 * fire-and-forget POST /track on every admin route change; GET /summary
 * aggregates "what do I actually use, how often, and how do I get there"
 * for the Settings → Portal Usage tab.
 *
 * Privacy contract: rows are staff-only navigation metadata. page_key /
 * path / tab are validated against strict slug patterns server-side, so a
 * customer id, search string, or free text can never be persisted even by
 * a buggy or hostile client.
 */
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { parseETDateTime, etDateString, addETDays } = require('../utils/datetime-et');

router.use(adminAuthenticate, requireTechOrAdmin);

// Strict shapes — reject anything that isn't an obvious route slug. The
// client normalizes before sending; this is the backstop.
const PAGE_KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PATH_RE = /^\/admin(?:\/[a-zA-Z0-9:_-]+){0,6}$/;
// Tabs are route-structure words: letter-first, lowercase, hyphenated.
// Digits-only ('5551234567') and underscore values ('john_smith') are not
// tabs anywhere in this app — reject them so a crafted ?tab= link followed
// by a staff member can't smuggle an identifier (Codex #2961 r4). Residual:
// a hyphenated lowercase word is shape-indistinguishable from a tab slug,
// same bounded residual as path route words.
const TAB_RE = /^(?=.{1,32}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SOURCES = new Set(['sidebar', 'tabbar', 'more', 'palette', 'load', 'in-app']);
const EVENT_TYPES = new Set(['page_view']);

// Mirror of the client normalizer's ID detection (lib/adminUsage.js). The
// privacy contract above must hold even against a regressed or hostile
// authenticated client, so raw identifiers are stripped HERE too, not just
// client-side (Codex #2961 r2). Opaque = ≥20 chars with at least one
// uppercase/digit/underscore — hyphenated lowercase route words
// ('pricing-reality-check') are route structure, not tokens.
const UUID_SEGMENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_SEGMENT_RE = /^\d+$/;
const OPAQUE_SEGMENT_RE = /^(?=[A-Za-z0-9_-]*[A-Z0-9_])[A-Za-z0-9_-]{20,}$/;

function isIdSegment(seg) {
  return UUID_SEGMENT_RE.test(seg) || NUMERIC_SEGMENT_RE.test(seg) || OPAQUE_SEGMENT_RE.test(seg);
}

// Route STRUCTURE is lowercase slug words. Any segment that isn't (mixed
// case, underscores — 'John_Smith') is an identifier, whatever its length:
// the privacy backstop must hold against a regressed/hostile client, not
// just against the shapes our own client produces (Codex #2961 r3).
const ROUTE_WORD_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Entity list routes whose next segment is a record identifier unless it is
// one of that route's known static subpages — catches short lowercase
// identifiers ('/admin/customers/acme') that are shape-indistinguishable
// from route words.
const ENTITY_ROUTES = new Set(['customers', 'estimates', 'invoices', 'leads', 'calls', 'technicians', 'requests']);
const ENTITY_STATIC_SUBPAGES = new Set(['new', 'import', 'map', 'directory', 'kanban', 'search', 'settings', 'duplicates']);

/** '/admin/customers/8f14…e9b1/notes' → '/admin/customers/:id/notes'.
 *  Returns null when the path isn't rooted at /admin. */
function stripIdSegments(path) {
  const segments = path.split('/').filter(Boolean);
  if (segments[0] !== 'admin') return null;
  const rest = segments.slice(1).map((seg, i, arr) => {
    if (seg === ':id') return seg; // already normalized by the client
    if (isIdSegment(seg)) return ':id';
    // Malformed segments ('leads?x=1') stay AS-IS so PATH_RE still rejects
    // the beacon — collapsing them to ':id' would launder junk into a
    // valid-looking path.
    if (!/^[A-Za-z0-9_-]+$/.test(seg)) return seg;
    if (!ROUTE_WORD_RE.test(seg)) return ':id'; // 'John_Smith', 'Acme' — not route structure
    const prev = i > 0 ? arr[i - 1] : null;
    if (prev && ENTITY_ROUTES.has(prev) && !ENTITY_STATIC_SUBPAGES.has(seg)) return ':id'; // 'acme'
    return seg;
  });
  return `/admin${rest.length ? `/${rest.join('/')}` : ''}`;
}

// ET day expression for regularity counts. Constant string by construction —
// never interpolate request input into raw SQL.
const ET_DAY_SQL = "(created_at AT TIME ZONE 'America/New_York')::date";

router.post('/track', async (req, res, next) => {
  try {
    const { pageKey, path, tab, source, eventType } = req.body || {};

    if (typeof pageKey !== 'string' || !PAGE_KEY_RE.test(pageKey) || isIdSegment(pageKey)) {
      return res.status(400).json({ error: 'Invalid pageKey' });
    }
    let cleanPath = null;
    if (path != null) {
      if (typeof path !== 'string' || path.length > 160) {
        return res.status(400).json({ error: 'Invalid path' });
      }
      cleanPath = stripIdSegments(path);
      if (!cleanPath || !PATH_RE.test(cleanPath)) {
        return res.status(400).json({ error: 'Invalid path' });
      }
    }
    if (tab != null && (typeof tab !== 'string' || !TAB_RE.test(tab))) {
      return res.status(400).json({ error: 'Invalid tab' });
    }
    if (source != null && !SOURCES.has(source)) {
      return res.status(400).json({ error: 'Invalid source' });
    }
    if (eventType != null && !EVENT_TYPES.has(eventType)) {
      return res.status(400).json({ error: 'Invalid eventType' });
    }

    await db('admin_usage_events').insert({
      technician_id: req.technicianId,
      event_type: eventType || 'page_view',
      page_key: pageKey,
      path: cleanPath,
      tab: tab || null,
      source: source || null,
    });
    res.status(204).end();
  } catch (err) { next(err); }
});

// GET /summary?days=30&scope=me|all
//
// scope=me (default): the requesting staff member's own usage.
// scope=all: everyone's usage combined — admin-only, since it exposes
// other staff members' activity.
router.get('/summary', async (req, res, next) => {
  try {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
    const scope = req.query.scope === 'all' ? 'all' : 'me';
    if (scope === 'all' && req.techRole !== 'admin') {
      return res.status(403).json({ error: 'Admin access required for scope=all' });
    }

    // Midnight ET, (days - 1) calendar days back — an N-day window that
    // includes today. Real Date object, never a naive ISO string (the
    // timestamptz window leak).
    const since = parseETDateTime(`${etDateString(addETDays(new Date(), -(days - 1)))}T00:00`);

    const base = () => {
      const q = db('admin_usage_events').where('created_at', '>=', since);
      if (scope === 'me') q.where('technician_id', req.technicianId);
      return q;
    };

    const [pageRows, sourceRows, tabRows, totals, userRows] = await Promise.all([
      base()
        .select('page_key')
        .count({ views: '*' })
        .countDistinct({ active_days: db.raw(ET_DAY_SQL) })
        .max({ last_used: 'created_at' })
        .groupBy('page_key')
        .orderBy([{ column: 'active_days', order: 'desc' }, { column: 'views', order: 'desc' }]),
      base()
        .select('page_key', 'source')
        .count({ views: '*' })
        .whereNotNull('source')
        .groupBy('page_key', 'source'),
      base()
        .select('page_key', 'tab')
        .count({ views: '*' })
        .whereNotNull('tab')
        .groupBy('page_key', 'tab'),
      base()
        .count({ views: '*' })
        .countDistinct({ active_days: db.raw(ET_DAY_SQL) })
        .first(),
      scope === 'all'
        ? db('admin_usage_events as e')
          .join('technicians as t', 't.id', 'e.technician_id')
          .where('e.created_at', '>=', since)
          .select('t.id', 't.name')
          .count({ views: '*' })
          .groupBy('t.id', 't.name')
          .orderBy('views', 'desc')
        : Promise.resolve(null),
    ]);

    // Null-prototype accumulators: page_key is client-influenced, and on a
    // plain object a key like 'constructor' resolves the INHERITED Object
    // constructor — `||=` keeps it, `.push` throws, and every summary in
    // the window 500s (Codex #2961 r4).
    const sourcesByPage = Object.create(null);
    for (const r of sourceRows) {
      (sourcesByPage[r.page_key] ||= Object.create(null))[r.source] = Number(r.views);
    }
    const tabsByPage = Object.create(null);
    for (const r of tabRows) {
      (tabsByPage[r.page_key] ||= []).push({ tab: r.tab, views: Number(r.views) });
    }
    for (const list of Object.values(tabsByPage)) {
      list.sort((a, b) => b.views - a.views);
    }

    res.json({
      windowDays: days,
      scope,
      since: since.toISOString(),
      totals: {
        views: Number(totals?.views || 0),
        activeDays: Number(totals?.active_days || 0),
      },
      pages: pageRows.map((r) => ({
        pageKey: r.page_key,
        views: Number(r.views),
        activeDays: Number(r.active_days),
        lastUsed: r.last_used,
        sources: sourcesByPage[r.page_key] || {},
        tabs: tabsByPage[r.page_key] || [],
      })),
      users: userRows
        ? userRows.map((r) => ({ name: r.name, views: Number(r.views) }))
        : undefined,
    });
  } catch (err) { next(err); }
});

module.exports = router;
