/**
 * Customer activity timeline (GATE_CUSTOMER_ACTIVITY_TIMELINE, read-only).
 *
 * One newest-first list per customer of what we sent them and what they did,
 * merged from the tables that already record it:
 *
 *   texts    sms_log (sent / delivered / failed, inbound replies)
 *   links    short_code_clicks via short_codes (customer or lead linkage)
 *   emails   email_messages, automation_step_sends, newsletter_send_deliveries
 *   outside  outbound_link_clicks (prep-guide links to Chewy, Amazon, ...)
 *   pages    customer_page_views, estimate_views, prep_guide_views,
 *            service_records / projects.report_viewed_at,
 *            customer_contracts.viewed_at, price_change_notices
 *   calls    call_log
 *
 * ENGAGEMENT RULE (owner-approved, PR #5337 round 3). `engaged` (the badge and
 * `summary.lastEngagedAt`) comes ONLY from first-party evidence that was
 * already bot / staff filtered where it was recorded:
 *
 *   short_code_clicks     human/bot-filtered at /l/
 *   customer_page_views   filtered by its recorder (incl. a push:open row: a
 *                         server-verified open of that customer's own notification,
 *                         and the portal tab views)
 *   inbound sms replies   non-recruiting
 *
 * Everything else is shown in the feed and NEVER engaged: SendGrid opens AND
 * clicks (a scanner or Apple Mail Privacy Protection fires both with no human),
 * the raw token-page stamps (estimate / prep guide / report / contract /
 * price-change views, written unfiltered), outside-link clicks and calls. An
 * outside-link click (/go, bot + staff filtered) cannot say WHO clicked: a prep
 * email can go to the account's service contact and is still attributed to the
 * customer, and the prep page is shared by token, so it is listed and never
 * engaged. Provider clicks are
 * labelled as such and the raw stamps "(unfiltered)". The summary reports the
 * newest open (`lastEmailOpenAt`) and newest provider click
 * (`lastProviderClickAt`) as separate informational fields. One tap that
 * produced both a provider click and a short-link click shows once, as the
 * short-link click (or, for a prep email, as the outside-link click). A click on a link delivered to a
 * third party (a bill-to payer's AP inbox or an operator-named one-off
 * invoice recipient; the code is minted under the homeowner's customer_id)
 * reads "Link clicked by invoice recipient" and is never engaged.
 * A scheduled text's queue parent is hidden when its provider row is listed.
 *
 * RECIPIENTS. Every email event names the address the send row itself recorded
 * (email_messages.recipient_email_snapshot, automation_step_sends.email,
 * newsletter_send_deliveries.email: each is a snapshot taken at send time, so a
 * later address change does not rewrite history), masked
 * ("to b***@example.com"): no guessing which sends were the customer's
 * own, so a third-party inbox (a payer, an accounts-payable desk) reads as one.
 *
 * PAGINATION. One query per source, each capped at `limit` rows (fetched as
 * limit+1 so a source with exactly `limit` rows is not reported as having
 * more) ordered by the newest event the row has BEFORE the cursor; rows are
 * exploded into events (an email row is up to five) and merged in JS. Any
 * event in the overall top `limit` sits in a row inside its own source's top
 * `limit`, so the merge is exact (each row's ranking times are exactly the times
 * that become its events, including the provider-click collapse, which is SQL).
 * The cursor is the last event's ISO time (strictly-before), so two events
 * sharing the same millisecond across a page boundary can drop one: an
 * accepted, cosmetic edge for a read-only feed.
 *
 * The summary is computed from per-source MAX() queries, not from the visible
 * page, and only on the first page. It also carries `lastSeenAt`
 * (customers.last_seen_at, written only by the portal / app foreground
 * beacons): informational, never an event and never part of `lastEngagedAt`.
 */
const db = require('../models/db');
const logger = require('./logger');
const { excludeRecruitingSmsLog } = require('../utils/recruiting-thread-scope');
const { excludeUnresolvedSendReservations } = require('./messaging/review-ask-reservation');
const { leadEmailLinksLive } = require('../config/feature-gates');

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const PREVIEW_MAX = 140;
const FAR_FUTURE = '9999-12-31T00:00:00.000Z';

// What the customer did. Everything else (sent, delivered, opened, ...) is
// something we did or something a mail client did on its own.
const ENGAGED_KINDS = new Set(['clicked', 'viewed', 'replied']);
const isEngagedKind = (kind) => ENGAGED_KINDS.has(kind);

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

function mk(source, rowId, ref, { at, channel, kind, title, detail = null, engaged = isEngagedKind(kind) }) {
  const when = iso(at);
  if (!when) return null;
  return {
    id: `${source}:${rowId}:${kind}`,
    at: when,
    channel,
    kind,
    title,
    detail: detail || null,
    engaged,
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

const PUSH_OPEN_PAGE = 'push:open';
const NOTIFICATION_SUBJECT_RE = /^notification:([0-9a-f-]{36})$/i;
const PUSH_PLATFORMS = new Set(['web', 'ios', 'android']);

function outlinkHost(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./i, '') || null;
  } catch {
    return null;
  }
}

function pageViewTitle(page) {
  const p = String(page || '');
  if (p.startsWith('portal:')) return 'Opened the portal';
  return PAGE_LABELS[p] || `Opened ${p || 'a page'}`;
}

// ---------------------------------------------------------------------------
// Sources. `from(dbh, ctx)` builds FROM/JOIN/WHERE only (a knex builder is
// thenable, so it is returned synchronously and never awaited before it is
// finished); the runner adds the select list, the recency key, the order and
// the limit. `ts` are the SQL expressions that carry an event time for the row
// (a function gets ctx and returns { sql, bindings }); `select` entries may
// likewise be `(dbh, ctx) => raw`. `toEvents(row)` explodes a row (all of its
// timestamps) and the runner drops the ones at/after the cursor. `engaged`
// (first-party evidence only), `open` and `providerClick` feed the first-page
// summary.
// ---------------------------------------------------------------------------
// sms_log outbound statuses that mean the text was handed to the carrier (or
// failed trying). 'queued' / 'accepted' are the provider's own handed-off
// states; 'read' is a delivered text the recipient's device confirmed.
const OUTBOUND_LEFT = ['', 'sent', 'queued', 'accepted', 'delivered', 'read', 'failed', 'undelivered'];

// The time of an outbound text's terminal outcome. sms_log carries no status
// timestamp: twilio-webhook.js /status only rewrites sms_log.status, and
// sms_log.updated_at is also written by non-status writers (reservation
// confirm, cancel, from_phone repair), so it is not a status time. The same
// callback DOES stamp the inbox row (messages.delivery_status + updated_at, keyed
// by twilio_sid), so a terminal status (delivered / read / failed / undelivered)
// takes the inbox row's updated_at when that row still reports the same status and
// was touched after the send. Anything else (an in-flight status, an inbound
// text, a push proof or a text with no inbox row) keeps created_at. In SQL so the
// ranking key is exactly the time that becomes the event.
const SMS_OUTCOME_STATUSES = ['delivered', 'read', 'failed', 'undelivered'];
const SMS_EVENT_AT_SQL = `(CASE WHEN sl.direction = 'outbound' AND sl.twilio_sid IS NOT NULL
    AND LOWER(COALESCE(sl.status, '')) IN (${SMS_OUTCOME_STATUSES.map((x) => `'${x}'`).join(', ')})
  THEN COALESCE((SELECT MAX(sm.updated_at) FROM messages sm
      WHERE sm.twilio_sid = sl.twilio_sid
        AND LOWER(COALESCE(sm.delivery_status, '')) = LOWER(sl.status)
        AND sm.updated_at > sl.created_at), sl.created_at)
  ELSE sl.created_at END)`;

function isPushProof(row) {
  if (String(row.from_phone || '').toLowerCase() === 'push') return true;
  let meta = row.metadata;
  if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
  return String(meta?.channel || '').toLowerCase() === 'push';
}

const maskEmail = (email) => {
  const [local = '', domain = ''] = String(email || '').trim().split('@');
  return local && domain ? `${local.slice(0, 1)}***@${domain}`.toLowerCase() : null;
};

// A short code delivered to a third party (a payer's AP inbox, or a one-off
// invoice recipient an operator named) is minted under
// the homeowner's customer_id (invoice-email.js), so a click on it is theirs,
// never the homeowner's engagement. Two signals: the code's own purpose marker
// ('payer_invoice', stamped at the producer going forward) and, for codes minted
// before the marker existed, the invoice the code points at carrying a payer
// (short_codes.entity_type 'invoices' -> invoices.payer_id). The second one is
// deliberately conservative: a payer-billed invoice's link is treated as the
// payer's even if the homeowner ever received a copy.
const payerCodeSql = (alias) => `(COALESCE(${alias}.purpose, '') = 'payer_invoice'
  OR (${alias}.entity_type = 'invoices' AND EXISTS (
    SELECT 1 FROM invoices pinv WHERE pinv.id = ${alias}.entity_id AND pinv.payer_id IS NOT NULL)))`;

// A provider-reported click (SendGrid) is informational: a scanner fires it as
// readily as a person. When the same tap also produced a human short-link click
// (email links are short-wrapped), that click is the engaged event and the
// provider click is not listed a second time: a short_code_clicks row for this
// customer (or their lead) within two minutes of it. A prep email's outside
// links go through /go instead, so an email-surface outbound_link_clicks row in
// the same window collapses it too (that row is listed, never engaged). The
// whole predicate is parenthesized: callers negate it. It is SQL so the ranking
// times below stay exactly the times that become events.
function nearShortClick(tsExpr, ctx) {
  return {
    sql: `(EXISTS (SELECT 1 FROM short_code_clicks scx JOIN short_codes scy ON scy.id = scx.short_code_id
      WHERE scx.is_bot = false
        AND (scy.customer_id = ? OR scy.lead_id IN (SELECT ld.id FROM leads ld WHERE ld.customer_id = ?))
        AND NOT ${payerCodeSql('scy')}
        AND scx.clicked_at BETWEEN ${tsExpr} - INTERVAL '2 minutes' AND ${tsExpr} + INTERVAL '2 minutes')
      OR EXISTS (SELECT 1 FROM outbound_link_clicks olx
      WHERE olx.customer_id = ?
        AND olx.surface = 'email'
        AND olx.clicked_at BETWEEN ${tsExpr} - INTERVAL '2 minutes' AND ${tsExpr} + INTERVAL '2 minutes'))`,
    bindings: [ctx.customerId, ctx.customerId, ctx.customerId],
  };
}
// The provider click's ranking time (null once collapsed) and its collapse flag.
const providerClickTime = (col) => (ctx) => {
  const near = nearShortClick(col, ctx);
  return { sql: `CASE WHEN ${col} IS NOT NULL AND NOT ${near.sql} THEN ${col} END`, bindings: near.bindings };
};
const providerClickCollapsed = (col) => (dbh, ctx) => {
  const near = nearShortClick(col, ctx);
  return dbh.raw(`${near.sql} AS clicked_collapsed`, near.bindings);
};

const SOURCES = [
  {
    name: 'texts',
    // An outbound row only counts once the text actually left: 'scheduled' /
    // 'sending' (queued for a later send), 'canceled' / 'cancelled', 'draft',
    // 'held', 'pending', 'skipped', 'blocked' and 'suppressed' rows never
    // reached the customer, so listing them as "Text sent" would be false.
    // An empty status is a legacy row written before statuses existed.
    // Recruiting texts (applicant replies and interview invites) can carry a
    // customer's id when an applicant is also a customer; they are owner-only
    // and never customer history, so the shared sms_log exclusion applies to
    // the feed and to the summary MAX queries alike (both build from here).
    // An unresolved review-ask / billing-leg reservation placeholder can carry
    // an OUTBOUND_LEFT status (failed / undelivered) yet never reached the
    // customer, so it is dropped in SQL before paging, like every sms_log reader.
    from: (dbh, ctx) => excludeUnresolvedSendReservations(excludeRecruitingSmsLog(dbh('sms_log as sl').where('sl.customer_id', ctx.customerId)
      .where((w) => w.where('sl.direction', 'inbound')
        .orWhereRaw(`LOWER(COALESCE(sl.status, '')) IN (${OUTBOUND_LEFT.map(() => '?').join(', ')})`, OUTBOUND_LEFT))
      // A scheduled send is two rows: the queue parent (promoted to 'sent' when
      // the text leaves) and the provider row that names it in
      // metadata.scheduled_sms_log_id. Show the provider row (it carries the
      // real push/text classification and status); keep the parent only when no
      // visible provider row references it. In SQL so paging stays exact.
      .whereNotExists(function providerTwin() {
        this.select(1).from('sms_log as twin')
          .where('twin.direction', 'outbound')
          .whereRaw('twin.customer_id = sl.customer_id')
          .whereRaw('twin.id <> sl.id')
          .whereRaw("twin.metadata->>'scheduled_sms_log_id' = sl.id::text")
          .whereRaw(`LOWER(COALESCE(twin.status, '')) IN (${OUTBOUND_LEFT.map(() => '?').join(', ')})`, OUTBOUND_LEFT)
          .modify((q) => excludeUnresolvedSendReservations(q, 'twin'));
      }),
    'sl.message_type'), 'sl'),
    select: ['sl.id', 'sl.direction', 'sl.status', 'sl.message_type', 'sl.message_body', 'sl.created_at',
      'sl.from_phone', 'sl.metadata',
      (dbh) => dbh.raw(`${SMS_EVENT_AT_SQL} AS event_at`)],
    ts: [SMS_EVENT_AT_SQL],
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
      const type = r.message_type ? ` (${String(r.message_type).replace(/_/g, ' ')})` : '';
      // A push-proof row (push-channel-routing.js) is the ledger record of an
      // app notification a device accepted: status 'sent', from_phone 'push',
      // metadata.channel 'push'. It is not a text, so it never reads "Text sent".
      if (isPushProof(r)) {
        const failed = ['failed', 'undelivered'].includes(status);
        return compact([mk('sms', r.id, ref, {
          at: r.event_at || r.created_at, channel: 'push', kind: failed ? 'failed' : 'delivered',
          title: `${failed ? 'App notification failed' : 'App notification delivered'}${type}`,
          detail: preview(r.message_body),
        })]);
      }
      const kind = ['delivered', 'read'].includes(status) ? 'delivered'
        : ['failed', 'undelivered'].includes(status) ? 'failed' : 'sent';
      const title = status === 'read' ? 'Text delivered (read receipt)'
        : { delivered: 'Text delivered', failed: 'Text failed', sent: 'Text sent' }[kind];
      return compact([mk('sms', r.id, ref, {
        at: r.event_at || r.created_at, channel: 'sms', kind, title: `${title}${type}`, detail: preview(r.message_body),
      })]);
    },
  },
  {
    name: 'link clicks',
    // Also count a click on a link minted for one of this customer's leads
    // (a lead-only prospect has no customer_id on the short code yet).
    from: (dbh, ctx) => dbh('short_code_clicks as scc')
      .join('short_codes as sc', 'sc.id', 'scc.short_code_id')
      .where('scc.is_bot', false)
      .where((w) => w.where('sc.customer_id', ctx.customerId)
        .orWhereIn('sc.lead_id', dbh('leads').where('customer_id', ctx.customerId).select('id'))),
    select: ['scc.id', 'scc.clicked_at', 'sc.kind', 'sc.channel', 'sc.purpose',
      (dbh) => dbh.raw(`${payerCodeSql('sc')} AS by_payer`)],
    ts: ['scc.clicked_at'],
    // A payer's click on a code minted under the homeowner is not the customer's.
    engaged: { expr: 'scc.clicked_at', where: (q) => q.whereRaw(`NOT ${payerCodeSql('sc')}`) },
    toEvents: (r) => {
      const label = String(r.kind && r.kind !== 'other' ? r.kind : 'a').replace(/_/g, ' ');
      // Only a recorded sms/email channel names one; a code with none (or an
      // unknown one) is a neutral 'link', never assumed to be a text.
      const channel = r.channel === 'email' ? 'email' : r.channel === 'sms' ? 'sms' : 'link';
      if (r.by_payer) {
        return compact([mk('link', r.id, { type: 'short_code_click', id: r.id }, {
          at: r.clicked_at, channel, kind: 'payer_clicked', title: 'Link clicked by invoice recipient',
          detail: `Sent to a third-party invoice recipient, not the customer${label === 'a' ? '' : ` · ${label} link`}`,
        })]);
      }
      return compact([mk('link', r.id, { type: 'short_code_click', id: r.id }, {
        at: r.clicked_at,
        channel,
        kind: 'clicked',
        title: `Clicked ${label === 'a' ? 'a' : `the ${label}`} link`,
        detail: r.purpose ? String(r.purpose).replace(/_/g, ' ') : null,
      })]);
    },
  },
  {
    // Email evidence is provider-reported (SendGrid): shown, never engaged.
    name: 'emails',
    from: (dbh, ctx) => dbh('email_messages as em')
      .whereRaw("COALESCE(em.recipient_type, '') NOT IN ('admin', 'test')")
      .where((w) => {
        w.where((k) => k.where('em.recipient_type', 'customer').where('em.recipient_id', String(ctx.customerId)));
        // Lead-typed (or untyped) mail is owned by whoever recipient_id names:
        // the estimate events keep recipient_type 'lead' even when recipient_id
        // is this CUSTOMER's id (email-template-automation-executor), and a
        // lead row linked to this customer (leads.customer_id) is the same
        // person's precursor. Ownership by id survives an email change.
        w.orWhere((k) => k.whereRaw("COALESCE(em.recipient_type, '') IN ('', 'lead')")
          .where((o) => o.where('em.recipient_id', String(ctx.customerId))
            .orWhereIn('em.recipient_id', dbh('leads').where('customer_id', ctx.customerId).select(dbh.raw('id::text')))));
        // GATE_LEAD_EMAIL_LINKS: mail sent to this customer's lead, or about
        // one of their estimates, before they were a customer
        // (email_messages.lead_id / estimate_id, recorded at send time; see
        // email-lead-links.js). Ownership is by id, so it survives a changed
        // address. Only lead-typed / untyped rows ride the link (a
        // customer-typed row is owned by its recipient_id), and a row whose
        // recipient_id names some OTHER customer never does.
        if (ctx.leadEmailLinks) {
          w.orWhere((k) => k.whereRaw("COALESCE(em.recipient_type, '') IN ('', 'lead')")
            .where((o) => o.whereIn('em.lead_id', dbh('leads').where('customer_id', ctx.customerId).select('id'))
              .orWhereIn('em.estimate_id', dbh('estimates').where('customer_id', ctx.customerId).select('id')))
            .where((o) => o.whereRaw("COALESCE(em.recipient_id, '') IN ('', ?)", [String(ctx.customerId)])
              .orWhereIn('em.recipient_id', dbh('leads').where('customer_id', ctx.customerId).select(dbh.raw('id::text')))));
        }
        // Address match only for mail nobody claimed: recipient_type NULL/''/
        // 'lead' AND no recipient_id at all. A lead-typed row that names some
        // other lead/customer id (another prospect sharing this inbox) never
        // rides the address. Mail owned by a customer row (two customers
        // sharing one address must not inherit each other's mail) or by another
        // kind of recipient ('job_application' recruiting mail, 'payer',
        // 'referral_promoter', 'admin', 'test') never rides an address match.
        // This is an allowlist: a new owned type stays out by default.
        if (ctx.emails.length) {
          // Compared LOWER(TRIM()) on both sides: the snapshot can be mixed-case
          // (backed by email_messages_recipient_email_lower_idx).
          w.orWhere((k) => k.whereRaw(`LOWER(TRIM(em.recipient_email_snapshot)) IN (${ctx.emails.map(() => '?').join(', ')})`, ctx.emails)
            .whereRaw("COALESCE(em.recipient_type, '') IN ('', 'lead')")
            .whereRaw("COALESCE(em.recipient_id, '') = ''"));
        }
      }),
    select: ['em.id', 'em.status', 'em.template_key', 'em.subject_snapshot', 'em.recipient_email_snapshot', 'em.queued_at',
      'em.updated_at', 'em.sent_at', 'em.delivered_at', 'em.opened_at', 'em.clicked_at', 'em.bounced_at', 'em.complained_at',
      providerClickCollapsed('em.clicked_at')],
    // A failure has no column of its own: the row flips to 'failed' on the
    // update that stamps updated_at, so that is the failure time (queued_at is
    // when it was created, which would sort a failure BEFORE its own send).
    ts: ['em.sent_at', 'em.delivered_at', 'em.opened_at', providerClickTime('em.clicked_at'), 'em.bounced_at', 'em.complained_at',
      "CASE WHEN em.status = 'failed' THEN COALESCE(em.updated_at, em.queued_at) END"],
    open: { expr: 'em.opened_at' },
    providerClick: { expr: 'em.clicked_at' },
    toEvents: (r) => emailEvents('email', r, r.subject_snapshot || r.template_key, r.recipient_email_snapshot, {
      sent: r.sent_at, delivered: r.delivered_at, opened: r.opened_at, provider_clicked: r.clicked_collapsed ? null : r.clicked_at,
      bounced: r.bounced_at, complained: r.complained_at,
      failed: String(r.status || '') === 'failed' ? (r.updated_at || r.queued_at) : null,
    }, 'email_messages'),
  },
  {
    name: 'automation emails',
    from: (dbh, ctx) => dbh('automation_step_sends as s')
      .join('automation_enrollments as e', 'e.id', 's.enrollment_id')
      .leftJoin('automation_templates as t', 't.key', 'e.template_key')
      .where('e.customer_id', ctx.customerId),
    select: ['s.id', 's.status', 's.step_order', 's.sent_at', 's.delivered_at', 's.opened_at', 's.clicked_at',
      's.updated_at', 's.email', 't.name as template_name', 'e.template_key', providerClickCollapsed('s.clicked_at')],
    // The webhook stamps a bounce/complaint only as status + updated_at (the
    // table has no bounced_at/complained_at), so updated_at dates all three.
    ts: ['s.sent_at', 's.delivered_at', 's.opened_at', providerClickTime('s.clicked_at'),
      "CASE WHEN s.status IN ('failed', 'bounced', 'complained') THEN s.updated_at END"],
    open: { expr: 's.opened_at' },
    providerClick: { expr: 's.clicked_at' },
    toEvents: (r) => emailEvents('automation', r,
      `${r.template_name || r.template_key || 'Automation'} (step ${Number(r.step_order) + 1 || 1})`, r.email, {
        sent: r.sent_at, delivered: r.delivered_at, opened: r.opened_at, provider_clicked: r.clicked_collapsed ? null : r.clicked_at,
        failed: String(r.status || '') === 'failed' ? r.updated_at : null,
        bounced: String(r.status || '') === 'bounced' ? r.updated_at : null,
        complained: String(r.status || '') === 'complained' ? r.updated_at : null,
      }, 'automation_step_sends'),
  },
  {
    name: 'newsletters',
    from: (dbh, ctx) => dbh('newsletter_send_deliveries as d')
      .join('newsletter_subscribers as sub', 'sub.id', 'd.subscriber_id')
      .join('newsletter_sends as ns', 'ns.id', 'd.send_id')
      .where('sub.customer_id', ctx.customerId),
    select: ['d.id', 'd.sent_at', 'd.delivered_at', 'd.opened_at', 'd.clicked_at', 'd.bounced_at',
      'd.complained_at', 'd.email', 'ns.subject', providerClickCollapsed('d.clicked_at')],
    ts: ['d.sent_at', 'd.delivered_at', 'd.opened_at', providerClickTime('d.clicked_at'), 'd.bounced_at', 'd.complained_at'],
    open: { expr: 'd.opened_at' },
    providerClick: { expr: 'd.clicked_at' },
    toEvents: (r) => emailEvents('newsletter', r, `Newsletter: ${r.subject || 'issue'}`, r.email, {
      sent: r.sent_at, delivered: r.delivered_at, opened: r.opened_at, provider_clicked: r.clicked_collapsed ? null : r.clicked_at,
      bounced: r.bounced_at, complained: r.complained_at,
    }, 'newsletter_send_deliveries'),
  },
  {
    // Bot + staff filtered at /go (shouldRecord; rows from before that filter,
    // 09-29 evening on, may include a staff click). Listed, NEVER engaged: the
    // customer_id is the account the link was rendered for, not who clicked
    // (a prep email can go to the service contact; the page is shared by token).
    name: 'outside link clicks',
    from: (dbh, ctx) => dbh('outbound_link_clicks as olc')
      .join('outbound_links as ol', 'ol.id', 'olc.outbound_link_id')
      .where('olc.customer_id', ctx.customerId),
    select: ['olc.id', 'olc.clicked_at', 'olc.surface', 'olc.template_key', 'ol.target_url'],
    ts: ['olc.clicked_at'],
    toEvents: (r) => {
      // Hostname only: the full URL (path, query, affiliate tags) never reaches the feed.
      const host = outlinkHost(r.target_url);
      const template = r.template_key ? String(r.template_key).replace(/[._]/g, ' ') : null;
      return compact([mk('outlink', r.id, { type: 'outbound_link_click', id: r.id }, {
        at: r.clicked_at,
        channel: r.surface === 'email' ? 'email' : 'page',
        kind: 'outlink_clicked',
        title: 'Outside link clicked (may be a service contact, not counted)',
        detail: [host, template].filter(Boolean).join(' · ') || null,
        engaged: false,
      })]);
    },
  },
  {
    // customer_page_views is recorded by a bot/staff-filtering recorder: engaged.
    name: 'page views',
    from: (dbh, ctx) => dbh('customer_page_views as pv').where('pv.customer_id', ctx.customerId),
    select: ['pv.id', 'pv.page', 'pv.viewed_at', 'pv.subject_type', 'pv.subject_id'],
    ts: ['pv.viewed_at'],
    engaged: { expr: 'pv.viewed_at' },
    toEvents: (r) => {
      const page = String(r.page || '');
      if (page === PUSH_OPEN_PAGE) {
        // A push:open row exists only when the server proved the bell notification
        // belongs to this customer (services/customer-activity.js recordPushOpen),
        // so it is a verified first-party open: engaged. kind 'opened' is not in
        // ENGAGED_KINDS (an email open is unreliable), hence the explicit flag.
        const note = NOTIFICATION_SUBJECT_RE.exec(String(r.subject_id || ''));
        return compact([mk('pageview', r.id, note ? { type: 'notification', id: note[1].toLowerCase() } : { type: 'customer_page_view', id: r.id }, {
          at: r.viewed_at,
          channel: 'push',
          kind: 'opened',
          title: 'Opened app from a notification',
          detail: PUSH_PLATFORMS.has(r.subject_type) ? r.subject_type : null,
          engaged: true,
        })]);
      }
      return compact([mk('pageview', r.id, { type: 'customer_page_view', id: r.id }, {
        at: r.viewed_at,
        channel: page.startsWith('portal:') ? 'portal' : 'page',
        kind: 'viewed',
        title: pageViewTitle(page),
        detail: page.startsWith('portal:') ? page.slice('portal:'.length) : null,
      })]);
    },
  },
  // The token-page stamps below are written unfiltered by their public routes
  // (any load, a scanner or a staff preview included): listed, never engaged.
  {
    name: 'estimate views',
    from: (dbh, ctx) => dbh('estimate_views as ev').join('estimates as es', 'es.id', 'ev.estimate_id')
      .where('es.customer_id', ctx.customerId),
    select: ['ev.id', 'ev.viewed_at', 'es.id as estimate_id', 'es.address'],
    ts: ['ev.viewed_at'],
    toEvents: (r) => compact([mk('estimate', r.id, { type: 'estimate', id: r.estimate_id }, {
      at: r.viewed_at, channel: 'page', kind: 'viewed_unfiltered', title: 'Viewed their estimate (unfiltered)', detail: r.address,
    })]),
  },
  {
    name: 'prep guide views',
    from: (dbh, ctx) => dbh('prep_guide_views as v')
      .leftJoin('scheduled_services as ss', 'ss.id', 'v.scheduled_service_id')
      .leftJoin('projects as p', 'p.id', 'v.project_id')
      .where((w) => w.where('ss.customer_id', ctx.customerId).orWhere('p.customer_id', ctx.customerId)),
    select: ['v.id', 'v.viewed_at', 'v.scheduled_service_id', 'v.project_id'],
    ts: ['v.viewed_at'],
    toEvents: (r) => compact([mk('prep', r.id,
      r.scheduled_service_id ? { type: 'scheduled_service', id: r.scheduled_service_id } : { type: 'project', id: r.project_id }, {
        at: r.viewed_at, channel: 'page', kind: 'viewed_unfiltered', title: 'Viewed the prep guide (unfiltered)',
      })]),
  },
  {
    name: 'service report views',
    from: (dbh, ctx) => dbh('service_records as sr').where('sr.customer_id', ctx.customerId).whereNotNull('sr.report_viewed_at'),
    select: ['sr.id', 'sr.report_viewed_at', 'sr.service_type'],
    ts: ['sr.report_viewed_at'],
    toEvents: (r) => compact([mk('report', r.id, { type: 'service_record', id: r.id }, {
      at: r.report_viewed_at, channel: 'page', kind: 'viewed_unfiltered', title: 'Viewed their service report (unfiltered)', detail: r.service_type,
    })]),
  },
  {
    name: 'inspection report views',
    from: (dbh, ctx) => dbh('projects as pr').where('pr.customer_id', ctx.customerId).whereNotNull('pr.report_viewed_at'),
    select: ['pr.id', 'pr.report_viewed_at', 'pr.project_type'],
    ts: ['pr.report_viewed_at'],
    toEvents: (r) => compact([mk('projectreport', r.id, { type: 'project', id: r.id }, {
      at: r.report_viewed_at, channel: 'page', kind: 'viewed_unfiltered', title: 'Viewed their inspection report (unfiltered)',
      detail: r.project_type ? String(r.project_type).replace(/_/g, ' ') : null,
    })]),
  },
  {
    name: 'contract views',
    from: (dbh, ctx) => dbh('customer_contracts as cc').where('cc.customer_id', ctx.customerId).whereNotNull('cc.viewed_at'),
    select: ['cc.id', 'cc.viewed_at', 'cc.title'],
    ts: ['cc.viewed_at'],
    toEvents: (r) => compact([mk('contract', r.id, { type: 'contract', id: r.id }, {
      at: r.viewed_at, channel: 'page', kind: 'viewed_unfiltered', title: 'Viewed a contract (unfiltered)', detail: r.title,
    })]),
  },
  {
    name: 'price-change notice views',
    from: (dbh, ctx) => dbh('price_change_notices as pn').where('pn.customer_id', ctx.customerId).whereNotNull('pn.first_viewed_at'),
    select: ['pn.id', 'pn.first_viewed_at', 'pn.view_count'],
    ts: ['pn.first_viewed_at'],
    toEvents: (r) => {
      const n = Number(r.view_count) || 0;
      return compact([mk('pricechange', r.id, { type: 'price_change_notice', id: r.id }, {
        at: r.first_viewed_at, channel: 'page', kind: 'viewed_unfiltered', title: 'Viewed the price-change notice (unfiltered)',
        detail: n > 1 ? `Viewed ${n} times` : null,
      })]);
    },
  },
  {
    name: 'calls',
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

// One email row explodes into an event per stamp it carries. The recipient is the
// address the send row itself recorded, masked, on every event.
function emailEvents(source, row, subject, recipient, stamps, table) {
  const ref = { type: table, id: row.id };
  const masked = maskEmail(recipient);
  const detail = [preview(subject, 100), masked && `to ${masked}`].filter(Boolean).join(' · ') || null;
  const defs = [
    ['sent', 'Email sent'],
    ['delivered', 'Email delivered'],
    ['opened', 'Email opened (not reliable)'],
    ['provider_clicked', 'Link clicked (reported by email provider — may be a scanner)'],
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
// Each ts entry is SQL text or (ctx) => { sql, bindings }; its bindings sit
// before the cursor binding, and the expression is written twice per CASE.
function recencyKey(exprs, beforeIso, ctx) {
  const parts = exprs.map((e) => {
    const { sql, bindings = [] } = typeof e === 'function' ? e(ctx) : { sql: e };
    return { sql: `CASE WHEN (${sql}) < ?::timestamptz THEN (${sql}) END`, bindings: [...bindings, beforeIso, ...bindings] };
  });
  return { sql: `GREATEST(${parts.map((p) => p.sql).join(', ')})`, bindings: parts.flatMap((p) => p.bindings) };
}

async function runSource(src, ctx) {
  const { dbh, limit, beforeIso } = ctx;
  const key = recencyKey(src.ts, beforeIso, ctx);
  const q = src.from(dbh, ctx)
    .select(src.select.map((c) => (typeof c === 'function' ? c(dbh, ctx) : c)))
    .select(dbh.raw(`${key.sql} AS _key`, key.bindings))
    .whereRaw(`${key.sql} IS NOT NULL`, key.bindings)
    .orderBy('_key', 'desc')
    // One extra row tells "exactly `limit` rows" (nothing older) from "more".
    .limit(limit + 1);
  const rows = await q;
  const before = new Date(beforeIso).getTime();
  const events = rows.flatMap((r) => src.toEvents(r, ctx)).filter((e) => new Date(e.at).getTime() < before);
  return { events, saturated: rows.length > limit };
}

async function maxOf(dbh, src, ctx, spec) {
  let q = src.from(dbh, ctx);
  if (spec.where) q = spec.where(q, ctx);
  const row = await q.select(dbh.raw(`MAX(${spec.expr}) AS m`)).first();
  return iso(row?.m);
}

const latest = (values) => values.filter(Boolean).sort().pop() || null;

/**
 * Per-source MAX() queries settle independently: one failing source drops out
 * of the summary (and is named in `failed`) instead of blanking it for all.
 * Returns { summary, failed }; summary is null only when every query failed
 * (a source with one failed and one fulfilled query is named in `failed` and
 * still contributes what it returned).
 */
async function computeSummary(sources, ctx) {
  const tasks = [];
  for (const s of sources) {
    for (const kind of ['engaged', 'open', 'providerClick']) {
      if (s[kind]) tasks.push({ s, kind, run: maxOf(ctx.dbh, s, ctx, s[kind]) });
    }
  }
  const results = await Promise.allSettled(tasks.map((t) => t.run));
  const failed = [];
  const engaged = [];
  const opens = [];
  const providerClicks = [];
  results.forEach((r, i) => {
    const { s, kind } = tasks[i];
    if (r.status === 'rejected') {
      logFailure(`summary (${s.name})`, ctx.customerId, r.reason);
      if (!failed.includes(s.name)) failed.push(s.name);
    } else if (kind === 'engaged') engaged.push({ s, at: r.value });
    else if (kind === 'open') opens.push(r.value);
    else providerClicks.push(r.value);
  });
  // A source can run several queries (email sources: open MAX + provider-click
  // MAX): one failing does not hide the others, so the summary is null only
  // when EVERY query failed.
  if (tasks.length && results.every((r) => r.status === 'rejected')) return { summary: null, failed };
  const newest = engaged.filter((e) => e.at).sort((a, b) => (a.at < b.at ? 1 : -1))[0] || null;
  return {
    summary: {
      lastEngagedAt: newest?.at || null,
      lastEngagedFrom: newest?.s.name || null,
      lastEmailOpenAt: latest(opens),
      lastEmailOpenNote: 'Email opens are unreliable (Apple Mail pre-loads them), so they are not counted as engagement.',
      lastProviderClickAt: latest(providerClicks),
      lastProviderClickNote: 'Email-provider clicks are unfiltered (security scanners click links too), so they are not counted as engagement.',
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
 *   { events, hasMore, nextCursor, summary, unavailableSources }
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

  const customer = await dbh('customers').where({ id: customerId }).whereNull('deleted_at').first('id', 'email', 'last_seen_at');
  if (!customer) return null;
  const emails = [...new Set([String(customer.email || '').trim().toLowerCase()].filter(Boolean))];
  const ctx = {
    dbh, customerId: customer.id, emails, limit: cap, beforeIso: beforeIso || FAR_FUTURE,
    // Read at call time so a flip needs no redeploy.
    leadEmailLinks: leadEmailLinksLive(),
  };

  const unavailableSources = [];
  const settled = await Promise.all(SOURCES.map(async (src) => {
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
      const out = await computeSummary(SOURCES.filter((s) => !unavailableSources.includes(s.name)), ctx);
      summary = out.summary;
      // Informational only (portal / app foreground beacons): not an event,
      // and never folded into lastEngagedAt.
      if (summary) summary.lastSeenAt = iso(customer.last_seen_at);
      for (const name of out.failed) if (!unavailableSources.includes(name)) unavailableSources.push(name);
    } catch (err) {
      logFailure('summary', customer.id, err);
      unavailableSources.push('summary');
    }
  }

  return { ...merged, summary, unavailableSources };
}

module.exports = {
  getCustomerActivity,
  mergeEvents,
  isEngagedKind,
  ENGAGED_KINDS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  SOURCES,
};
