const db = require('../models/db');
const logger = require('./logger');

// A failure log line for the notification writers carries only a fixed code /
// constraint — never err.message: a Knex error echoes the SQL and its bound
// values, which for a bell is the notification body (customer names and
// addresses). Behavior (return value / throw) at every call site is unchanged.
function safeErrorSummary(err) {
  const bits = [err ? (err.code || err.name || 'error') : 'error'];
  if (err && err.constraint) bits.push(`constraint=${err.constraint}`);
  return bits.filter(Boolean).join(' ');
}
const { qualifyNotificationLink } = require('./notification-links');
const { isInternalTestCustomerId } = require('./internal-test-customers');

const CUSTOMER_PREFERENCE_KEYS = new Set([
  'appointment_confirmation',
  'service_reminder_72h',
  'service_reminder_24h',
  'tech_en_route',
  'tech_arrived',
  'service_completed',
  'payment_confirmation_sms',
  // Weather/property advisories (property-alerts engine). Column exists
  // since 20260401000104_notification_prefs_enhanced, default true.
  'weather_alerts',
]);

// Admin-feed role scoping, FAIL CLOSED: the persisted admin bell is shared
// (one recipient-less row) and carries owner-only content — estimate and
// finance alerts with customer names and amounts, plus adminRoleOnly
// triggers linking to requireAdmin surfaces. A NON-ADMIN reader therefore
// sees ONLY rows whose triggerKey is explicitly marked techVisible in the
// registry; everything else — including legacy rows with no metadata — is
// hidden and its read state untouchable. Lazy require avoids the
// notification-triggers ↔ notification-service cycle. A caller that passes
// no role (internal jobs, tests) sees the full feed, unchanged.
function scopeAdminFeedToRole(query, role) {
  if (!role || role === 'admin') return query;
  let keys = [];
  try {
    const { TRIGGER_REGISTRY } = require('./notification-triggers');
    keys = Object.entries(TRIGGER_REGISTRY)
      .filter(([, trigger]) => trigger.techVisible)
      .map(([key]) => key);
  } catch (err) {
    logger.warn(`[notifications] role-scope registry load failed: ${err.message}`);
  }
  if (!keys.length) {
    // No tech-visible triggers resolvable → non-admin sees nothing.
    return query.whereRaw('1 = 0');
  }
  return query.whereRaw(
    `COALESCE(metadata->>'triggerKey', '') IN (${keys.map(() => '?').join(', ')})`,
    keys,
  );
}

// Activity-only rows (metadata.feed === 'activity' — deliverOpsDigest stamps
// this for a non-owner audience, admin-alerts-brevity scope 2026-09-28)
// never reach the admin BELL: not its list, not its unread count, not
// mark-all-read. They still show in the Agents → Activity feed, which reads
// notifications directly and does not go through these helpers. Deliberately
// NOT folded into scopeAdminFeedToRole above: that helper also scopes
// markReadAdmin (mark-one-read by id), which the Activity feed's own Review
// link relies on to clear a row the feed itself can see.
function excludeActivityOnlyFromBell(query) {
  return query.whereRaw("COALESCE(metadata->>'feed', '') <> 'activity'");
}

// `scheduledServiceId` (app property scope, PR 3): the five appointment keys
// follow the visit's NON-primary saved property (enforced under
// GATE_APP_PROPERTY_TEXTS, shadow-logged otherwise). Unknown = not sent.
async function customerPreferenceEnabled(customerId, preferenceKey, { scheduledServiceId = null } = {}) {
  if (!preferenceKey) return true;
  if (!CUSTOMER_PREFERENCE_KEYS.has(preferenceKey)) {
    logger.error(`[notifications] Unknown customer preference key: ${preferenceKey}`);
    return false;
  }

  try {
    const PropertyTexts = require('./property-notification-prefs');
    // Only the five appointment keys are property-owned; the resolver needs
    // the whole toggle set of the customer row to compare against.
    const propertyOwned = !!scheduledServiceId && PropertyTexts.APPOINTMENT_TOGGLES.includes(preferenceKey);
    let prefs = await db('notification_prefs')
      .where({ customer_id: customerId })
      .first(...(propertyOwned ? [...new Set([...PropertyTexts.PROPERTY_PREF_COLUMNS, preferenceKey])] : [preferenceKey]));
    if (propertyOwned) {
      prefs = await PropertyTexts.prefsForVisit(prefs, customerId, scheduledServiceId, 'bell');
    }
    return !prefs || prefs[preferenceKey] !== false;
  } catch (err) {
    // Preference lookup uncertainty must not become an unwanted native push.
    logger.warn(`[notifications] Customer preference lookup failed (${preferenceKey}): ${err.message}`);
    return false;
  }
}

async function existingCustomerNotification(customerId, dedupeKey, connection = db) {
  if (!dedupeKey) return null;
  return connection('notifications')
    .where({ recipient_type: 'customer', recipient_id: customerId })
    .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey])
    .first();
}

// No emojis in admin notification text (owner ruling 2026-07-30) — enforced
// centrally here so every call site (trigger registry, direct notifyAdmin,
// legacy alert strings, quoted customer text) is covered without a per-site
// sweep. Customer-facing notifications are untouched.
const { stripEmoji } = require('../utils/strip-emoji');

// Admin brevity guard (owner rulings 2026-09-28 and 2026-09-30): an admin
// BODY over this length is cut to one sentence rather than left to run on for
// a screen-length jargon dump — MAX_ADMIN_BODY_CHARS matches the scope doc's
// "one sentence, 110 characters or less" rule — and the full original moves to
// `detail`, so no text is lost. Live for EVERY admin category unless
// ADMIN_BODY_GUARD_ALL is killed (feature-gates.js adminBodyGuardAllLive);
// killed, only `ops_digest` (DIGEST_CATEGORY below) is cut and every other
// category is stored byte-for-byte and merely LOGGED when its body runs long.
// `detail` is read back in two places: the bell's "Show full text" on any
// non-digest row (client NotificationBell.jsx; the bell list endpoint returns
// the whole row) and the Agents → Activity feed for `ops_digest` rows
// (services/agent-activity.js). The TITLE is never cut for ANY category (see
// MAX_ADMIN_TITLE_CHARS) — several senders dedupe/refresh by an exact title
// lookup against the stored row (google-business.js's "Review sync health
// escalation [...]" signature marker and its per-location review-request
// title, voice-agent/relay-alert.js); a title this guard silently shortened
// would never match that probe again and the alert would re-ring on every run.
// ops-digest.js composes its OWN ≤60-char headline before this guard ever
// sees it, so that path is unaffected either way.
const DIGEST_CATEGORY = 'ops_digest'; // written by services/ops-digest.js and routes/ops-digest-ingest.js
const MAX_ADMIN_TITLE_CHARS = 80; // logged when exceeded; never enforced by cutting
const MAX_ADMIN_BODY_CHARS = 110; // enforced (cut into detail) for every admin category; ops_digest only when ADMIN_BODY_GUARD_ALL is killed

// Cuts `text` to at most `max` chars, breaking on the last word boundary
// inside the budget and appending an ellipsis — never mid-word, never over
// `max`. A string with no space inside the budget just hard-cuts (still
// never exceeds `max`).
function truncateAtWord(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  const ellipsis = '…';
  const budget = Math.max(max - ellipsis.length, 0);
  let cut = s.slice(0, budget);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > 0) cut = cut.slice(0, lastSpace);
  return `${cut.trimEnd()}${ellipsis}`;
}

// ADMIN_BODY_GUARD_ALL through its canonical reader, asked at call time. A
// reader that is missing or throws reads as LIVE: create() swallows its own
// errors and returns null, so a failed gate read here would silently drop the
// alert it was only meant to shorten.
function bodyGuardAllLive() {
  try {
    const reader = require('../config/feature-gates').adminBodyGuardAllLive;
    return typeof reader === 'function' ? reader() !== false : true;
  } catch {
    return true;
  }
}

// A multi-line list body ("Follow-ups overdue:\n• item\n• item") cuts at its
// first line break when that first line alone leaves room for the ellipsis;
// anything else (one long line) is a plain word-boundary cut.
function cutAdminBody(body) {
  const trimmed = body.trim();
  const firstLine = trimmed.split(/\r?\n/)[0].trim();
  if (firstLine.length < MAX_ADMIN_BODY_CHARS && firstLine.length < trimmed.length) {
    return `${firstLine.replace(/[\s:;,]+$/, '')}…`;
  }
  return truncateAtWord(body, MAX_ADMIN_BODY_CHARS);
}

// Admin-only: cuts an over-length BODY (see the block above for which
// categories) and moves the full original into `detail`. A caller-supplied
// detail is kept ALONGSIDE the full body (full body first), unless it already
// contains it verbatim. The TITLE is never cut for any category (see
// MAX_ADMIN_TITLE_CHARS above) — only logged, so an offender can be found
// without breaking a sender's own exact-title dedupe/refresh probe. Never logs
// title/body text — they carry customer names — only the category.
function applyAdminBrevityGuard({ category, title, body, detail }) {
  let nextBody = body;
  let nextDetail = detail || null;
  let trimmed = false;
  if (typeof title === 'string' && title.length > MAX_ADMIN_TITLE_CHARS) {
    logger.info(`[notifications] admin title over ${MAX_ADMIN_TITLE_CHARS} chars (${category || 'notification'})`);
  }
  if (typeof body === 'string' && body.length > MAX_ADMIN_BODY_CHARS) {
    const allLive = bodyGuardAllLive();
    if (category === DIGEST_CATEGORY || allLive) {
      nextBody = allLive ? cutAdminBody(body) : truncateAtWord(body, MAX_ADMIN_BODY_CHARS);
      nextDetail = nextDetail && nextDetail.includes(body)
        ? nextDetail
        : [body, nextDetail].filter(Boolean).join('\n\n');
      trimmed = true;
    } else {
      logger.info(`[notifications] admin body over ${MAX_ADMIN_BODY_CHARS} chars (${category || 'notification'})`);
    }
  }
  if (trimmed) logger.info(`[notifications] brevity guard trimmed admin ${category || 'notification'}`);
  return { title, body: nextBody, detail: nextDetail };
}

// Emoji-strip THEN brevity-cut, admin rows only — one function so create()
// and notifyAdmin's refresh comparison (which must judge "did the content
// change?" on the SAME normalized text) never drift apart.
function normalizeAdminNotificationText({ category, title, body, detail }) {
  const strippedTitle = stripEmoji(title) || title;
  const strippedBody = stripEmoji(body) || null;
  // `detail` is admin notification text too — the bell and the Activity feed
  // render it — so the no-emoji rule covers it like title/body (codex r2 P2
  // on #5236).
  const strippedDetail = stripEmoji(detail) || null;
  return applyAdminBrevityGuard({ category, title: strippedTitle, body: strippedBody, detail: strippedDetail });
}

// Bell-routing stamps an ops digest carries in metadata (ops-digest.js
// digestRowFields); a change to any of them is a real refresh.
const ROUTING_METADATA_KEYS = ['kind', 'audience', 'feed'];
// Ring-only-on-change stamps (admin-alerts-ring-v2 follow-up): a refresh
// confined to THESE fields — count/newCount growing, or itemKeys naming a
// different item — must still trigger the refresh and its ringOnRefresh
// evaluation, or a swapped item behind unchanged title/body/link never
// re-bells. Deliberately NOT folded into ROUTING_METADATA_KEYS: that list
// feeds the audience-flip check in mergeRefreshMetadata below, which has
// nothing to do with these.
const RING_METADATA_KEYS = ['count', 'newCount', 'itemKeys', 'itemSetHash'];

// Did this emission change anything a standing keyed row shows, routes by,
// or rings on?
function standingRowChanged(existing, { versionChanged, nextTitle, nextBody, nextLink, detailChanged, routingChanged, ringMetadataChanged }) {
  return versionChanged || existing.title !== nextTitle || existing.body !== nextBody
    || existing.link !== nextLink || detailChanged || routingChanged || ringMetadataChanged;
}

// notifyAdmin's refreshOnDedupe branch (admin-alerts-ring scope 2026-09-28):
// omitted `ringOnRefresh` defaults to true — byte-identical to the
// pre-existing "any content change re-bells" behavior.
async function resolveRingOnRefresh(ringOnRefresh, existing, existingMeta) {
  return typeof ringOnRefresh === 'function' ? ringOnRefresh(existing, existingMeta) : true;
}

// Not ringing: keep the row's current bell visibility — `feed`/`quiet` are
// dropped from this refresh's own metadata so existingMeta's values stand,
// while every other field still merges normally. EXCEPT an audience flip
// (owner<->engineering, codex r3 follow-up): that changes which surface the
// row belongs to at all, not merely whether it rings, so its `feed` (and
// whatever `quiet` this emission carries alongside it) always applies even
// on a quiet refresh — a FIX->ACT flip must never leave the owner's action
// hidden behind a stale feed:'activity'.
//
// Ringing: this refresh clears read_at, so it must also be visible — AND
// its own last-ring stamp advances (`rungAt`, admin-alerts-ring-v2
// follow-up: findPriorRungRow's 7-day baseline is measured from the last
// ring, not this row's original created_at). Two corrections on top of the
// straight `{...existingMeta, ...metadata}` merge, chosen by the MERGED
// audience (never a cached one — an audience flip lands in `metadata` above
// this call):
//   - owner, or no audience at all (the plain refreshOnDedupe shape most
//     callers outside ops-digest.js use, which never sets `audience`), and
//     the merged object still says quiet:true: a caller that precomputed
//     quiet from a different baseline (the ingest route's 7-day lookback
//     can find this very row) would otherwise ring a row hidden behind
//     feed:'activity' — clear both to restore the owner bell feed.
//     Already-false quiet is left alone (nothing to correct).
//   - a DEFINED non-owner audience (engineering/fyi): `quiet` never applies
//     to these rows at all — drop it outright rather than carry over a
//     stale `true` this row inherited from when it was still an owner row
//     (a FIX<->ACT flip under the SAME dedupeKey, gbp-sync-health). `feed`
//     is left exactly as this emission composed it ('activity', its own
//     value) — never forced.
function mergeRefreshMetadata(existingMeta, metadata, shouldRing) {
  if (shouldRing) {
    const merged = { ...existingMeta, ...metadata, rungAt: new Date().toISOString() };
    // A DEFINED non-owner audience only — a caller outside ops-digest.js
    // (most refreshOnDedupe dedupe rows) never sets `audience` at all, and
    // that absence must keep today's plain behavior, not read as "not
    // owner" and strip a `quiet` key those rows never gave meaning to.
    if (merged.audience && merged.audience !== 'owner') {
      const { quiet: _quiet, ...rest } = merged;
      return rest;
    }
    return merged.quiet === true ? { ...merged, quiet: false, feed: null } : merged;
  }
  // rungAt is a RING stamp — a caller may carry a precomputed value (the
  // ingest route's own fresh-insert metadata also feeds this merge on a
  // refresh), but only the shouldRing branch above may ever advance it.
  const { rungAt: _incomingRungAt, ...metadataNoRungAt } = metadata;
  const audienceFlipped = Object.prototype.hasOwnProperty.call(metadataNoRungAt, 'audience')
    && (existingMeta.audience ?? null) !== (metadataNoRungAt.audience ?? null);
  if (audienceFlipped) return { ...existingMeta, ...metadataNoRungAt };
  const { feed: _feed, quiet: _quiet, ...rest } = metadataNoRungAt;
  return { ...existingMeta, ...rest };
}

// notifyAdmin's no-dedupeKey path (admin-alerts-ring scope 2026-09-28):
// plain create(), unless the caller supplied `ringGate` — see notifyAdmin's
// own doc comment for the full contract. Pulled out of notifyAdmin to keep
// its own complexity down; `service` is `this` from the caller.
function createPlainAdmin(service, { category, title, body, createOpts, ringGate, callerTrx }) {
  if (typeof ringGate !== 'function') {
    return service.create({ recipientType: 'admin', category, title, body, ...createOpts, ...(callerTrx ? { connection: callerTrx } : {}) });
  }
  const gated = async (conn) => {
    const ring = await ringGate(conn);
    // A ring stamps its own rungAt (admin-alerts-ring-v2 follow-up):
    // findPriorRungRow's 7-day baseline reads this, not created_at, so a
    // later refresh of a DIFFERENT row can find this one as "the prior
    // ring" for its own window.
    const meta = ring
      ? { ...(createOpts.metadata || {}), rungAt: new Date().toISOString() }
      : { ...(createOpts.metadata || {}), quiet: true, feed: 'activity' };
    return service.create({ recipientType: 'admin', category, title, body, ...createOpts, metadata: meta, connection: conn });
  };
  return callerTrx ? gated(callerTrx) : db.transaction(gated);
}

const NotificationService = {
  scopeAdminFeedToRole,
  // The admin row text exactly as create() would persist it (emoji-stripped,
  // brevity-cut) — for a caller that rewrites a standing row
  // directly instead of through notifyAdmin (google-business.js's
  // same-signature digest refresh), so its stored text can't drift.
  normalizeAdminText: normalizeAdminNotificationText,
  // The `body` + `detail` columns for a direct rewrite of a standing admin row
  // (setup-fee reconcile, manual-billing alert refresh): the one-sentence body
  // and the full text, so the row's "Show full text" never keeps an obsolete
  // instruction. `detail` is null when the body fits — the rewrite clears it.
  adminBodyColumns(category, body) {
    const { body: nextBody, detail } = normalizeAdminNotificationText({ category, title: '', body });
    return { body: nextBody, detail };
  },
  // Create a notification.
  // `bell` (admin recipients only) is an explicit site-level policy tag:
  // true always rings, false never rings — see notification-bell-policy.js.
  // It only has effect while GATE_ADMIN_BELL_POLICY is on.
  async create({ recipientType, recipientId, category, title, body, detail, icon, link, metadata, bell, bellDefault, shouldContinue, connection = db }) {
    try {
      // Demo/internal test accounts (App Store review account) must not ring
      // the admin bell — their bounce alerts and junk service requests are
      // noise. Central gate: emitters carry the customer id in metadata,
      // either top-level or nested under a trigger payload (sms_reply uses
      // threadId = customer id). Push dispatch for triggers is separately
      // gated in notification-triggers.js.
      const metaCid = metadata?.customerId || metadata?.customer_id
        || metadata?.payload?.customerId || metadata?.payload?.customer_id
        || metadata?.payload?.threadId;
      if (recipientType === 'admin' && isInternalTestCustomerId(metaCid)) {
        logger.info(`[notifications] Suppressed admin notification for internal test customer (${category})`);
        // TRUTHY sentinel, not null: callers treat null as "insert failed"
        // (requests.js logs an ops error; the estimate-extension route
        // releases its claim and 500s). Intentional suppression must read
        // as success-without-a-row.
        return { id: null, suppressed: true };
      }
      // Admin bell policy (GATE_ADMIN_BELL_POLICY, default off): when the
      // gate is on, only allowlisted lanes ring the shared admin bell —
      // everything else is silenced HERE (no row) so every path through the
      // service is covered: direct notifyAdmin sites, the trigger registry
      // (its bell write lands here with metadata.triggerKey), and the
      // converted ex-raw-insert sites. Same truthy sentinel as the internal
      // test-customer gate above: intentional suppression must read as
      // success-without-a-row, never as an insert failure.
      if (recipientType === 'admin') {
        try {
          const bellPolicy = require('./notification-bell-policy');
          if (bellPolicy.isBellPolicyEnabled()) {
            const allowed = await bellPolicy.bellAllowed({
              category,
              triggerKey: metadata?.triggerKey || null,
              options: { bell, bellDefault },
            });
            if (!allowed) {
              // Category + triggerKey only — titles/bodies carry customer
              // names and addresses, which must not leak into logs.
              logger.info('[bell-policy] silenced', {
                category,
                triggerKey: metadata?.triggerKey || null,
              });
              return { id: null, suppressed: true, reason: 'bell_policy' };
            }
          }
        } catch (err) {
          // Policy failure must never break notifications — fall through
          // and insert (fail-open matches gate-off behavior).
          logger.warn(`[notifications] bell policy check failed: ${safeErrorSummary(err)}`);
        }
      }
      // A title that was ONLY emoji falls back to the original rather than
      // inserting an empty string.
      const isAdmin = recipientType === 'admin';
      // Admin brevity guard (owner ruling 2026-09-28): word-boundary cut
      // title/body, full body (+ caller detail) preserved in `detail`.
      // Customer-facing rows are untouched — no cut, no detail column use.
      const normalized = isAdmin
        ? normalizeAdminNotificationText({ category, title, body, detail })
        : { title, body: body || null, detail: detail || null };
      // The bell exposes the same copy as native push. Recheck after any
      // preference/property lookup and dedupe lock, before persisting it.
      if (typeof shouldContinue === 'function') {
        const verdict = await shouldContinue({ database: connection });
        const allowed = verdict === true || verdict?.ok === true;
        const hasDeadline = verdict && Object.prototype.hasOwnProperty.call(verdict, 'validUntil');
        const deadlineValid = !hasDeadline || (Number.isFinite(verdict.validUntil) && Date.now() < verdict.validUntil);
        const windowValid = typeof shouldContinue.isStillValid !== 'function' || shouldContinue.isStillValid() === true;
        if (!allowed || !deadlineValid || !windowValid) {
          return { id: null, suppressed: true, reason: 'pre_send_check_blocked' };
        }
      }
      const [notif] = await connection('notifications').insert({
        recipient_type: recipientType,
        recipient_id: recipientId || null,
        category,
        title: normalized.title,
        body: normalized.body,
        // Only rows that carry a detail write the column: customer rows and
        // short admin rows insert exactly the columns they did before it.
        ...(normalized.detail ? { detail: normalized.detail } : {}),
        icon: icon || getCategoryIcon(category),
        link: link || null,
        metadata: metadata ? JSON.stringify(metadata) : null,
      }).returning('*');
      return notif;
    } catch (err) {
      logger.error(`[notifications] Create failed: ${safeErrorSummary(err)}`);
      return null;
    }
  },

  // Create admin notification (no recipient_id needed)
  async notifyAdmin(category, title, body, opts = {}) {
    // Opt-in dedupe, mirroring notifyCustomer's mechanism (PR #3496 review
    // P1: replayed emitters — e.g. repeated recap edits re-detecting the
    // same stranded card hold — must not crowd the billing feed with
    // identical bells). Same advisory-lock + metadata dedupeKey shape so
    // both recipient types share one mechanism; no dedupeKey = unchanged
    // behavior for every existing caller. Fail closed: an unprovably-new
    // event skips the bell rather than risking a duplicate.
    // refreshOnDedupe (opt-in): when the keyed bell already exists and this
    // emission's CONTENT differs (a retried run whose failure set changed),
    // rewrite the standing row's title/body/link/metadata and surface it unread
    // again — the office must never keep reading an obsolete error list
    // while the response says the alert has the details. Identical content
    // stays a plain dedupe (no re-bell).
    // dedupeWindowMs (optional, with dedupeKey): a ROLLING window instead of
    // forever — the key dedupes only against rows younger than the window,
    // so a recurring signal (an estimate re-opened again tomorrow) can ring
    // again once the window passes while two opens inside it contend on the
    // same stable lock. One mechanism for every admin emitter (rule 15).
    // trx (optional, with dedupeKey OR ringGate): run the lock + probe +
    // insert on the CALLER's open transaction instead of one of our own, so
    // a caller that retires earlier rows and raises the replacement commits
    // both together (termite station retrieval: staff must never see the
    // old instruction unread beside the new one). Errors then PROPAGATE —
    // swallowing one inside a caller's transaction would leave it aborted
    // and doom the commit — so the caller owns containment.
    // ringOnRefresh (optional, with refreshOnDedupe; admin-alerts-ring scope
    // 2026-09-28): `(existingRow, existingMeta) => boolean` — when the
    // standing row's content changed, this decides whether the refresh also
    // re-bells it (read_at cleared) or only updates its content quietly
    // (read_at left as-is). Omitted, it defaults to true everywhere —
    // BYTE-IDENTICAL to today's "any content change re-bells" behavior. When
    // it returns false, the metadata merge below also drops `feed`/`quiet`
    // from the caller's own metadata so an already-rung-or-quiet row keeps
    // its current bell visibility — only a ringing refresh may flip it.
    // ringGate (optional; admin-alerts-ring scope 2026-09-28):
    // `(conn) => Promise<boolean>` — for a FRESH insert (a plain row, or a
    // keyed row whose dedupeKey found no standing row), decides whether
    // THIS insert rings: false rewrites the caller's own
    // `quiet`/`feed` to `true`/`'activity'` (only those two keys — every
    // other field the caller composed stands); true leaves the caller's
    // metadata untouched (its own default already assumes it rings). Runs
    // inside the SAME transaction as the insert (the caller's own `trx`
    // when given, else one this call opens) so the lookup a gate performs
    // and the row it gates can never observe each other's in-between state.
    const { dedupeKey, dedupeWindowMs, dedupeVersion, refreshOnDedupe = false, ringOnRefresh = null, ringGate = null, trx: callerTrx = null, relayFailureCall = null, ...createOpts } = opts;
    if (!dedupeKey) {
      return createPlainAdmin(this, { category, title, body, createOpts, ringGate, callerTrx });
    }
    const windowMs = Number(dedupeWindowMs);
    const metadata = { ...createOpts.metadata, dedupeKey, ...(dedupeVersion === undefined ? {} : { dedupeVersion }) };
    const dedupeAndInsert = async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`admin:${dedupeKey}`]);
        let existingQuery = trx('notifications')
          .where({ recipient_type: 'admin' })
          .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey]);
        if (Number.isFinite(windowMs) && windowMs > 0) {
          existingQuery = existingQuery.where('created_at', '>', trx.raw("NOW() - (? * interval '1 millisecond')", [Math.round(windowMs)]));
        }
        // Newest row first: a key with a rolling window (or a duplicate left by
        // an old race) can hold several rows, and the LATEST is the standing
        // one — never an arbitrary older row.
        const existing = await existingQuery.orderBy('created_at', 'desc').first();
        if (existing) {
          // Compared and stored in create()'s admin form (emoji-stripped +
          // brevity-cut), or a difference the guard itself introduces (an
          // emoji title, an over-length body) would read as "changed" on
          // every emission and re-bell for no real reason.
          const normalized = normalizeAdminNotificationText({ category, title, body, detail: createOpts.detail });
          const nextTitle = normalized.title;
          const nextBody = normalized.body;
          const nextDetail = normalized.detail;
          const nextLink = createOpts.link === undefined ? existing.link : createOpts.link || null;
          const existingMeta = typeof existing.metadata === 'string'
            ? (() => { try { return JSON.parse(existing.metadata); } catch { return {}; } })()
            : (existing.metadata || {});
          // A same-count backlog can contain new deadlines or reopened work.
          // Its optional version refreshes the one standing bell as well.
          const versionChanged = dedupeVersion !== undefined && existingMeta.dedupeVersion !== dedupeVersion;
          // A standing row stored BEFORE the guard cut this category holds the
          // whole text in `body` and no `detail`. The same text arriving again
          // is not news: without this, every such row would re-ring once on
          // the first emission after the guard went live.
          const storedUncut = !existing.detail && Boolean(nextDetail) && existing.body === nextDetail;
          // The mirror, after ADMIN_BODY_GUARD_ALL is killed: a row stored cut
          // (full text in `detail`) and the same whole text arriving uncut.
          // Only when the caller supplied no detail of its own, so the stored
          // detail can only be the guard's copy of that body.
          const storedCut = !createOpts.detail && Boolean(existing.detail) && !nextDetail && existing.detail === nextBody;
          const sameText = storedUncut || storedCut;
          const detailChanged = !sameText && (existing.detail || null) !== (nextDetail || null);
          // Routing metadata is content too: a FIX -> ACT flip with identical
          // text must still merge the new feed/kind/audience, or the owner's
          // action stays hidden behind a stale feed:'activity' (codex r3 P0 on
          // #5236). Only keys this emission actually carries are compared.
          const routingChanged = ROUTING_METADATA_KEYS.some((k) => Object.prototype.hasOwnProperty.call(metadata, k)
            && (existingMeta[k] ?? null) !== (metadata[k] ?? null));
          // Ring-only-on-change stamps are content too (admin-alerts-ring-v2
          // follow-up): count/newCount growing, or itemKeys naming a
          // different item, must trigger the refresh (and ringOnRefresh's
          // evaluation) even when title/body/link/routing are unchanged.
          // Compared by JSON so an itemKeys array compares by value.
          const ringMetadataChanged = RING_METADATA_KEYS.some((k) => Object.prototype.hasOwnProperty.call(metadata, k)
            && JSON.stringify(existingMeta[k] ?? null) !== JSON.stringify(metadata[k] ?? null));
          if (refreshOnDedupe && standingRowChanged(existing, { versionChanged, nextTitle, nextBody: sameText ? existing.body : nextBody, nextLink, detailChanged, routingChanged, ringMetadataChanged })) {
            // A row that newly enters the owner audience (engineering/fyi ->
            // owner) is news to the owner even at an equal count: it may
            // have been read in Activity, so it must ring into the bell.
            const enteredOwner = metadata.audience === 'owner' && Boolean(existingMeta.audience) && existingMeta.audience !== 'owner';
            const shouldRing = enteredOwner || await resolveRingOnRefresh(ringOnRefresh, existing, existingMeta);
            const mergedMetadata = mergeRefreshMetadata(existingMeta, metadata, shouldRing);
            const refreshed = { title: nextTitle, body: nextBody, ...(detailChanged || sameText ? { detail: nextDetail } : {}), link: nextLink,
              metadata: JSON.stringify(mergedMetadata), ...(shouldRing ? { read_at: null } : {}) };
            await trx('notifications').where({ id: existing.id }).update(refreshed);
            return { notification: { ...existing, ...refreshed, metadata: mergedMetadata }, deduped: true, refreshed: true, rung: shouldRing };
          }
          return { notification: existing, deduped: true };
        }
        // A fresh keyed insert takes the same ring gate as a plain one.
        const created = await createPlainAdmin(this, {
          category, title, body, createOpts: { ...createOpts, metadata }, ringGate, callerTrx: trx,
        });
        // create() returns null on an insert failure (PR #3496 review P1):
        // spreading that null would report {deduped:false} as if a row
        // landed. Throw inside the transaction so the failure surfaces as
        // the null return below, never as success.
        if (!created) throw new Error('admin notification insert failed');
        return { notification: created, deduped: false };
    };
    const shape = (persisted) => ({ ...persisted.notification, deduped: persisted.deduped, ...(persisted.refreshed ? { refreshed: true, rung: persisted.rung } : {}) });
    if (callerTrx) return shape(await dedupeAndInsert(callerTrx));
    try {
      let callbackStamp;
      const persisted = await db.transaction(async (trx) => {
        if (!relayFailureCall) return dedupeAndInsert(trx);
        // Extend the existing notification transaction: shared callback claims
        // are final delivery evidence, never a durable pending lease. Holding
        // the call row also fences session takeover until the bell commits.
        await trx.raw("SET LOCAL statement_timeout = '3s'");
        await trx.raw("SET LOCAL idle_in_transaction_session_timeout = '5s'");
        const call = await trx('call_log').where('twilio_call_sid', relayFailureCall.callSid).forUpdate().first('id', 'metadata', 'voicemail_callback_alerted_at');
        let meta = call?.metadata;
        if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
        if (!call || call.voicemail_callback_alerted_at || ((meta?.relay_session_claim_owner ?? null) !== relayFailureCall.owner)) {
          return { notification: { suppressed: true }, deduped: true };
        }
        if (relayFailureCall.isActive?.() === false) throw new Error('relay callback cancelled');
        const persisted = await dedupeAndInsert(trx);
        if (!persisted.notification.suppressed) {
          const [stamped] = await trx('call_log').where('id', call.id).update({
            voicemail_callback_alerted_at: trx.fn.now(),
            metadata: trx.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('relay_failure_callback_filed_at', now()::text)"),
          }).returning('metadata');
          callbackStamp = stamped.metadata.relay_failure_callback_filed_at;
        }
        if (relayFailureCall.isActive?.() === false) throw new Error('relay callback cancelled');
        return persisted;
      });
      const receipt = callbackStamp && !persisted.deduped ? {
        callSid: relayFailureCall.callSid, callbackStamp, notificationId: persisted.notification.id,
      } : null;
      // The same conditional compensation handles close during COMMIT and an
      // end-frame failure after the bell result reaches the conversation.
      if (receipt && relayFailureCall.isActive?.() === false) {
        await this.revertRelayFailureCallback(receipt);
        return null;
      }
      if (receipt) relayFailureCall.onCommitted?.(receipt);
      return shape(persisted);
    } catch (err) {
      logger.warn(`[notifications] Admin notification dedupe failed: ${safeErrorSummary(err)}`);
      return null;
    }
  },

  async revertRelayFailureCallback({ callSid, callbackStamp, notificationId }) {
    return db.transaction(async (trx) => {
      // The conversation bounds its own wait. Let this detached compensation
      // finish after a transient row lock rather than abandoning its receipt.
      await trx.raw("SET LOCAL idle_in_transaction_session_timeout = '5s'");
      const call = await trx('call_log').where('twilio_call_sid', callSid).forUpdate().first('id');
      if (!call) return;
      const cleared = await trx('call_log').where('id', call.id)
        .whereRaw("metadata->>'relay_failure_callback_filed_at' = ?", [callbackStamp])
        .update({ voicemail_callback_alerted_at: null, metadata: trx.raw("metadata - 'relay_failure_callback_filed_at'") });
      if (cleared) await trx('notifications').where('id', notificationId).delete();
    });
  },

  // Create customer notification
  async notifyCustomer(customerId, category, title, body, opts = {}) {
    const { preferenceKey, dedupeKey, push = true, awaitPush = false, pushOptions = {}, ...createOptsRaw } = opts;

    // The visit this notification is about (same sources as the deep-link
    // qualifier below): its saved property may own the toggle.
    const preferenceVisitId = createOptsRaw.appointmentId
      || (createOptsRaw.metadata && typeof createOptsRaw.metadata === 'object'
        ? (createOptsRaw.metadata.appointmentId || createOptsRaw.metadata.scheduledServiceId) : null)
      || null;
    if (!(await customerPreferenceEnabled(customerId, preferenceKey, { scheduledServiceId: preferenceVisitId }))) {
      return { id: null, suppressed: true, reason: 'preference_disabled' };
    }

    // Saved-property destination (GATE_APP_PROPERTY_SCOPE, uncapped codex r1t
    // + r1u P1). The visit this notification is about: createOpts.appointmentId,
    // or the emitters' metadata.appointmentId / metadata.scheduledServiceId
    // (the en-route and completed bells). A notification ABOUT A VISIT stores
    // a profile-qualified link — plus the house when the visit is stamped
    // (resolved by the push sink's resolver) — so the same reminder opened
    // from the bell lands where the push does: an unstamped visit belongs to
    // the profile's PRIMARY, which the app's profile-only rule selects. Gate
    // off: nothing is qualified or forwarded — today's link and payload,
    // byte for byte. No visit, no house: untouched.
    const PushService = require('./push-notifications');
    const scopeOn = require('./account-properties').appPropertyScopeEnabled();
    const visitId = scopeOn ? preferenceVisitId : null;
    // Nothing to resolve for a notification about no visit and no house (a
    // receipt, a document): no lookup at all.
    const notifiedPropertyId = scopeOn && (visitId || createOptsRaw.propertyId)
      ? await PushService.resolveNotificationPropertyId(customerId, { propertyId: createOptsRaw.propertyId, appointmentId: visitId })
      : null;
    const createOpts = scopeOn && (visitId || notifiedPropertyId)
      ? {
        ...createOptsRaw,
        ...(visitId ? { appointmentId: visitId } : {}),
        ...(createOptsRaw.link ? { link: qualifyNotificationLink(createOptsRaw.link, customerId, notifiedPropertyId) } : {}),
      }
      : createOptsRaw;

    const metadata = {
      ...createOpts.metadata,
      ...(dedupeKey ? { dedupeKey } : {}),
    };
    const createArgs = {
      recipientType: 'customer',
      recipientId: customerId,
      category,
      title,
      body,
      ...createOpts,
      metadata,
      shouldContinue: pushOptions.shouldContinue,
    };

    let notification;
    let deduped = false;
    if (dedupeKey) {
      try {
        const persisted = await db.transaction(async (trx) => {
          // Serialize this customer's event key across pods. The lock lives
          // only for the transaction; the provider call happens after commit.
          await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`${customerId}:${dedupeKey}`]);
          const existing = await existingCustomerNotification(customerId, dedupeKey, trx);
          if (existing) return { notification: existing, deduped: true };
          return {
            notification: await this.create({ ...createArgs, connection: trx }),
            deduped: false,
          };
        });
        deduped = persisted.deduped;
        notification = persisted.notification;
      } catch (err) {
        // A failed lock/read cannot safely prove this event is new. Fail closed
        // instead of risking a duplicate bell + native push.
        logger.warn(`[notifications] Customer notification dedupe failed: ${safeErrorSummary(err)}`);
        return null;
      }
    } else {
      notification = await this.create(createArgs);
    }
    if (!notification || notification.suppressed) return notification;

    if (!push || (deduped && !awaitPush)) return { ...notification, deduped, push: null };
    // An event key identifies the committed bell's copy. In particular, a
    // retry after a lost commit acknowledgement must not send a new quote
    // natively while reusing the earlier bell or its provider acceptance.
    if (deduped && ['category', 'title', 'body', 'link']
      .some((field) => (notification[field] || null) !== (createArgs[field] || null))) {
      return { ...notification, deduped, push: {
        queued: false, accepted: 0, reason: 'dedupe_payload_changed',
      } };
    }
    let pushQueued = false;
    try {
      const dispatch = PushService.sendToCustomer(customerId, {
        title,
        body: body || '',
        url: createOpts.link || '/',
        category,
        notificationId: String(notification.id),
        tag: dedupeKey || `customer-notification:${notification.id}`,
        ...(pushOptions.ephemeral ? { ephemeral: true } : {}),
        // Saved-property destination (GATE_APP_PROPERTY_SCOPE): the visit or
        // the house this notification is about, for the push sink's link.
        ...(createOpts.appointmentId ? { appointmentId: createOpts.appointmentId } : {}),
        ...(createOpts.propertyId ? { propertyId: createOpts.propertyId } : {}),
      }, { ...pushOptions, ...(dedupeKey ? { notificationId: notification.id } : {}) });
      pushQueued = true;
      // Scheduled advisories can record provider acceptance separately from
      // bell creation. Request-path callers retain the asynchronous dispatch.
      if (awaitPush) {
        const outcome = await dispatch;
        return { ...notification, deduped, push: {
          queued: true,
          subscriptions: outcome.subscriptions,
          accepted: outcome.sent,
          failed: outcome.failed,
          expired: outcome.expired,
          skipped: outcome.skipped,
          ...(outcome.retryable ? { retryable: outcome.retryable, retryAfterMs: outcome.retryAfterMs } : {}),
          ...(outcome.reason ? { reason: outcome.reason } : {}),
          ...(outcome.deduped ? { deduped: true, acceptedAt: outcome.acceptedAt } : {}),
        } };
      }
      // The bell is already durable, and request paths such as status changes
      // and estimate acceptance must not wait on external push providers.
      void Promise.resolve(dispatch).catch((err) => {
        logger.warn(`[notifications] Customer push dispatch failed: ${err.message}`);
      });
    } catch (err) {
      // Preserve the successful bell even if dispatch fails synchronously.
      logger.warn(`[notifications] Customer push dispatch failed: ${err.message}`);
    }
    return { ...notification, deduped, push: { queued: pushQueued, ...(awaitPush ? { error: 'dispatch_failed' } : {}) } };
  },

  // Get notifications for admin
  async getAdminNotifications(limit = 50, offset = 0, { role } = {}) {
    return excludeActivityOnlyFromBell(scopeAdminFeedToRole(
      db('notifications').where({ recipient_type: 'admin' }),
      role,
    ))
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit).offset(offset);
  },

  // Get unread count for admin
  // trx (optional): run on an existing transaction's connection — the
  // badge ordering section (admin-unread.js) computes counts inside its
  // advisory-lock transaction and must not borrow a second pool
  // connection while holding one.
  async getAdminUnreadCount({ role } = {}, trx = null) {
    const [{ count }] = await excludeActivityOnlyFromBell(scopeAdminFeedToRole(
      (trx || db)('notifications').where({ recipient_type: 'admin' }),
      role,
    ))
      .whereNull('read_at')
      .count('* as count');
    return parseInt(count);
  },

  // Get notifications for a customer
  async getCustomerNotifications(customerId, limit = 50, offset = 0) {
    return db('notifications')
      .where({ recipient_type: 'customer', recipient_id: customerId })
      .orderBy('created_at', 'desc')
      .limit(limit).offset(offset);
  },

  // Get unread count for customer
  async getCustomerUnreadCount(customerId) {
    const [{ count }] = await db('notifications')
      .where({ recipient_type: 'customer', recipient_id: customerId })
      .whereNull('read_at')
      .count('* as count');
    return parseInt(count);
  },

  // Mark as read
  async markRead(notificationId, customerId = null) {
    let q = db('notifications').where({ id: notificationId });
    if (customerId) q = q.where({ recipient_type: 'customer', recipient_id: customerId });
    const updated = await q.update({ read_at: new Date() });
    return updated > 0;
  },

  // Mark a single admin notification read — scoped to recipient_type 'admin' so
  // the admin endpoint can't clear a customer's notification by supplying its id
  // (admin notifications are the shared admin queue; customer rows are off-limits).
  async markReadAdmin(notificationId, { role } = {}) {
    // Same role predicate as the reads: a technician must not be able to
    // mark a hidden adminRoleOnly row read before the owner sees it.
    const updated = await scopeAdminFeedToRole(
      db('notifications').where({ id: notificationId, recipient_type: 'admin' }),
      role,
    ).update({ read_at: new Date() });
    return updated > 0;
  },

  // Mark all read for admin
  async markAllReadAdmin({ role } = {}) {
    await excludeActivityOnlyFromBell(scopeAdminFeedToRole(
      db('notifications').where({ recipient_type: 'admin' }),
      role,
    )).whereNull('read_at').update({ read_at: new Date() });
  },

  // Mark a customer's inbound_sms admin bells read — the ONE writer for
  // thread-scoped bell reads (thread open in Communications, and the webhook's
  // "thread was read while the bell was being written" post-check). Same
  // recipient/role scoping as every other admin read. `before` bounds to bells
  // that existed when the read request entered; `twilioSid` narrows to the
  // single bell written for one inbound message.
  // Retires inbound_sms bells. By customer (the thread deep-link) and/or
  // by the message SID(s) the bell was written for — an unknown-sender
  // bell has no customer, so the SID is its only handle (codex #4210 P2).
  async markInboundSmsReadAdmin({ customerId, before = new Date(), twilioSid = null, twilioSids = null, role } = {}) {
    const sids = [...(twilioSids || []), ...(twilioSid ? [twilioSid] : [])].filter(Boolean);
    if (!customerId && !sids.length) return 0;
    let q = scopeAdminFeedToRole(
      db('notifications').where({ recipient_type: 'admin', category: 'inbound_sms' }),
      role,
    )
      .whereNull('read_at')
      .where('created_at', '<=', before);
    if (customerId) q = q.where('link', `/admin/communications?thread=${customerId}`);
    if (sids.length) q = q.whereRaw("metadata->'payload'->>'twilioSid' = ANY(?)", [sids]);
    return q.update({ read_at: new Date() });
  },

  // Applicant-reply bells for one application, once the owner has opened
  // it in Recruiting (PR #4623 r20): read up to the snapshot they saw.
  // `replyId` narrows the clear to ONE reply's bell (the post-write check in
  // recruiting-inbound.js retires a bell whose reply was already read).
  async markApplicantRepliesReadAdmin({ applicationId, replyId = null, replyIds = null, before = new Date(), role } = {}) {
    if (!applicationId) return 0;
    if (Array.isArray(replyIds) && !replyIds.length) return 0;
    let q = scopeAdminFeedToRole(
      db('notifications').where({ recipient_type: 'admin', category: 'job_application' }),
      role,
    )
      .whereRaw("COALESCE(metadata->>'triggerKey', '') = 'job_applicant_reply'")
      .whereRaw("metadata->'payload'->>'applicationId' = ?", [String(applicationId)])
      .whereNull('read_at')
      .where('created_at', '<=', before);
    if (replyId) q = q.whereRaw("metadata->'payload'->>'replyId' = ?", [String(replyId)]);
    // Bound to the replies the reader actually saw (Codex #4623 r29 P1).
    if (Array.isArray(replyIds)) q = q.whereRaw("metadata->'payload'->>'replyId' = ANY (?::text[])", [replyIds.map(String)]);
    return q.update({ read_at: new Date() });
  },

  // Retire superseded call alerts without crossing triggers: voicemail
  // supersedes a missed call; a booking supersedes a repeat-caller alert.
  // System writer (no role scoping): every admin copy is retired.
  async supersedeMissedCallAdmin({ callLogId, callSid, triggerKey = 'customer_missed_call' } = {}) {
    if (!callLogId && callSid) {
      const row = await db('call_log').where('twilio_call_sid', callSid).first('id');
      callLogId = row?.id || null;
    }
    if (!callLogId) return 0;
    // Both triggers share the category; the caller must name which event
    // became obsolete so voicemail and booking cannot retire each other's bell.
    return db('notifications')
      .where({ recipient_type: 'admin', category: 'missed_call' })
      .whereRaw("metadata->>'triggerKey' = ?", [triggerKey])
      .whereNull('read_at')
      .whereRaw("metadata->'payload'->>'callLogId' = ?", [String(callLogId)])
      .update({ read_at: new Date() });
  },

  // Mark all read for customer
  async markAllReadCustomer(customerId) {
    await db('notifications').where({ recipient_type: 'customer', recipient_id: customerId }).whereNull('read_at').update({ read_at: new Date() });
  },
};

function getCategoryIcon(category) {
  const icons = {
    inbound_sms: '\u{1F4AC}', approval: '\u2705', new_lead: '\u{1F514}', estimate: '\u{1F4CB}',
    payment: '\u{1F4B0}', review: '\u2B50', schedule: '\u{1F4C5}', churn_risk: '\u26A0\uFE0F',
    token_alert: '\u{1F511}', system: '\u{1F527}',
    knowledge: '\u{1F4DA}',
    service: '\u{1F3E0}', appointment: '\u{1F4C5}', billing: '\u{1F4B3}', document: '\u{1F4C4}',
    lawn_health: '\u{1F331}', referral: '\u{1F381}', account: '\u{1F464}',
    visit_prep_photos: '\u{1F4F7}',
  };
  return icons[category] || '\u{1F514}';
}

module.exports = NotificationService;
module.exports.safeErrorSummary = safeErrorSummary;
module.exports._private = {
  CUSTOMER_PREFERENCE_KEYS,
  customerPreferenceEnabled,
  existingCustomerNotification,
  truncateAtWord,
  applyAdminBrevityGuard,
  normalizeAdminNotificationText,
  excludeActivityOnlyFromBell,
  MAX_ADMIN_TITLE_CHARS,
  MAX_ADMIN_BODY_CHARS,
  DIGEST_CATEGORY,
};
