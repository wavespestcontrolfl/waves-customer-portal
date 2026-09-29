/**
 * Customer activity timeline (GATE_CUSTOMER_ACTIVITY_TIMELINE, read-only).
 *
 * One newest-first list per customer of what we sent them and what they did,
 * merged from the tables that already record it:
 *
 *   texts        sms_log (sent / delivered / failed, inbound replies)
 *   links        short_code_clicks via short_codes (customer or lead linkage)
 *   emails       email_messages, automation_step_sends, newsletter_send_deliveries
 *   pages        customer_page_views, estimate_views, prep_guide_views,
 *                service_records / projects.report_viewed_at,
 *                customer_contracts.viewed_at, price_change_notices
 *   calls        call_log
 *   portal       customers.last_seen_at  (absent until the portal-visit PR)
 *   outside link outbound_link_clicks    (absent until the /go tracking PR)
 *
 * Two of those sources ship in sibling PRs, so every source declares the
 * relations it needs and is skipped (reported in `absentSources`) when one is
 * missing: the timeline lights up on its own once those merge, with no code
 * change here.
 *
 * ENGAGEMENT RULE. A click, a page view, an inbound text reply and a portal
 * visit are things the customer DID. An email OPEN is not: Apple Mail Privacy
 * Protection pre-fetches every tracking pixel, so opens fire without a human.
 * Opens are listed (kind 'opened') but never engaged, and never feed
 * `lastEngagedAt`; the newest open is reported separately as
 * `lastEmailOpenAt`, labelled unreliable. Calls are shown but, per the brief,
 * are not counted in lastEngagedAt either.
 *
 * PAGINATION. One query per source, each capped at `limit` rows (fetched as
 * limit+1 so a source with exactly `limit` rows is not reported as having
 * more) ordered by the newest event the row has BEFORE the cursor; rows are
 * exploded into events (an email row is up to five) and merged in JS. Any
 * event in the overall top `limit` sits in a row inside its own source's top
 * `limit`, so the merge is
 * exact. The cursor is the last event's ISO time (strictly-before), so two
 * events sharing the same millisecond across a page boundary can drop one:
 * an accepted, cosmetic edge for a read-only feed.
 *
 * The summary (`lastEngagedAt`, `lastEmailOpenAt`) is computed from per-source
 * MAX() queries, not from the visible page, and only on the first page.
 */
const db = require('../models/db');
const logger = require('./logger');

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const PREVIEW_MAX = 140;
const FAR_FUTURE = '9999-12-31T00:00:00.000Z';

// What the customer did. Everything else (sent, delivered, opened, ...) is
// something we did or something a mail client did on its own.
const ENGAGED_KINDS = new Set(['clicked', 'viewed', 'replied']);
const isEngagedKind = (kind) => ENGAGED_KINDS.has(kind);

// ---------------------------------------------------------------------------
// Relation guards (to_regclass / pg_attribute respect the search_path, and are
// cached so a page of the customer screen costs a handful of catalog reads).
// ---------------------------------------------------------------------------
const GUARD_NEGATIVE_TTL_MS = 5 * 60 * 1000;
const guardCache = new Map();

async function cachedGuard(key, probe) {
  const hit = guardCache.get(key);
  if (hit && (hit.ok || Date.now() - hit.at < GUARD_NEGATIVE_TTL_MS)) return hit.ok;
  const ok = !!(await probe());
  guardCache.set(key, { ok, at: Date.now() });
  return ok;
}

function hasRelation(dbh, table) {
  return cachedGuard(`t:${table}`, async () => {
    const r = await dbh.raw('SELECT to_regclass(?) IS NOT NULL AS ok', [table]);
    return r?.rows?.[0]?.ok;
  });
}

function hasColumn(dbh, table, column) {
  return cachedGuard(`c:${table}.${column}`, async () => {
    const r = await dbh.raw(
      `SELECT 1 AS ok FROM pg_attribute
        WHERE attrelid = to_regclass(?) AND attname = ? AND NOT attisdropped AND attnum > 0
        LIMIT 1`,
      [table, column],
    );
    return (r?.rows || []).length > 0;
  });
}

function resetGuardCacheForTests() { guardCache.clear(); }

async function needsPresent(dbh, needs = []) {
  for (const need of needs) {
    const ok = Array.isArray(need)
      ? await hasColumn(dbh, need[0], need[1])
      : await hasRelation(dbh, need);
    if (!ok) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Event construction
// ---------------------------------------------------------------------------
const iso = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

function preview(text, max = PREVIEW_MAX) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function hostOf(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./, ''); } catch { return null; }
}

function mk(source, rowId, ref, { at, channel, kind, title, detail = null }) {
  const when = iso(at);
  if (!when) return null;
  return {
    id: `${source}:${rowId}:${kind}`,
    at: when,
    channel,
    kind,
    title,
    detail: detail || null,
    engaged: isEngagedKind(kind),
    source,
    ref: ref || null,
  };
}

const compact = (list) => list.filter(Boolean);

const PAGE_LABELS = {
  appointment: 'Opened the appointment page',
  reschedule: 'Opened the reschedule page',
  reservice: 'Opened the re-service page',
  'secure-card': 'Opened the secure card page',
  track: 'Opened the live tracking page',
  inspection: 'Opened the inspection page',
};

function pageViewTitle(page) {
  const p = String(page || '');
  if (p.startsWith('portal:')) return 'Opened the portal';
  return PAGE_LABELS[p] || `Opened ${p || 'a page'}`;
}

// ---------------------------------------------------------------------------
// Sources. `from(dbh, ctx)` builds FROM/JOIN/WHERE only (a knex builder is
// thenable, so it is returned synchronously and never awaited before it is
// finished); the runner adds the
// select list, the recency key, the order and the limit. `ts` are the SQL
// expressions that carry an event time for the row. `toEvents(row)` explodes a
// row (all of its timestamps) and the runner drops the ones at/after the
// cursor. `engaged` / `open` feed the first-page summary.
// ---------------------------------------------------------------------------
// sms_log outbound statuses that mean the text was handed to the carrier (or
// failed trying). 'queued' / 'accepted' are the provider's own handed-off states.
const OUTBOUND_LEFT = ['', 'sent', 'queued', 'accepted', 'delivered', 'failed', 'undelivered'];

const SOURCES = [
  {
    name: 'texts',
    // An outbound row only counts once the text actually left: 'scheduled' /
    // 'sending' (queued for a later send), 'canceled' / 'cancelled', 'draft',
    // 'held', 'pending', 'skipped', 'blocked' and 'suppressed' rows never
    // reached the customer, so listing them as "Text sent" would be false.
    // An empty status is a legacy row written before statuses existed.
    from: (dbh, ctx) => dbh('sms_log as sl').where('sl.customer_id', ctx.customerId)
      .where((w) => w.where('sl.direction', 'inbound')
        .orWhereRaw(`LOWER(COALESCE(sl.status, '')) IN (${OUTBOUND_LEFT.map(() => '?').join(', ')})`, OUTBOUND_LEFT)),
    select: ['sl.id', 'sl.direction', 'sl.status', 'sl.message_type', 'sl.message_body', 'sl.created_at'],
    ts: ['sl.created_at'],
    engaged: { expr: 'sl.created_at', where: (q) => q.where('sl.direction', 'inbound') },
    toEvents: (r) => {
      const ref = { type: 'sms_log', id: r.id };
      if (r.direction === 'inbound') {
        return compact([mk('sms', r.id, ref, {
          at: r.created_at, channel: 'sms', kind: 'replied', title: 'Replied by text', detail: preview(r.message_body),
        })]);
      }
      const status = String(r.status || '').toLowerCase();
      if (!OUTBOUND_LEFT.includes(status)) return [];
      const kind = status === 'delivered' ? 'delivered'
        : ['failed', 'undelivered'].includes(status) ? 'failed' : 'sent';
      const title = { delivered: 'Text delivered', failed: 'Text failed', sent: 'Text sent' }[kind];
      const type = r.message_type ? ` (${String(r.message_type).replace(/_/g, ' ')})` : '';
      return compact([mk('sms', r.id, ref, {
        at: r.created_at, channel: 'sms', kind, title: `${title}${type}`, detail: preview(r.message_body),
      })]);
    },
  },
  {
    name: 'link clicks',
    needs: [['short_code_clicks', 'is_bot'], ['short_codes', 'customer_id']],
    // Also count a click on a link minted for one of this customer's leads
    // (a lead-only prospect has no customer_id on the short code yet).
    from: (dbh, ctx) => dbh('short_code_clicks as scc')
      .join('short_codes as sc', 'sc.id', 'scc.short_code_id')
      .where('scc.is_bot', false)
      .where((w) => {
        w.where('sc.customer_id', ctx.customerId);
        if (ctx.leadLinkage) w.orWhereIn('sc.lead_id', dbh('leads').where('customer_id', ctx.customerId).select('id'));
      }),
    select: ['scc.id', 'scc.clicked_at', 'sc.kind', 'sc.channel', 'sc.purpose'],
    ts: ['scc.clicked_at'],
    engaged: { expr: 'scc.clicked_at' },
    toEvents: (r) => {
      const label = String(r.kind && r.kind !== 'other' ? r.kind : 'a').replace(/_/g, ' ');
      return compact([mk('link', r.id, { type: 'short_code_click', id: r.id }, {
        at: r.clicked_at,
        channel: r.channel === 'email' ? 'email' : 'sms',
        kind: 'clicked',
        title: `Clicked ${label === 'a' ? 'a' : `the ${label}`} link`,
        detail: r.purpose ? String(r.purpose).replace(/_/g, ' ') : null,
      })]);
    },
  },
  {
    name: 'emails',
    from: (dbh, ctx) => dbh('email_messages as em')
      .whereRaw("COALESCE(em.recipient_type, '') NOT IN ('admin', 'test')")
      .where((w) => {
        w.where((k) => k.where('em.recipient_type', 'customer').where('em.recipient_id', String(ctx.customerId)));
        // Address match only for mail that is genuinely unowned or owned by a
        // customer PRECURSOR: recipient_type NULL/'' (nobody claimed it) or
        // 'lead' (a prospect who may be this customer; email-bounce-recovery
        // treats lead rows the same way). Mail owned by a customer row (two
        // customers sharing one address must not inherit each other's mail) or
        // by another kind of recipient ('job_application' recruiting mail,
        // 'payer', 'referral_promoter', 'admin', 'test') never rides an address
        // match. This is an allowlist: a new owned type stays out by default.
        if (ctx.emails.length) {
          w.orWhere((k) => k.whereIn('em.recipient_email_snapshot', ctx.emails)
            .whereRaw("COALESCE(em.recipient_type, '') IN ('', 'lead')"));
        }
      }),
    select: ['em.id', 'em.status', 'em.template_key', 'em.subject_snapshot', 'em.queued_at', 'em.updated_at', 'em.sent_at',
      'em.delivered_at', 'em.opened_at', 'em.clicked_at', 'em.bounced_at', 'em.complained_at'],
    // A failure has no column of its own: the row flips to 'failed' on the
    // update that stamps updated_at, so that is the failure time (queued_at is
    // when it was created, which would sort a failure BEFORE its own send).
    ts: ['em.sent_at', 'em.delivered_at', 'em.opened_at', 'em.clicked_at', 'em.bounced_at', 'em.complained_at',
      "CASE WHEN em.status = 'failed' THEN COALESCE(em.updated_at, em.queued_at) END"],
    engaged: { expr: 'em.clicked_at' },
    open: { expr: 'em.opened_at' },
    toEvents: (r) => emailEvents('email', r, r.subject_snapshot || r.template_key, {
      sent: r.sent_at, delivered: r.delivered_at, opened: r.opened_at, clicked: r.clicked_at,
      bounced: r.bounced_at, complained: r.complained_at,
      failed: String(r.status || '') === 'failed' ? (r.updated_at || r.queued_at) : null,
    }, 'email_messages'),
  },
  {
    name: 'automation emails',
    needs: ['automation_step_sends', 'automation_enrollments'],
    from: (dbh, ctx) => dbh('automation_step_sends as s')
      .join('automation_enrollments as e', 'e.id', 's.enrollment_id')
      .leftJoin('automation_templates as t', 't.key', 'e.template_key')
      .where('e.customer_id', ctx.customerId),
    select: ['s.id', 's.status', 's.step_order', 's.sent_at', 's.delivered_at', 's.opened_at', 's.clicked_at',
      's.updated_at', 't.name as template_name', 'e.template_key'],
    // The webhook stamps a bounce/complaint only as status + updated_at (the
    // table has no bounced_at/complained_at), so updated_at dates all three.
    ts: ['s.sent_at', 's.delivered_at', 's.opened_at', 's.clicked_at',
      "CASE WHEN s.status IN ('failed', 'bounced', 'complained') THEN s.updated_at END"],
    engaged: { expr: 's.clicked_at' },
    open: { expr: 's.opened_at' },
    toEvents: (r) => emailEvents('automation', r,
      `${r.template_name || r.template_key || 'Automation'} (step ${Number(r.step_order) + 1 || 1})`, {
        sent: r.sent_at, delivered: r.delivered_at, opened: r.opened_at, clicked: r.clicked_at,
        failed: String(r.status || '') === 'failed' ? r.updated_at : null,
        bounced: String(r.status || '') === 'bounced' ? r.updated_at : null,
        complained: String(r.status || '') === 'complained' ? r.updated_at : null,
      }, 'automation_step_sends'),
  },
  {
    name: 'newsletters',
    needs: ['newsletter_send_deliveries', 'newsletter_sends', ['newsletter_subscribers', 'customer_id']],
    from: (dbh, ctx) => dbh('newsletter_send_deliveries as d')
      .join('newsletter_subscribers as sub', 'sub.id', 'd.subscriber_id')
      .join('newsletter_sends as ns', 'ns.id', 'd.send_id')
      .where('sub.customer_id', ctx.customerId),
    select: ['d.id', 'd.sent_at', 'd.delivered_at', 'd.opened_at', 'd.clicked_at', 'd.bounced_at',
      'd.complained_at', 'ns.subject'],
    ts: ['d.sent_at', 'd.delivered_at', 'd.opened_at', 'd.clicked_at', 'd.bounced_at', 'd.complained_at'],
    engaged: { expr: 'd.clicked_at' },
    open: { expr: 'd.opened_at' },
    toEvents: (r) => emailEvents('newsletter', r, `Newsletter: ${r.subject || 'issue'}`, {
      sent: r.sent_at, delivered: r.delivered_at, opened: r.opened_at, clicked: r.clicked_at,
      bounced: r.bounced_at, complained: r.complained_at,
    }, 'newsletter_send_deliveries'),
  },
  {
    name: 'page views',
    needs: ['customer_page_views'],
    from: (dbh, ctx) => dbh('customer_page_views as pv').where('pv.customer_id', ctx.customerId),
    select: ['pv.id', 'pv.page', 'pv.viewed_at'],
    ts: ['pv.viewed_at'],
    engaged: { expr: 'pv.viewed_at' },
    toEvents: (r) => compact([mk('pageview', r.id, { type: 'customer_page_view', id: r.id }, {
      at: r.viewed_at,
      channel: String(r.page || '').startsWith('portal:') ? 'portal' : 'page',
      kind: 'viewed',
      title: pageViewTitle(r.page),
      detail: String(r.page || '').startsWith('portal:') ? String(r.page).slice('portal:'.length) : null,
    })]),
  },
  {
    name: 'estimate views',
    needs: ['estimate_views', 'estimates'],
    from: (dbh, ctx) => dbh('estimate_views as ev').join('estimates as es', 'es.id', 'ev.estimate_id')
      .where('es.customer_id', ctx.customerId),
    select: ['ev.id', 'ev.viewed_at', 'es.id as estimate_id', 'es.address'],
    ts: ['ev.viewed_at'],
    engaged: { expr: 'ev.viewed_at' },
    toEvents: (r) => compact([mk('estimate', r.id, { type: 'estimate', id: r.estimate_id }, {
      at: r.viewed_at, channel: 'page', kind: 'viewed', title: 'Opened their estimate', detail: r.address,
    })]),
  },
  {
    name: 'prep guide views',
    needs: ['prep_guide_views', ['prep_guide_views', 'scheduled_service_id'], 'scheduled_services', 'projects'],
    from: (dbh, ctx) => dbh('prep_guide_views as v')
      .leftJoin('scheduled_services as ss', 'ss.id', 'v.scheduled_service_id')
      .leftJoin('projects as p', 'p.id', 'v.project_id')
      .where((w) => w.where('ss.customer_id', ctx.customerId).orWhere('p.customer_id', ctx.customerId)),
    select: ['v.id', 'v.viewed_at', 'v.scheduled_service_id', 'v.project_id'],
    ts: ['v.viewed_at'],
    engaged: { expr: 'v.viewed_at' },
    toEvents: (r) => compact([mk('prep', r.id,
      r.scheduled_service_id ? { type: 'scheduled_service', id: r.scheduled_service_id } : { type: 'project', id: r.project_id }, {
        at: r.viewed_at, channel: 'page', kind: 'viewed', title: 'Opened the prep guide',
      })]),
  },
  {
    name: 'service report views',
    needs: [['service_records', 'report_viewed_at']],
    from: (dbh, ctx) => dbh('service_records as sr').where('sr.customer_id', ctx.customerId).whereNotNull('sr.report_viewed_at'),
    select: ['sr.id', 'sr.report_viewed_at', 'sr.service_type'],
    ts: ['sr.report_viewed_at'],
    engaged: { expr: 'sr.report_viewed_at' },
    toEvents: (r) => compact([mk('report', r.id, { type: 'service_record', id: r.id }, {
      at: r.report_viewed_at, channel: 'page', kind: 'viewed', title: 'Opened their service report', detail: r.service_type,
    })]),
  },
  {
    name: 'inspection report views',
    needs: [['projects', 'report_viewed_at']],
    from: (dbh, ctx) => dbh('projects as pr').where('pr.customer_id', ctx.customerId).whereNotNull('pr.report_viewed_at'),
    select: ['pr.id', 'pr.report_viewed_at', 'pr.project_type'],
    ts: ['pr.report_viewed_at'],
    engaged: { expr: 'pr.report_viewed_at' },
    toEvents: (r) => compact([mk('projectreport', r.id, { type: 'project', id: r.id }, {
      at: r.report_viewed_at, channel: 'page', kind: 'viewed', title: 'Opened their inspection report',
      detail: r.project_type ? String(r.project_type).replace(/_/g, ' ') : null,
    })]),
  },
  {
    name: 'contract views',
    needs: [['customer_contracts', 'viewed_at']],
    from: (dbh, ctx) => dbh('customer_contracts as cc').where('cc.customer_id', ctx.customerId).whereNotNull('cc.viewed_at'),
    select: ['cc.id', 'cc.viewed_at', 'cc.title'],
    ts: ['cc.viewed_at'],
    engaged: { expr: 'cc.viewed_at' },
    toEvents: (r) => compact([mk('contract', r.id, { type: 'contract', id: r.id }, {
      at: r.viewed_at, channel: 'page', kind: 'viewed', title: 'Opened a contract', detail: r.title,
    })]),
  },
  {
    name: 'price-change notice views',
    needs: [['price_change_notices', 'first_viewed_at']],
    from: (dbh, ctx) => dbh('price_change_notices as pn').where('pn.customer_id', ctx.customerId).whereNotNull('pn.first_viewed_at'),
    select: ['pn.id', 'pn.first_viewed_at', 'pn.view_count'],
    ts: ['pn.first_viewed_at'],
    engaged: { expr: 'pn.first_viewed_at' },
    toEvents: (r) => {
      const n = Number(r.view_count) || 0;
      return compact([mk('pricechange', r.id, { type: 'price_change_notice', id: r.id }, {
        at: r.first_viewed_at, channel: 'page', kind: 'viewed', title: 'Opened the price-change notice',
        detail: n > 1 ? `Viewed ${n} times` : null,
      })]);
    },
  },
  {
    // Sibling PR #5328 (GATE_OUTLINK_TRACKING): absent until it merges.
    name: 'outside link clicks',
    needs: ['outbound_link_clicks', 'outbound_links'],
    from: (dbh, ctx) => dbh('outbound_link_clicks as oc')
      .join('outbound_links as ol', 'ol.id', 'oc.outbound_link_id')
      .where('oc.customer_id', ctx.customerId),
    select: ['oc.id', 'oc.clicked_at', 'oc.surface', 'oc.template_key', 'ol.target_url'],
    ts: ['oc.clicked_at'],
    engaged: { expr: 'oc.clicked_at' },
    toEvents: (r) => compact([mk('outlink', r.id, { type: 'outbound_link_click', id: r.id }, {
      at: r.clicked_at,
      channel: r.surface === 'email' ? 'email' : 'page',
      kind: 'clicked',
      title: 'Clicked an outside link in the prep guide',
      detail: hostOf(r.target_url),
    })]),
  },
  {
    // Sibling stacked PR (portal visits): absent until customers.last_seen_at exists.
    name: 'portal visits',
    needs: [['customers', 'last_seen_at']],
    from: (dbh, ctx) => dbh('customers as cu').where('cu.id', ctx.customerId).whereNotNull('cu.last_seen_at'),
    select: ['cu.id', 'cu.last_seen_at'],
    ts: ['cu.last_seen_at'],
    engaged: { expr: 'cu.last_seen_at' },
    toEvents: (r) => compact([mk('portal', r.id, { type: 'customer', id: r.id }, {
      at: r.last_seen_at, channel: 'portal', kind: 'viewed', title: 'Last seen in the portal',
    })]),
  },
  {
    name: 'calls',
    needs: ['call_log'],
    from: (dbh, ctx) => dbh('call_log as cl').where('cl.customer_id', ctx.customerId),
    select: ['cl.id', 'cl.created_at', 'cl.direction', 'cl.status', 'cl.duration_seconds', 'cl.call_outcome'],
    ts: ['cl.created_at'],
    toEvents: (r) => {
      const inbound = String(r.direction || '').toLowerCase() === 'inbound';
      const secs = Number(r.duration_seconds) || 0;
      const bits = [];
      if (secs > 0) bits.push(`${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`);
      if (r.call_outcome) bits.push(String(r.call_outcome).replace(/_/g, ' '));
      else if (r.status) bits.push(String(r.status).replace(/[-_]/g, ' '));
      return compact([mk('call', r.id, { type: 'call_log', id: r.id }, {
        at: r.created_at, channel: 'call', kind: inbound ? 'called' : 'placed',
        title: inbound ? 'Called us' : 'We called', detail: bits.join(' · ') || null,
      })]);
    },
  },
];

function emailEvents(source, row, subject, stamps, table) {
  const ref = { type: table, id: row.id };
  const detail = preview(subject);
  const defs = [
    ['sent', 'Email sent'],
    ['delivered', 'Email delivered'],
    ['opened', 'Email opened (not reliable)'],
    ['clicked', 'Clicked a link in an email'],
    ['bounced', 'Email bounced'],
    ['complained', 'Marked an email as spam'],
    ['failed', 'Email failed to send'],
  ];
  return compact(defs.map(([kind, title]) => (stamps[kind]
    ? mk(source, row.id, ref, { at: stamps[kind], channel: 'email', kind, title, detail })
    : null)));
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
function recencyKey(exprs, beforeIso) {
  const parts = exprs.map((e) => `CASE WHEN (${e}) < ?::timestamptz THEN (${e}) END`);
  return { sql: `GREATEST(${parts.join(', ')})`, bindings: exprs.map(() => beforeIso) };
}

async function runSource(src, ctx) {
  const { dbh, limit, beforeIso } = ctx;
  const key = recencyKey(src.ts, beforeIso);
  const q = src.from(dbh, ctx)
    .select(src.select)
    .select(dbh.raw(`${key.sql} AS _key`, key.bindings))
    .whereRaw(`${key.sql} IS NOT NULL`, key.bindings)
    .orderBy('_key', 'desc')
    // One extra row tells "exactly `limit` rows" (nothing older) from "more".
    .limit(limit + 1);
  const rows = await q;
  const before = new Date(beforeIso).getTime();
  const events = rows.flatMap((r) => src.toEvents(r)).filter((e) => new Date(e.at).getTime() < before);
  return { events, saturated: rows.length > limit };
}

async function maxOf(dbh, src, ctx, spec) {
  let q = src.from(dbh, ctx);
  if (spec.where) q = spec.where(q);
  const row = await q.select(dbh.raw(`MAX(${spec.expr}) AS m`)).first();
  return iso(row?.m);
}

const latest = (values) => values.filter(Boolean).sort().pop() || null;

/**
 * Per-source MAX() queries settle independently: one failing source drops out
 * of the summary (and is named in `failed`) instead of blanking it for all.
 * Returns { summary, failed }; summary is null only when every query failed.
 */
async function computeSummary(sources, ctx) {
  const tasks = [];
  for (const s of sources) {
    if (s.engaged) tasks.push({ s, kind: 'engaged', run: maxOf(ctx.dbh, s, ctx, s.engaged) });
    if (s.open) tasks.push({ s, kind: 'open', run: maxOf(ctx.dbh, s, ctx, s.open) });
  }
  const results = await Promise.allSettled(tasks.map((t) => t.run));
  const failed = [];
  const engaged = [];
  const opens = [];
  results.forEach((r, i) => {
    const { s, kind } = tasks[i];
    if (r.status === 'rejected') {
      logFailure(`summary (${s.name})`, ctx.customerId, r.reason);
      if (!failed.includes(s.name)) failed.push(s.name);
    } else if (kind === 'engaged') engaged.push({ s, at: r.value });
    else opens.push(r.value);
  });
  if (tasks.length && failed.length === new Set(tasks.map((t) => t.s.name)).size) return { summary: null, failed };
  const newest = engaged.filter((e) => e.at).sort((a, b) => (a.at < b.at ? 1 : -1))[0] || null;
  return {
    summary: {
      lastEngagedAt: newest?.at || null,
      lastEngagedFrom: newest?.s.name || null,
      lastEmailOpenAt: latest(opens),
      lastEmailOpenNote: 'Email opens are unreliable (Apple Mail pre-loads them), so they are not counted as engagement.',
    },
    failed,
  };
}

/** Newest-first merge of per-source event lists strictly before `before`. */
function mergeEvents(lists, { before = null, limit = DEFAULT_LIMIT, saturated = false } = {}) {
  const cutoff = before ? new Date(before).getTime() : Infinity;
  const all = lists.flat()
    .filter((e) => new Date(e.at).getTime() < cutoff)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : (a.id < b.id ? 1 : -1)));
  const events = all.slice(0, limit);
  const hasMore = all.length > limit || saturated;
  return { events, hasMore, nextCursor: hasMore && events.length ? events[events.length - 1].at : null };
}

// Knex puts the SQL with its bindings (the customer's email) into err.message,
// so a failure is logged by source, customer id and database error code only.
function logFailure(what, customerId, err) {
  logger.warn(`[customer-activity-timeline] ${what} failed for customer ${customerId} (code ${err?.code || 'n/a'})`);
}

function clampLimit(limit) {
  const n = Math.floor(Number(limit));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/**
 * getCustomerActivity(customerId, { before, limit }) ->
 *   { events, hasMore, nextCursor, summary, absentSources, unavailableSources }
 * `summary` is null on cursor pages (only the first page carries it).
 * `dbh` is injectable for tests.
 */
async function getCustomerActivity(customerId, { before = null, limit = DEFAULT_LIMIT } = {}, dbh = db) {
  const cap = clampLimit(limit);
  let beforeIso = null;
  if (before) {
    beforeIso = iso(before);
    if (!beforeIso) throw Object.assign(new Error('before must be a valid date'), { status: 400 });
  }

  const customer = await dbh('customers').where({ id: customerId }).whereNull('deleted_at').first('id', 'email');
  if (!customer) return null;
  const emails = [...new Set([customer.email, String(customer.email || '').toLowerCase()]
    .map((e) => String(e || '').trim()).filter(Boolean))];
  const leadLinkage = await hasColumn(dbh, 'short_codes', 'lead_id') && await hasColumn(dbh, 'leads', 'customer_id');
  const ctx = { dbh, customerId: customer.id, emails, leadLinkage, limit: cap, beforeIso: beforeIso || FAR_FUTURE };

  const absentSources = [];
  const live = [];
  for (const src of SOURCES) {
    if (await needsPresent(dbh, src.needs)) live.push(src);
    else absentSources.push(src.name);
  }

  const unavailableSources = [];
  const settled = await Promise.all(live.map(async (src) => {
    try {
      return await runSource(src, ctx);
    } catch (err) {
      logFailure(src.name, customer.id, err);
      unavailableSources.push(src.name);
      return { events: [], saturated: false };
    }
  }));

  const merged = mergeEvents(settled.map((s) => s.events), {
    before: beforeIso, limit: cap, saturated: settled.some((s) => s.saturated),
  });

  let summary = null;
  if (!beforeIso) {
    try {
      const out = await computeSummary(live.filter((s) => !unavailableSources.includes(s.name)), ctx);
      summary = out.summary;
      for (const name of out.failed) if (!unavailableSources.includes(name)) unavailableSources.push(name);
    } catch (err) {
      logFailure('summary', customer.id, err);
      unavailableSources.push('summary');
    }
  }

  return { ...merged, summary, absentSources, unavailableSources };
}

module.exports = {
  getCustomerActivity,
  mergeEvents,
  isEngagedKind,
  ENGAGED_KINDS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  SOURCES,
  hasRelation,
  hasColumn,
  needsPresent,
  resetGuardCacheForTests,
};
