// Owner-facing ops digests: one delivery seam for the FIX:/ACT:/FIRST:
// watcher and digest emails that go to contact@.
//
// GATE_OPS_DIGESTS_IN_APP off (default): the sender's own mailer call runs
// exactly as before — recipient guard, dedupe marker and error handling all
// stay in the sender. On: the digest is recorded as an admin bell row
// (category ops_digest, which the Agents → Activity feed lists) and the
// email is skipped. If the row cannot be written the email still goes out,
// so a digest is never lost to a DB hiccup.
//
// Senders keep their email preflight (mailer configured, internal
// recipient) in front of this call in BOTH modes: the email path is the
// fallback when the bell row cannot be written, so a mis-set recipient env
// must fail closed before anything can be sent (pre-push P0). In-app mode
// therefore inherits the same prerequisites as email — no digest is
// delivered anywhere while the mailer or recipient is misconfigured, which
// is exactly today's behavior.
//
// Deliberately NOT routed here (they keep emailing regardless of the gate):
// the two reply-to-approve flows (newsletter proof, content email approvals)
// and the stripe-webhook-health FIX alert (payments pipeline down).
// llm-dispatch-metrics routes normal exceptions here with email fallback;
// recorder/database outages send SMTP directly. Customer-facing mail never
// touches this module.

const logger = require('./logger');
const crypto = require('node:crypto');

// Resolved at CALL time, not load time: this module is required by fifteen
// senders, several of which are loaded before their suites set gate env
// vars — a load-time require of feature-gates would freeze every gate
// early (bit google-business-sync.test.js). Same for the bell service.
function featureGates() {
  return require('../config/feature-gates');
}
function notificationService() {
  return require('./notification-service');
}

const CATEGORY = 'ops_digest';
const MAX_TITLE_CHARS = 200; // notifications.title is varchar(200); body is text (uncapped)

// Admin-alerts-brevity scope (owner ruling 2026-09-28): the bell shows a
// short headline + one-sentence summary; the WHOLE finding moves to
// `detail`. `kind` is derived from the subject's action-grammar prefix
// (ACT:/FIX:/FIRST:/FYI:/OK:/[Review] — the same grammar agent-activity.js's
// digestItem already reads) so senders that haven't been converted to pass
// an explicit `headline`/`summary` still get a sane title and audience.
const SUBJECT_PREFIX_RE = /^(ACT:|FIX:|FIRST:|FYI:|OK:|\[Review\])\s*/i;
const MAX_HEADLINE_CHARS = 60;

function deriveKind(subject) {
  const s = String(subject || '');
  if (/^ACT:/i.test(s)) return 'ACT';
  if (/^FIX:/i.test(s)) return 'FIX';
  if (/^\[Review\]/i.test(s)) return 'REVIEW';
  return 'FYI'; // FIRST:/FYI:/OK:/no prefix at all
}

// ACT and [Review] need the owner's decision; FIX is broken plumbing for an
// engineer; everything else is informational. The sender can override.
function defaultAudienceFor(kind) {
  if (kind === 'ACT' || kind === 'REVIEW') return 'owner';
  if (kind === 'FIX') return 'engineering';
  return 'fyi';
}

// Same word-boundary cut as notification-service.js's admin brevity guard
// (duplicated on purpose: this module lazy-requires notification-service at
// CALL time to dodge a require cycle, and the cut is one line).
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

// The bell title when a sender hasn't composed its own headline yet: strip
// the action-grammar prefix and cut to the same 60-char headline budget.
function fallbackHeadline(subject) {
  return truncateAtWord(String(subject || '').replace(SUBJECT_PREFIX_RE, '').trim(), MAX_HEADLINE_CHARS);
}
// The bell-row shape every ops_digest writer persists: the short title, an
// optional one-line body, the whole finding in `detail` (with the email
// skipped it is the only copy), and the kind/audience/feed stamps.
// deliverOpsDigest and google-business.js's same-signature refresh both build
// from here, so a direct rewrite of a standing digest can't drift from the
// seam (codex r2 P1 on #5236). Subjects carry aggregated text (customer
// names, bucket lists); the full subject stays in metadata, never the title.
function digestRowFields({ subject, text = null, html = null, headline = null, summary = null, audience = null }) {
  const kind = deriveKind(subject);
  const resolvedAudience = audience || defaultAudienceFor(kind);
  return {
    title: String(headline || fallbackHeadline(subject)).slice(0, MAX_TITLE_CHARS),
    body: summary ? String(summary) : null,
    detail: String(text || htmlToText(html) || ''),
    kind,
    audience: resolvedAudience,
    feed: resolvedAudience === 'owner' ? null : 'activity',
  };
}

// Ring-only-on-change (admin-alerts-ring scope, owner ruling 2026-09-28,
// "ring only when something changed"): a standing check must update quietly
// and ring the bell again only when something new appears or the count
// grows. A quiet row still lands in the Activity feed (metadata.feed =
// 'activity', metadata.quiet = true) — excludeActivityOnlyFromBell already
// keeps it out of the bell list/unread count/read-all, so this reuses that
// one filter instead of adding a second one.
//
// Alert class: the identity the ring decision groups findings by.
//   - In-process senders (this module's own `key` param): the class IS the
//     key, verbatim — one class per sender already.
//   - Ops-crons ingest keys carry the check id plus a generated finding-key
//     suffix (dates, hex/uuid hashes, underscore/dot-joined id lists, bare
//     numbers) that make every run's key unique on its own. The class strips
//     that suffix from the END of the finding key ONLY (never the check id
//     before the first ':'), one trailing separator+token at a time, while
//     the token is entirely hex digits (0-9a-f — a superset that covers a
//     plain decimal number too, and a YYYY-MM-DD date reduces to three such
//     tokens in a row). A token that isn't hex-only — a gate NAME like
//     GATE_SCHEDULING_CAPACITY — stops the trim, so identity embedded in the
//     middle of a key survives.
const TRAILING_VARIABLE_TOKEN_RE = /[-_.]([0-9a-f]+)$/i;
function trimVariableTail(s) {
  let next = s;
  let m;
  while ((m = TRAILING_VARIABLE_TOKEN_RE.exec(next))) {
    next = next.slice(0, next.length - m[0].length);
  }
  return next;
}
function alertClassFor(key, source) {
  const k = String(key || '');
  if (source !== 'ops-crons') return k;
  const i = k.indexOf(':');
  if (i === -1) return trimVariableTail(k);
  return k.slice(0, i + 1) + trimVariableTail(k.slice(i + 1));
}

// The new-news test (owner audience only): ring when the caller reports
// newCount>0, or its count is higher than the comparison point's — or that
// point has no count at all (a sender that only started reporting counts
// after PR 2, or a comparison row from before it).
function ringDecision({ newCount, count, priorCount }) {
  if (Number(newCount) > 0) return true;
  if (count === undefined || count === null) return false;
  return priorCount === undefined || priorCount === null || Number(count) > Number(priorCount);
}

function parseMeta(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

function metaCount(meta) {
  const c = meta ? meta.count : undefined;
  return c === undefined || c === null ? null : Number(c);
}

const NEWS_WINDOW = `7 days`;

// The most recent RUNG (not quiet, not resolved) row of the same alert class
// and source scope, within the last 7 days — the comparison point for a
// fresh insert (no existing dedupe row to refresh). Ops-crons rows scope on
// metadata.source = 'ops-crons'; in-process rows (source null) scope on no
// source at all. Rows written before this scope have no alertClass: an
// in-process row (source null) falls back to matching by its stable opsKey
// (`key`); an ops-crons legacy row is NOT matched this way — its raw key was
// one-shot anyway, so the first post-deploy row for that check just rings
// once, which is acceptable (owner ruling).
async function findPriorRungRow(conn, { alertClass, source, key }) {
  let q = conn('notifications')
    .where({ recipient_type: 'admin', category: CATEGORY })
    .whereRaw("COALESCE(metadata->>'resolved', '') <> 'true'")
    .whereRaw("COALESCE(metadata->>'quiet', '') <> 'true'")
    .where('created_at', '>', conn.raw(`NOW() - interval '${NEWS_WINDOW}'`));
  q = source === null
    ? q.whereRaw("metadata->>'source' IS NULL")
    : q.whereRaw("metadata->>'source' = ?", [String(source)]);
  q = q.where((m) => {
    m.whereRaw("metadata->>'alertClass' = ?", [alertClass]);
    if (source === null && key) {
      m.orWhere((legacy) => legacy.whereRaw("metadata->>'alertClass' IS NULL").whereRaw("metadata->>'opsKey' = ?", [key]));
    }
  });
  return q.orderBy('created_at', 'desc').first('metadata');
}

// Ring decision for a row about to be INSERTED fresh (no standing dedupe row
// to refresh) — the comparison point is the most recent matching row found
// above, not the specific row a dedupeKey would find (there may be none).
async function decideRingForNewRow(conn, { alertClass, source, key, count, newCount }) {
  const prior = await findPriorRungRow(conn, { alertClass, source, key });
  if (!prior) return true;
  return ringDecision({ newCount, count, priorCount: metaCount(parseMeta(prior.metadata)) });
}

// notifyAdmin's `ringOnRefresh` contract (PR 2): evaluated against the
// EXISTING standing row a dedupeKey found, so a refresh only re-bells on
// genuine new news — a resolved standing row (should not normally happen:
// resolveOpsDigest drops the dedupeKey on resolve) also rings, for safety.
function ringOnRefreshFrom({ count, newCount }) {
  return (existingRow, existingMeta) => {
    if (existingMeta?.resolved === true) return true;
    return ringDecision({ newCount, count, priorCount: metaCount(existingMeta) });
  };
}

// deliverOpsDigest's notifyAdmin options for the two ring-only-on-change
// mechanisms — see deliverOpsDigest's own comment for which sender shape
// uses which. OWNER AUDIENCE ONLY (spec item 3): an engineering/fyi row is
// never gated (no ringGate) and never given ringOnRefresh, so notifyAdmin's
// own default applies to its refresh — any content change re-bells, exactly
// as before this scope (llm-dispatch-metrics; owned-url-health's FIX
// variant). Audience is read from THIS call's own `resolvedAudience`, so a
// sender whose kind flips between runs (gbp-sync-health FIX<->ACT) is always
// gated by the CURRENT emission's audience, never a cached one. Pulled out
// to keep deliverOpsDigest's own complexity down.
function ringOptionsFor({ dedupeKey, dedupeWindowMs, refreshOnDedupe, resolvedAudience, alertClass, key, count, newCount }) {
  const ownerAudience = resolvedAudience === 'owner';
  if (dedupeKey) {
    return {
      dedupeKey,
      ...(dedupeWindowMs ? { dedupeWindowMs } : {}),
      ...(refreshOnDedupe ? {
        refreshOnDedupe: true,
        ...(ownerAudience ? { ringOnRefresh: ringOnRefreshFrom({ count, newCount }) } : {}),
      } : {}),
    };
  }
  if (!ownerAudience) return {};
  return { ringGate: (conn) => decideRingForNewRow(conn, { alertClass, source: null, key, count, newCount }) };
}

// system_settings.key is varchar(100); a full SHA-256 digest keeps even the
// longest allowed source/key pair within it, without sharing a watermark.
function cleanWatermarkKey(lockKey) {
  return `ops_digest.clean.${crypto.createHash('sha256').update(String(lockKey)).digest('hex')}`;
}

async function readCleanWatermark(conn, lockKey) {
  const row = await conn('system_settings').where({ key: cleanWatermarkKey(lockKey) }).first('value');
  if (!row) return null;
  if (typeof row.value !== 'string' || !row.value) throw new Error('invalid ops digest clean watermark');
  const time = new Date(row.value);
  if (!Number.isFinite(time.getTime())) throw new Error('invalid ops digest clean watermark');
  return time.toISOString();
}

async function recordCleanWatermark(conn, lockKey, observedAt) {
  const time = new Date(observedAt);
  if (!Number.isFinite(time.getTime())) throw new Error('invalid ops digest clean observation');
  const next = time.toISOString();
  const prior = await readCleanWatermark(conn, lockKey);
  if (prior && Date.parse(prior) >= Date.parse(next)) return prior;
  await conn('system_settings')
    .insert({ key: cleanWatermarkKey(lockKey), value: next, category: CATEGORY })
    .onConflict('key').merge({ value: next, updated_at: new Date() });
  return next;
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// sendOne resolves void on success and throws on failure; email.js send
// resolves { ok, error? }. Normalize so callers keep reading .ok / .error.
function emailOutcome(result) {
  const failed = !!result && result.ok === false;
  return { ok: !failed, channel: 'email', result, ...(failed ? { error: result.error || 'send failed' } : {}) };
}

// gateEnvValue at CALL time (techTips idiom): the gates object is evaluated
// once at boot, so isEnabled() would freeze the kill switch until a redeploy.
// Guarded like admin-dispatch's techTips read: several sender suites mock
// feature-gates with a partial object, and a missing gateEnvValue must read
// as "off" (email path), never throw inside a digest send.
// Requires BOTH gates: the digest only has a surface when the Activity feed
// is on, so with GATE_AGENT_ACTIVITY off this fails closed to email.
function inAppEnabled() {
  const gates = featureGates();
  if (typeof gates.gateEnvValue !== 'function') return false;
  return gates.gateEnvValue('GATE_OPS_DIGESTS_IN_APP') === true && gates.gateEnvValue('GATE_AGENT_ACTIVITY') === true;
}

/**
 * @param {object} p
 * @param {string} p.key        stable sender key, e.g. 'unworked-comms'
 * @param {string} p.subject    the email subject (becomes the bell title)
 * @param {string} [p.text]     plain-text body; derived from html when absent
 * @param {string} [p.html]
 * @param {string} [p.link]     admin route the digest points at
 * @param {object} [p.metadata]
 * @param {string} [p.headline]  bell title, 60 chars or less, `<Area> — <what needs doing>`.
 *                               Falls back to the subject with its ACT:/FIX:/etc. prefix
 *                               stripped, cut to 60 chars at a word boundary.
 * @param {string} [p.summary]   bell body, one sentence, 110 chars or less. Omitted → no
 *                               second line (never the whole email — that's `detail`).
 * @param {'owner'|'engineering'|'fyi'} [p.audience]  who this is for. Default is derived
 *                               from the subject's kind (ACT/[Review] → owner, FIX →
 *                               engineering, else fyi); a non-owner audience is
 *                               Activity-only (metadata.feed = 'activity', never the bell).
 * @param {number} [p.count]     the headline number this finding reports (its backlog
 *                               size, its list length, …) — the ring-only-on-change test
 *                               (owner audience only) rings when this is higher than the
 *                               comparable point's own count, or that point has none.
 * @param {number} [p.newCount]  how many of `count` are new since the last time this was
 *                               reported — >0 always rings, regardless of `count`.
 * @param {string} [p.dedupeKey]      one standing row per key (notifyAdmin dedupe)
 * @param {number} [p.dedupeWindowMs] rolling window for that dedupe
 * @param {boolean} [p.refreshOnDedupe] rewrite the standing row (and re-bell it) when the content changed
 * @param {boolean} [p.fallOff]       the sender retires this key on its clean run (ops-digest-fall-off.js);
 *                                    stamps metadata.fallOff so the Activity feed pins the row until resolved
 * @param {object} [p.trx]            caller transaction for atomic companion/digest persistence
 * @param {() => Promise<any>} p.sendEmail  the sender's existing mailer call
 * @returns {{ ok: boolean, channel: 'email'|'in_app', result?: any, error?: string, id?: string|null, fallback?: boolean }}
 *
 * Senders that already write their own bell (GBP sync health, call-extraction
 * eval) still get an ops_digest row here: that row is what the Activity feed
 * lists, and it is created only on the email's cadence.
 */
async function deliverOpsDigest({ key, subject, text, html, link = null, metadata = {}, headline = null, summary = null, audience = null, count, newCount, dedupeKey, dedupeWindowMs, refreshOnDedupe, fallOff = false, trx = null, sendEmail }) {
  if (typeof sendEmail !== 'function') throw new Error('deliverOpsDigest: sendEmail is required');
  if (!inAppEnabled()) {
    const result = await sendEmail();
    return emailOutcome(result);
  }
  const fields = digestRowFields({ subject, text, html, headline, summary, audience });
  // In-process senders' own `key` IS the alert class (one class per sender).
  const alertClass = alertClassFor(key, null);
  const countMeta = Number.isFinite(Number(count)) ? { count: Number(count) } : {};
  const newCountMeta = Number.isFinite(Number(newCount)) ? { newCount: Number(newCount) } : {};
  // Ring-only-on-change (owner audience only — see ringOptionsFor). Two
  // different mechanisms, matching the two ways a sender's row reaches the
  // table:
  //   - No dedupeKey (most senders: one fresh INSERT every run): notifyAdmin's
  //     `ringGate` decides, evaluated inside its OWN lock/transaction (never a
  //     second pool connection opened here while one is held) — see
  //     decideRingForNewRow's 7-day alert-class lookback.
  //   - dedupeKey + refreshOnDedupe (promised-estimate, gbp-sync-health,
  //     llm-dispatch-metrics, owned-url-health — one STANDING row, refreshed
  //     in place): the first-ever insert has no prior row to compare against
  //     (ring=true, same as decideRingForNewRow's own "no such row" rule)
  //     and every later call is a refresh notifyAdmin's own dedupe finds —
  //     `ringOnRefresh` decides those against that row's own content. An
  //     engineering/fyi sender (llm-dispatch-metrics; owned-url-health's FIX
  //     variant) never gets ringOnRefresh at all, so notifyAdmin's own
  //     default (any content change re-bells) applies, byte-identical to
  //     before PR 2 — those rows were never bell-visible either way.
  let row = null;
  try {
    row = await notificationService().notifyAdmin(CATEGORY, fields.title, fields.body, {
      link,
      // bell: true is the GATE_ADMIN_BELL_POLICY persist tag, not a ring: with
      // the policy on, `false` would suppress the ROW (no Activity entry, and
      // the email fallback fires). Bell visibility is `metadata.feed` below —
      // an Activity-only row never reaches the bell list/count, and admin
      // notifyAdmin rows never push.
      bell: true,
      detail: fields.detail,
      ...(trx ? { trx } : {}),
      // Optional dedupe (2026-09-11 email shutoff): a daily digest that
      // reports the same standing list must hold ONE row, refreshed when
      // the list changes, not one unread row per morning.
      ...ringOptionsFor({ dedupeKey, dedupeWindowMs, refreshOnDedupe, resolvedAudience: fields.audience, alertClass, key, count, newCount }),
      metadata: {
        opsKey: key,
        subject,
        alertClass,
        ...countMeta,
        ...newCountMeta,
        ...(fallOff ? { fallOff: true } : {}),
        ...metadata,
        // kind/audience/feed are the seam's classification, written after the
        // sender's own metadata so it can't shadow them (an override goes
        // through the `audience` param, which feeds all three consistently).
        kind: fields.kind,
        audience: fields.audience,
        // Written LAST and unconditionally (never spread-omitted): a sender
        // whose kind flips between runs under the SAME dedupeKey (gbp-sync-
        // health's FIX <-> ACT) must have notifyAdmin's refresh
        // `{...existingMeta, ...metadata}` merge actually overwrite a stale
        // `feed: 'activity'` with `feed: null` when it becomes owner-audience
        // again — an omitted key would leave the old value standing and the
        // row would never reach the bell (notification-service.js's
        // excludeActivityOnlyFromBell). A sender's own `...metadata` above
        // can never shadow this. `quiet` defaults to false (this call rings)
        // — notifyAdmin's `ringGate` rewrites both keys to true/'activity'
        // when the ring-only-on-change test says otherwise; a refresh with
        // no `ringOnRefresh` ring drops both keys from ITS merge instead, so
        // an already-quiet-or-rung standing row keeps its own visibility.
        // Owner-audience only (ringOptionsFor never gates a non-owner row):
        // an engineering/fyi row gets no `quiet` key and `fields.feed` is
        // already 'activity' unconditionally.
        feed: fields.feed,
        ...(fields.audience === 'owner' ? { quiet: false } : {}),
      },
    });
  } catch (err) {
    logger.error(`[ops-digest] ${key}: bell write threw: ${err.message}`);
  }
  if (!row) {
    // Never lose a digest to a DB hiccup — fall back to the email path.
    logger.warn(`[ops-digest] ${key}: bell row not written — falling back to email`);
    const result = await sendEmail();
    return { ...emailOutcome(result), fallback: true };
  }
  logger.info(`[ops-digest] ${key}: recorded in-app (${row.id || 'suppressed'}) — email skipped`);
  return { ok: true, channel: 'in_app', id: row.id || null };
}

/**
 * Fall-off rule (owner 2026-09-11): an exception bell must not sit unread
 * forever once the condition behind it has cleared. When the check that
 * raised a finding has run clean N times in a row (the runner counts), it
 * asks for the finding's standing rows to be retired: every admin
 * ops_digest row carrying that opsKey (and source, when given) that is not
 * yet resolved is stamped resolved in metadata and, if still unread, marked
 * read. Keyed off the resolved marker, NOT read_at: the owner opening a
 * FIX/ACT bell before the check runs clean must not leave it "needs a fix"
 * forever (pre-push P1). The row stays in the feed as history ("cleared");
 * nothing is deleted. Returns the number of rows retired. Machine callers
 * use throwOnError so a failed atomic retire/watermark write returns a
 * retryable non-2xx; in-process callers retain their legacy 0-on-error path.
 */
// `lockKey`: the dedupeKey the matching ingest uses. When given, the retire
// runs in its own transaction under the SAME advisory lock notifyAdmin's
// dedupe takes (`admin:${dedupeKey}`), so an overlapping recurrence and a
// clean-run resolve for one key serialize — never "deduped onto a row that
// is being resolved" nor "fresh failure resolved by the clean run" (codex
// P1 r6 on #4392). Without it the update runs on the shared connection.
// `notAfter`: the clean observation's timestamp. Only rows whose own
// observation is not newer than it retire — the advisory lock serializes
// requests, not observations, so a later failure whose ingest won the lock
// first must survive an earlier clean run's resolve (codex P1 r7 on #4392).
// `source` scoping: a string matches rows that seam wrote (the ingest route
// passes 'ops-crons'); `null` matches rows with NO source — the in-process
// senders, which never set one (ops-digest-fall-off.js); `undefined`
// (omitted) matches any. A key can therefore never retire another seam's rows.
// `alsoRetire: { category, field }` — a companion admin bell the same sender
// raises beside its digest (the evals' eval_regression rows, keyed by
// metadata.evalKey). It retires in the same call so a scheduled pass never
// clears the digest and leaves the primary bell standing. Both updates are
// one transaction, with the same source and observation-time scope. Optional
// legacyTitlePrefix identifies older companion rows without the metadata key.
// A stamped observedAt is the finding's event time; created_at is used only
// for legacy rows without one. A delayed 10:00 failure inserted at 10:20
// must clear under a 10:10 clean observation. The ingest route rejects
// older re-posts under the same advisory lock, keeping this stamp monotonic.
async function resolveOpsDigest({ key, source, resolvedBy = 'ops-crons', lockKey = null, notAfter = null, alsoRetire = null, throwOnError = false } = {}) {
  const opsKey = String(key || '').trim();
  if (!opsKey) return 0;
  const db = require('../models/db');
  const retire = async (conn) => {
    const stamp = new Date().toISOString();
    let q = conn('notifications')
      .where({ recipient_type: 'admin', category: CATEGORY })
      .whereRaw("COALESCE(metadata->>'resolved', '') <> 'true'")
      .whereRaw("metadata->>'opsKey' = ?", [opsKey]);
    if (source === null) q = q.whereRaw("metadata->>'source' IS NULL");
    else if (source) q = q.whereRaw("metadata->>'source' = ?", [String(source)]);
    if (notAfter) q = q.whereRaw("COALESCE(NULLIF(metadata->>'observedAt', '')::timestamptz, created_at) <= ?::timestamptz", [notAfter]);
    return q.update({
      read_at: conn.raw('COALESCE(read_at, NOW())'),
      // Drop the dedupeKey with the resolve stamp: a resolved row must never
      // be the "standing" row notifyAdmin's rolling-window dedupe finds, or a
      // finding that clears and recurs inside the window would be swallowed
      // as deduped with no live bell (codex P1 on #4392). opsKey stays for
      // history and the Activity feed.
      metadata: conn.raw("(COALESCE(metadata, '{}'::jsonb) - 'dedupeKey') || ?::jsonb", [JSON.stringify({ resolved: true, resolvedAt: stamp, resolvedBy: String(resolvedBy) })]),
    });
  };
  const retireCompanion = async (conn) => {
    if (!alsoRetire?.category || !alsoRetire?.field) return 0;
    const stamp = new Date().toISOString();
    let q = conn('notifications')
      .where({ recipient_type: 'admin', category: String(alsoRetire.category) })
      .whereRaw("COALESCE(metadata->>'resolved', '') <> 'true'");
    const field = String(alsoRetire.field);
    q = q.where((match) => {
      match.whereRaw('metadata->>? = ?', [field, opsKey]);
      if (alsoRetire.legacyTitlePrefix) {
        match.orWhere((legacy) => legacy.whereRaw('metadata->>? IS NULL', [field])
          .where('title', 'like', `${alsoRetire.legacyTitlePrefix}%`));
      }
    });
    if (source === null) q = q.whereRaw("metadata->>'source' IS NULL");
    else if (source) q = q.whereRaw("metadata->>'source' = ?", [String(source)]);
    if (notAfter) q = q.whereRaw("COALESCE(NULLIF(metadata->>'observedAt', '')::timestamptz, created_at) <= ?::timestamptz", [notAfter]);
    return q.update({
      read_at: conn.raw('COALESCE(read_at, NOW())'),
      metadata: conn.raw("(COALESCE(metadata, '{}'::jsonb) - 'dedupeKey') || ?::jsonb", [JSON.stringify({ resolved: true, resolvedAt: stamp, resolvedBy: String(resolvedBy) })]),
    });
  };
  try {
    const { count, companion } = lockKey || alsoRetire
      ? await db.transaction(async (trx) => {
        if (lockKey) await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`admin:${lockKey}`]);
        const retired = await retire(trx);
        const companion = await retireCompanion(trx);
        // Even with zero live bell rows, this clean run must suppress a
        // delayed older failure. The lock also serializes ingest's check.
        if (lockKey && notAfter) await recordCleanWatermark(trx, lockKey, notAfter);
        return { count: retired, companion };
      })
      : { count: await retire(db), companion: 0 };
    logger.info(`[ops-digest] ${opsKey}: retired ${count} standing row(s)${companion ? ` + ${companion} ${alsoRetire.category} bell(s)` : ''} (${resolvedBy})`);
    return Number(count) || 0;
  } catch (err) {
    logger.warn(`[ops-digest] ${opsKey}: retire failed: ${err.message}`);
    if (throwOnError) throw err;
    return 0;
  }
}

module.exports = {
  deliverOpsDigest, resolveOpsDigest, readCleanWatermark, cleanWatermarkKey, inAppEnabled, htmlToText, CATEGORY,
  deriveKind, defaultAudienceFor, fallbackHeadline, truncateAtWord, digestRowFields,
  alertClassFor, ringDecision, findPriorRungRow, decideRingForNewRow, ringOnRefreshFrom,
};
