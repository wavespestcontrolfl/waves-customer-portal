/**
 * Customer self-serve reschedule deep link.
 *
 * Long URL: {portal}/reschedule/{scheduled_services.reschedule_token},
 * shortened through the branded short-url service (kind 'reschedule') the
 * same way the en-route tracking link is. Short codes deliberately never
 * expire (expires_at null, same posture as estimate links): the reschedule
 * token is stable across moves, so a customer who used the link to push the
 * visit out must be able to reuse the SAME link from an old text to change
 * it again. Eligibility is owned by the /reschedule/:token target — once the
 * visit is terminal/past, the page shows the friendly not-reschedulable
 * state, so an expiring code buys nothing and breaks that contract.
 *
 * buildRescheduleLink returns { url, line }:
 *   - url:  the short (or long, on shortener failure) URL, or null when the
 *           row has no token (legacy pre-backfill rows).
 *   - line: the ready-to-embed SMS clause for the {reschedule_line} template
 *           variable, '' when there is no URL. Clause-style var (mirroring
 *           tech_en_route's {track_clause}) so a missing link renders clean
 *           copy instead of leaving an unresolved placeholder — which would
 *           suppress the whole SMS in getTemplate's unresolved check.
 *
 * Best-effort: never throws; callers treat { url: null, line: '' } as
 * "send the message without the link".
 *
 * opts.reuseExisting: return the visit's OLDEST existing reschedule short
 * code instead of minting, once every eligibility check above has passed.
 * For the Quick Move segment cap, which measures a body pre-move and
 * sends it after: the sheet's counter estimated against the existing
 * code (a legacy 5-char code vs a fresh 10-char mint flips a boundary
 * case), and a bare existing-code lookup would skip the grouped / frozen /
 * dispatch-pending refusals that make the link a dead end.
 * opts.previewOnly: read-only — the same eligibility checks and existing-
 * code reuse, but where a mint would happen returns a placeholder of a
 * fresh code's length instead (the sheet's advisory counter must never
 * mint). Implies reuseExisting. Deliberately skips the dead-link check
 * below: its only caller (rain-out.js's day-options measurement) is a
 * staff-driven surface, not a customer self-serve one, so the visit's own
 * move-notice window does not apply to it.
 * opts.assumeConfirmed: judge eligibility on the row's LANDED state — the
 * caller is about to move it through the rebooker, which confirms it, so
 * the dispatch-owned-pending refusal does not apply (the link would be
 * minted moments later by the post-move send anyway). Grouped / frozen
 * refusals still apply. For the Quick Move pre-move measurement only. Also
 * skips the dead-link guard below: this reads the row's OLD (pre-move)
 * scheduled_date/window_start, and that slot is about to be superseded, so
 * checking it against the move window would refuse a link for a visit
 * whose NEW slot may be perfectly fine to reschedule again later.
 * opts.pinnedUrl: the URL a pre-move check measured — after the same
 * eligibility checks, return THIS url (no lookup, no mint) or null when
 * the visit is no longer eligible, so a post-move send can only shrink
 * the measured body, never grow it.
 *
 * A thrown error inside the build (the service-row read, most likely)
 * still resolves to { url: null, line: '' } but carries `failed: true`,
 * so a caller that must fail closed on a read failure can tell it apart
 * from a plain "not eligible" (Quick Move's segment cap); every other
 * caller keeps treating the null url as "send without the link".
 *
 * Dead-link guard (owner-verified 2026-09-28, plan C3/C6): a visit that is
 * otherwise self-serviceable but currently starts inside the self-serve
 * MOVE notice window (SELF_SERVE_MOVE_NOTICE_HOURS) would 409/refuse on
 * /reschedule/:token — the exact same verdict the promised-link worker
 * (reschedule-link-promises.js's visitNotSelfServiceReason) already parks
 * for the office instead of sending. Rather than mint a link that dead-
 * ends, such a visit gets { url: null, line: 'Need a change? Reply here or
 * call.\n\n', tooSoonToMove: true } — never the bare empty line, so the
 * confirmation/reminder still tells the customer how to reach someone, and
 * `tooSoonToMove` lets a caller that must explain the refusal (the admin
 * composer's reschedule-link lookup) tell this apart from every other
 * null-url reason. A MISSED visit (picking a new time after the window
 * passed) is exempt: it is not "too soon to move", it is being rebooked.
 * Skipped when previewOnly (a staff-driven surface, not self-serve) or
 * assumeConfirmed (see both above) — an assumeConfirmed caller reads the
 * OLD row and must run its OWN landed-state re-check once its move
 * commits, the way rain-out.js's sendMovedSms does via pinnedUrl.
 */

// What a fresh mint looks like, length-wise (short-url createShortCode:
// 10 chars, 11 on collision retries) — the counter measures this.
const PREVIEW_CODE_PLACEHOLDER = 'xxxxxxxxxx';

const db = require('../models/db');
const logger = require('./logger');
const { portalUrl } = require('../utils/portal-url');
const { shortenOrPassthrough, existingShortUrlFor, shortLinkBaseUrl } = require('./short-url');
const { DISPATCH_OWNED_PENDING_SOURCE_ACTIONS } = require('./call-booking-source-actions');
const { eligibility } = require('./reschedule-eligibility');

function smsLineFor(url) {
  return url ? `Reschedule here: ${url}\n\n` : '';
}

// The clause for a visit this builder refuses to link (C3/C6): never the
// bare empty line the OTHER refusals return, so a customer still hears how
// to reach someone instead of a template line that just vanishes.
const NO_LINK_LINE = 'Need a change? Reply here or call.\n\n';

async function hasUnblockedVisitGroup(conn, visitId) {
  if (!visitId) return true;
  const vg = require('./visit-groups');
  const members = await vg.openMembers(conn, visitId);
  if (members.length >= 2) return false;
  return !(await vg.frozenVisitVerdict(conn, visitId)).frozen;
}

// GROUPED / FROZEN visits self-serve-reschedule as a whole (or not at all)
// — /reschedule/:token deterministically refuses their rows, so a
// "Reschedule here" line would be a dead end (codex #3609 on-merge r3).
// Same verdict the page applies: 2+ live members, or a frozen visit,
// suppresses the link; an unreadable membership fails closed. Extracted
// out of buildRescheduleLink to keep the builder's own branching down
// (AGENTS.md — see deadLinkGuardVerdict's header for the fuller rationale)
// — no behavior change.
async function linkSuppressedByVisitGroup(svc, scheduledServiceId) {
  if (!svc.visit_id) return false;
  try {
    return !(await hasUnblockedVisitGroup(db, svc.visit_id));
  } catch (vgErr) {
    logger.warn(`[reschedule-link] grouped-visit check failed for ${scheduledServiceId} — link suppressed: ${vgErr.message}`);
    return true;
  }
}

// Dead-link guard (C3/C6, see header) — the same chokepoint every OTHER
// refusal in buildRescheduleLink runs through, so a plain (non-preview,
// non-assumeConfirmed) caller — reminders, admin quick-send, the legacy
// Twilio reminder — inherits it automatically. That is NOT every caller,
// though: previewOnly skips it outright (its own doc comment above), and
// assumeConfirmed skips it HERE but is not exempt from the underlying
// rule — rain-out's pre-move measurement/reuse reads the OLD,
// about-to-be-superseded row (checking the move window against it would
// refuse a link for a visit whose NEW slot may be fine), so it must
// re-run this same check itself against the LANDED row once the move
// commits (its own pinnedUrl re-validation at send time — see
// rain-out.js's sendMovedSms) rather than inherit it from here.
// assumeConfirmed already means "trust the caller, this row's real-world
// state is about to differ from what's stored" for the dispatch-pending
// refusal above; the same reasoning applies here.
// Returns the refusal object when the guard applies, or null when the
// link may proceed. Extracted out of buildRescheduleLink verbatim so the
// builder's own branching doesn't keep growing past its pre-round-5
// baseline (AGENTS.md: extract new decision paths into small named
// helpers rather than grow an already-flagged function) — no behavior
// change.
function deadLinkGuardVerdict(svc, { previewOnly, assumeConfirmed }) {
  if (previewOnly || assumeConfirmed) return null;
  const now = new Date();
  const verdict = eligibility(svc, now);
  if (require('./reschedule-link-promises').tooSoonToSelfServeMove(svc, verdict, now)) {
    // tooSoonToMove: true lets a caller that must explain WHY there is no
    // link (e.g. the admin composer's reschedule-link lookup) tell this
    // apart from every other null-url reason (no token, grouped/frozen,
    // dispatch-owned-pending, shortener failure) — those are dead ends;
    // this one just means "too soon, ask them to reply or call"
    // (independent-reviewer finding on PR #5308).
    return { url: null, line: NO_LINK_LINE, tooSoonToMove: true };
  }
  return null;
}

async function buildRescheduleLink(scheduledServiceId, { customerId = null, reuseExisting = false, previewOnly = false, assumeConfirmed = false, pinnedUrl = undefined } = {}) {
  try {
    if (!scheduledServiceId) return { url: null, line: '' };
    const svc = await db('scheduled_services')
      .where({ id: scheduledServiceId })
      .first('id', 'customer_id', 'reschedule_token', 'source_action', 'status', 'customer_confirmed',
        'visit_id', 'scheduled_date', 'window_start', 'window_end');
    if (!svc?.reschedule_token) return { url: null, line: '' };
    if (await linkSuppressedByVisitGroup(svc, scheduledServiceId)) return { url: null, line: '' };
    // Never mint a self-serve link for a dispatch-owned booking the office
    // hasn't reviewed (codex #3429 r2 P1): reminders now arm before office
    // confirm, and a bearer reschedule URL would let the recipient move a
    // booking the authenticated schedule routes deliberately hide/refuse.
    // Callers already treat { url: null, line: '' } as "send without link".
    if (!assumeConfirmed
      && DISPATCH_OWNED_PENDING_SOURCE_ACTIONS.includes(svc.source_action)
      && String(svc.status || '').toLowerCase() === 'pending'
      && !svc.customer_confirmed) {
      return { url: null, line: '' };
    }
    // Dead-link guard (C3/C6, see header + deadLinkGuardVerdict's own
    // comment) — the same chokepoint every OTHER refusal above runs
    // through, so a plain (non-preview, non-assumeConfirmed) caller —
    // reminders, admin quick-send, the legacy Twilio reminder — inherits it
    // automatically.
    const guardVerdict = deadLinkGuardVerdict(svc, { previewOnly, assumeConfirmed });
    if (guardVerdict) return guardVerdict;

    if (pinnedUrl !== undefined) return { url: pinnedUrl, line: smsLineFor(pinnedUrl) };
    if (reuseExisting || previewOnly) {
      const existing = await existingShortUrlFor({
        kind: 'reschedule', entityType: 'scheduled_services', entityId: svc.id,
      });
      if (existing) return { url: existing, line: smsLineFor(existing) };
    }
    if (previewOnly) {
      const placeholder = `${shortLinkBaseUrl()}/l/${PREVIEW_CODE_PLACEHOLDER}`;
      return { url: placeholder, line: smsLineFor(placeholder) };
    }

    const longUrl = portalUrl(`/reschedule/${svc.reschedule_token}`);
    const url = await shortenOrPassthrough(longUrl, {
      kind: 'reschedule',
      entityType: 'scheduled_services',
      entityId: svc.id,
      customerId: customerId || svc.customer_id || null,
      // Never expires — see header. The /reschedule/:token page owns
      // eligibility for stale links.
      expiresAt: null,
    });
    return { url, line: smsLineFor(url) };
  } catch (err) {
    logger.warn(`[reschedule-link] build failed for ${scheduledServiceId}: ${err.message}`);
    return { url: null, line: '', failed: true };
  }
}

module.exports = { buildRescheduleLink, smsLineFor, hasUnblockedVisitGroup };
