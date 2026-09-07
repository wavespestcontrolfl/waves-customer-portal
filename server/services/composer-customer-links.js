/**
 * Per-customer link builders for the SMS composer's Insert Link sheet —
 * the link kinds beyond the existing reschedule/re-service pair:
 * review request, pay balance, latest estimate, referral, Auto Pay setup,
 * and (step 2) appointment page, card request, prep guide, latest service
 * report, contract signing, payer statement.
 *
 * Contract mirrors reschedule-link/reservice-link: each builder returns
 * { url, line, ...context } with url null + a `reason` sentence when there
 * is nothing to insert (the route turns that into a 404 {error}). The line
 * is a self-contained plain-ASCII SMS clause ending in '\n\n'.
 *
 * These reuse the owning systems rather than minting parallel credentials:
 *   review   — ReviewService.createInline (the dispatch completion-SMS
 *              pattern) with armSafetyNet:false: mints a real
 *              review_requests row WITHOUT sending and WITHOUT a scheduled
 *              fallback — the operator's composer send is the only delivery
 *              (POST /sms marks it delivered); a withdrawn link's row is
 *              retired via customer-link/cancel.
 *   pay      — open-balance.js selection (self-pay only, live payer
 *              re-resolution) + the oldest open invoice's /pay/:token link,
 *              short-wrapped with the repo-wide invoice idiom. Totals a
 *              resolve failure made incomplete suppress the amount, never
 *              understate it.
 *   estimate — the customer's newest OPEN estimate (sending/sent/viewed ∩
 *              isEstimateCustomerViewable), short-wrapped kind 'estimate'.
 *   referral — referral-engine.resolvePromoter: idempotent, self-healing,
 *              guarantees a personal /r/CODE link. No short code (referral
 *              links go out raw everywhere).
 */

const db = require('../models/db');
const logger = require('./logger');
const { publicPortalUrl } = require('../utils/portal-url');
const { etCalendarDayOf } = require('../utils/datetime-et');
const { shortenOrPassthrough, invoiceShortCodePrefix } = require('./short-url');

// Estimate statuses that count as "open" for a composer insert: delivered or
// mid-delivery, not yet resolved. Draft/scheduled are unpublished (must never
// be linked), accepted/declined/expired/void are settled, quote_required
// needs a human quote first.
const OPEN_ESTIMATE_STATUSES = ['sending', 'sent', 'viewed'];

// The gate outcomes checkUnscheduledAskGates can return, phrased for the
// composer (mirrors the messages create() throws for the same outcomes).
const REVIEW_GATE_REASONS = {
  in_cadence: 'Customer is in an active review cadence — manage outreach from the cadence instead of a one-off link.',
  at_cap: 'Customer has already received 3 review requests in the last 6 months',
  cooldown: 'Customer received a review request in the last 30 days',
  already_queued: 'A review request to this customer is already queued and will send automatically.',
  in_flight: 'A review request to this customer is being sent right now.',
};

async function buildReviewRequestLink(customerId) {
  const ReviewService = require('./review-request');
  const { runExclusive } = require('../utils/cron-lock');
  const customer = await db('customers').where({ id: customerId }).first('id', 'has_left_google_review');
  if (customer?.has_left_google_review) {
    return { url: null, line: '', reason: 'This customer is already marked as having left a review' };
  }

  // A composer mint is an unscheduled ask like /trigger — it must pass the
  // SAME gate stack (cadence, 3-in-180d cap, 30-day cooldown, already-queued)
  // or the sheet becomes a path around the caps. Gate-check + mint run under
  // the per-customer advisory lock create() uses so a concurrent trigger
  // can't slip a second ask past the gates between check and insert.
  //
  // armSafetyNet:false — the row is UNSCHEDULED: the only delivery is the
  // operator's own composer send (which marks it delivered). No scheduler
  // ever picks the row up, so an abandoned draft can't auto-text the
  // customer later, the fallback can't target a different recipient than
  // the operator composed to, and cancellation has no send to race.
  const minted = await runExclusive(
    `review-send:${customerId}`,
    async () => {
      const gate = await ReviewService.checkUnscheduledAskGates(customerId);
      if (!gate.allowed) return { gate };
      return { inline: await ReviewService.createInline({ customerId, armSafetyNet: false }) };
    },
    { recordHealth: false },
  );
  if (minted?.skipped) {
    return { url: null, line: '', reason: 'A review request to this customer is already being sent — try again in a moment' };
  }
  if (minted?.gate) {
    return { url: null, line: '', reason: REVIEW_GATE_REASONS[minted.gate.outcome] || 'Review request blocked' };
  }
  const inline = minted?.inline;
  if (!inline?.url) {
    return { url: null, line: '', reason: 'No review link for this customer — review texts may be turned off in their notification preferences' };
  }

  return {
    url: inline.url,
    line: `Would you share how we did? It takes 30 seconds: ${inline.url}\n\n`,
    requestId: inline.requestId,
  };
}

async function buildPayBalanceLink(customerIds) {
  const { openBalanceSummary } = require('./open-balance');

  // Oldest open self-pay invoice across the account is the anchor — the pay
  // page itself (GATE_PAY_INCLUDE_BALANCE) offers the rest of the balance.
  // openBalanceInvoices deliberately never selects tokens, so the anchor's
  // token comes from its own scoped query.
  //
  // The reported amount comes from the pay page's OWN authority (below):
  // anchor scoping alone still overclaims, because the combined flow is
  // opt-in (GATE_PAY_INCLUDE_BALANCE) and excludes stopped-dunning siblings
  // and rows owned by a live PaymentIntent — the figure must match what the
  // linked page will actually display and charge.
  let anchor = null;
  let anchorSummary = null;
  let anchorIncomplete = false;
  for (const id of customerIds) {
    let incomplete = false;
    const summary = await openBalanceSummary(id, {
      onResolveFailure: () => { incomplete = true; },
      onTruncation: () => { incomplete = true; },
    });
    const first = summary.invoices[0];
    if (first) {
      const firstDue = new Date(first.due_date || first.created_at || 0).getTime();
      const anchorDue = anchor ? new Date(anchor.due_date || anchor.created_at || 0).getTime() : Infinity;
      if (firstDue < anchorDue) {
        anchor = first;
        anchorSummary = summary;
        anchorIncomplete = incomplete;
      }
    }
  }
  if (!anchor || !(anchorSummary.total > 0)) {
    return { url: null, line: '', reason: 'No open balance on this account' };
  }

  // Full row: combinedEligibleSiblings and amountDueCents read payer/amount
  // columns, not just the token.
  const invoice = await db('invoices').where({ id: anchor.id }).first();
  if (!invoice?.token) {
    return { url: null, line: '', reason: 'No open balance on this account' };
  }

  // Derive the displayed figure from the pay page's combined-payment
  // authority so the composer never announces a balance the link can't
  // settle: combinedEligibleSiblings is exactly what GET /pay/:token uses —
  // it returns null when the combined flow won't engage (gate off, payer
  // resolution, incomplete read, no siblings) and otherwise the sibling
  // rows it will itemize, already filtered for stopped dunning and live
  // PaymentIntent ownership. It never throws; null degrades the figure to
  // the anchor invoice alone, which is what the page will show and charge.
  let balance = null;
  if (!anchorIncomplete) {
    const { combinedEligibleSiblings, amountDueCents } = require('./pay-combined');
    const siblings = (await combinedEligibleSiblings(invoice)) || [];
    const totalCents = amountDueCents(invoice)
      + siblings.reduce((sum, sib) => sum + amountDueCents(sib), 0);
    balance = { total: totalCents / 100, count: 1 + siblings.length };
  }
  const url = await shortenOrPassthrough(`${publicPortalUrl()}/pay/${invoice.token}`, {
    kind: 'invoice',
    entityType: 'invoices',
    entityId: invoice.id,
    customerId: invoice.customer_id,
    channel: 'sms',
    purpose: 'composer_insert',
    codePrefix: invoiceShortCodePrefix(invoice),
  });
  return {
    url,
    line: `You can view and pay your balance securely here: ${url}\n\n`,
    // An incomplete read (payer resolve failure / truncation) may understate
    // the total — say nothing about the amount rather than assert a wrong
    // figure (the open-balance SMS-line rule). balance stays null then.
    balance,
  };
}

// The newest OPEN, customer-viewable, pricing-gate-deliverable estimate on
// the account — resolved WITHOUT minting anything, so a caller can decide
// whether the link will actually be sent before a permanent short_codes row
// exists (GH codex #3814 r1 P2). Answers { estimate } or { estimate: null,
// reason }; buildLatestEstimateLink below is resolve + mint.
async function findLatestOpenEstimate(customerIds) {
  const { isEstimateCustomerViewable } = require('../routes/estimate-public');
  // Viewability (expiry, linkage-invalidation) is a predicate the query can't
  // express, and a filter applied AFTER a limit lets newer hidden rows mask an
  // older estimate the customer can still open (the relay-money.js trap).
  // Page through until a viewable row is found or the candidates run out.
  const PAGE = 15;
  let estimate = null;
  for (let offset = 0; ; offset += PAGE) {
    const rows = await db('estimates')
      .whereIn('customer_id', customerIds)
      .whereIn('status', OPEN_ESTIMATE_STATUSES)
      .whereNull('archived_at')
      // NEWEST open estimate, by creation — viewing activity must not rank:
      // an old estimate the customer opened yesterday would outrank the
      // revised one created today, sending stale pricing. A newer estimate
      // supersedes its siblings regardless of who has looked at what.
      .orderBy('created_at', 'desc')
      .offset(offset)
      .limit(PAGE);
    estimate = rows.find((row) => isEstimateCustomerViewable(row)) || null;
    if (estimate || rows.length < PAGE) break;
  }
  if (!estimate?.token) {
    return { estimate: null, reason: 'No open estimate on this account' };
  }
  // Engine-authoritative pricing gate (#3750, GH codex P1 r22): the composer
  // link is a customer send like any other. While the gate is on, the newest
  // open estimate must pass the shared group-aware verdict — an unverified
  // one yields NO link (never an older estimate's stale pricing) and tells
  // the operator to re-save it through the engine first.
  {
    const { gatedSendAuthorityPredicateApplies, estimateDeliverableUnderGate } = require('./pricing-authority-gate');
    if (gatedSendAuthorityPredicateApplies() && !(await estimateDeliverableUnderGate(db, estimate))) {
      return { estimate: null, reason: 'The latest open estimate has no engine-verified price — re-save it from the estimate tool before linking it' };
    }
  }
  return { estimate };
}

// Mint the customer-facing short link for an estimate findLatestOpenEstimate
// resolved. createShortCode always inserts a fresh row, so a caller whose
// send can retry (the call-booking confirmation) passes reuseExisting to
// take the earliest code THIS purpose already minted for the estimate
// instead of accumulating bearer links across retries (pre-push codex P1);
// never another workflow's code — click attribution stays with the send
// that minted it. The composer insert keeps its own per-insert code.
async function mintEstimateLink(estimate, { purpose = 'composer_insert', reuseExisting = false } = {}) {
  if (reuseExisting) {
    const { existingShortUrlFor } = require('./short-url');
    const reused = await existingShortUrlFor({ kind: 'estimate', entityType: 'estimates', entityId: estimate.id, purpose });
    if (reused) {
      return {
        url: reused,
        line: `You can view your estimate here: ${reused}\n\n`,
        estimate: { id: estimate.id, serviceType: estimate.service_type || null, status: estimate.status },
      };
    }
  }
  const url = await shortenOrPassthrough(`${publicPortalUrl()}/estimate/${estimate.token}`, {
    kind: 'estimate',
    entityType: 'estimates',
    entityId: estimate.id,
    customerId: estimate.customer_id,
    channel: 'sms',
    // Click-tracking label only (short-url row.purpose): the composer
    // insert by default; the call-booking confirmation passes its own.
    purpose,
  });
  return {
    url,
    line: `You can view your estimate here: ${url}\n\n`,
    estimate: { id: estimate.id, serviceType: estimate.service_type || null, status: estimate.status },
  };
}

// The call-booking confirmation's accept line resolves the NEWEST open
// estimate, and only when the accept page would adopt this very visit
// (findLinkedUpcomingAppointment pinned to it). `estimateId` pins a choice
// already persisted on the reminder row (appointment_reminders
// .confirmation_estimate_id): the stranded-confirmation sweep re-delivering
// a held text must not switch to an estimate created since — a stale pin
// yields no line, never a different estimate's.
async function resolveConfirmationEstimate({ customerId, scheduledServiceId, estimateId = null }) {
  const { estimate } = await findLatestOpenEstimate([customerId]);
  if (!estimate) return null;
  if (estimateId && String(estimate.id) !== String(estimateId)) return null;
  const { findLinkedUpcomingAppointment, adoptionServiceModesForContract } = require('../routes/estimate-public');
  let estData = estimate.estimate_data;
  if (typeof estData === 'string') { try { estData = JSON.parse(estData); } catch { estData = {}; } }
  estData = estData || {};
  const offered = await findLinkedUpcomingAppointment(estimate, estData, {
    appointmentId: String(scheduledServiceId),
    serviceModes: adoptionServiceModesForContract(estimate, estData),
  });
  return offered && String(offered.id) === String(scheduledServiceId) ? estimate : null;
}

// Accept line for a confirmation text, minted at SEND time: callers resolve
// (never mint) the estimate up front, so the permanent short_codes row
// exists only for a text that is actually going out (GH codex #3814 r1
// P2). Best-effort — a mint failure sends the plain confirmation rather
// than losing it.
async function appendEstimateAcceptLine(body, estimate, { scheduledServiceId = null } = {}) {
  if (!estimate || !body) return body;
  try {
    const { url } = await mintEstimateLink(estimate, { purpose: 'call_booking_confirmation', reuseExisting: true });
    if (!url) return body;
    return `${String(body).trimEnd()}\n\nYou can accept your estimate and choose your plan here: ${url}`;
  } catch (err) {
    logger.warn(`[composer-links] open-estimate accept line skipped for visit ${scheduledServiceId}: ${err.message}`);
    return body;
  }
}

async function buildLatestEstimateLink(customerIds, { purpose = 'composer_insert' } = {}) {
  const found = await findLatestOpenEstimate(customerIds);
  if (!found.estimate) return { url: null, line: '', reason: found.reason };
  return mintEstimateLink(found.estimate, { purpose });
}

async function buildReferralLink(customerId) {
  const { resolvePromoter, getLiveSettings } = require('./referral-engine');
  // Same STRICT settings read as the report referral endpoint
  // (reports-public.js): no live row or inactive program = no enrollment
  // and no link — enrollPromoter's own getSettings() falls back to
  // permissive defaults, which would let an admin enroll a promoter and
  // text a working, tracked referral after the owner disabled the program.
  // FAIL CLOSED on an unavailable read too.
  let liveSettings = null;
  try {
    liveSettings = await getLiveSettings();
  } catch {
    liveSettings = null;
  }
  if (!liveSettings?.program_active) {
    return { url: null, line: '', reason: 'Referral program is not active' };
  }
  let promoter;
  try {
    // Enroll-or-resolve: a multi-property sibling whose phone already backs
    // another sibling's promoter resolves the household promoter read-only,
    // scoped to the account (referral-engine.resolvePromoter); a cross-
    // account collision rethrows → the plain reason, never a guessed
    // attribution. Log err.code only, never err.message — PG constraint
    // violations quote the conflicting value, which here is a phone number
    // (AGENTS.md PII-in-logs rule).
    ({ promoter } = await resolvePromoter(customerId));
  } catch (err) {
    logger.warn(`[composer-links] referral enroll failed (customerId=${customerId}, code=${err?.code || 'none'})`);
    return { url: null, line: '', reason: 'Could not build a referral link for this customer' };
  }
  if (!promoter?.referral_link) {
    return { url: null, line: '', reason: 'Could not build a referral link for this customer' };
  }
  return {
    url: promoter.referral_link,
    line: `Know someone who needs pest control? Share Waves here: ${promoter.referral_link}\n\n`,
  };
}

// Every skip requestAutopaySetupLink can return, phrased for the composer
// (same vocabulary as cardLinkStatus.describeAutopaySetupLinkResult on the
// Customers page — one plain sentence per outcome, unknown reasons stay
// visible rather than pretending a link exists).
const AUTOPAY_SKIP_REASONS = {
  gate_off: 'Auto Pay setup links are switched off (GATE_AUTOPAY_SETUP_LINK)',
  customer_not_found: 'Customer not found',
  payer_billed: 'This customer bills to a third-party payer — no Auto Pay setup link',
  payer_check_uncertain: 'Could not confirm who this customer bills to — try again in a moment',
  autopay_already_active: 'This customer is already on Auto Pay',
  autopay_paused: 'Auto Pay is already set up but paused — resume it instead of sending a setup link',
  unsupported_billing_lane: 'Auto Pay setup links are only for per-visit and per-application customers',
  completion_in_progress: 'This customer is finishing an Auto Pay setup right now — try again in a few minutes',
  autopay_sms_gate_off: 'Auto Pay customer texts are switched off (GATE_AUTOPAY_CUSTOMER_SMS)',
  template_inactive: 'The Auto Pay setup text is inactive in Templates — activate it before texting a setup link',
  template_missing_link: 'The Auto Pay setup text in Templates has no {secure_link} placeholder — add it before texting a setup link',
};

// The composer's insert IS an SMS delivery (the operator's /sms send goes
// out as original_message_type 'manual', so the Auto Pay classifier never
// re-applies its gates). Enforce the same two levers the service's own SMS
// branch checks — the customer-SMS rollout gate and the template's active
// toggle — BEFORE anything mints or enrolls (GH Codex #3812 r1 P1). Fail
// closed on an unreadable template row.
async function autopaySmsLever() {
  if (!require('../config/feature-gates').isEnabled('autopayCustomerSms')) return 'autopay_sms_gate_off';
  try {
    const row = await db('sms_templates').where({ template_key: 'autopay_setup_link' }).first('is_active');
    if (!row || row.is_active === false) return 'template_inactive';
  } catch (err) {
    logger.warn(`[composer-links] autopay template lookup failed: ${err.message}`);
    return 'template_inactive';
  }
  return null;
}

/**
 * Auto Pay setup link — delegates entirely to autopay-setup-link's ONE
 * entry point (inline delivery: mint or reuse the live /secure/:token row,
 * send nothing — the composer send is the only delivery). Every policy
 * decision (gate, payer exemption, already-on-Auto-Pay, paused, lane,
 * saved-method auto-secure, dedup) stays there; this only translates the
 * outcome into the composer's { url, line } / reason contract.
 *
 * auto_secured is the one outcome that is neither a link nor a refusal: a
 * consented saved card covered the ask and was enrolled (same behavior as
 * the Customers page button) — there is nothing to insert, and the reason
 * says so explicitly so the operator does not text a link that no longer
 * matters.
 */
async function buildAutopaySetupLink(customerId) {
  const lever = await autopaySmsLever();
  if (lever) return { url: null, line: '', reason: AUTOPAY_SKIP_REASONS[lever] };
  const { requestAutopaySetupLink } = require('./autopay-setup-link');
  const result = await requestAutopaySetupLink({ customerId, delivery: 'inline', trigger: 'admin' });
  // A successful mutation, not a missing link (GH Codex #3812 r2 P2): the
  // route answers 200 with autoSecured so the composer reports it as done.
  if (result?.action === 'auto_secured') {
    return { url: null, line: '', autoSecured: true };
  }
  if (result?.action === 'link_created' && result.secureUrl) {
    // The customer-facing copy is the reviewed autopay_setup_link SMS
    // template — the SAME body the direct Auto Pay text path renders — not
    // a second hand-written copy (GH Codex #3812 r3 P1). Rendered here with
    // the real link, collapsed to ONE line so the composer's recipient-
    // change strip removes the whole message with the tracked URL (r1 P2),
    // and flagged standalone: it already greets, so the composer inserts it
    // as-is instead of wrapping it in the generic prefill.
    const { renderTemplate } = require('./appointment-card-request');
    const profile = await db('customers').where({ id: customerId }).first('first_name');
    const body = await renderTemplate({ first_name: profile?.first_name || 'there', secure_link: result.secureUrl }, 'autopay_setup_link');
    if (!body) return { url: null, line: '', reason: AUTOPAY_SKIP_REASONS.template_inactive };
    // validateTemplateBody does not require {secure_link} for this key — an
    // edit that drops it renders fine and would text setup copy with no
    // link (GH Codex #3812 r4 P2). The minted URL must be in the body —
    // compared scheme-stripped, because getTemplate strips https:// from
    // owned portal hosts before returning (r5 P1).
    const { stripPortalUrlScheme } = require('../routes/admin-sms-templates');
    if (!String(body).includes(stripPortalUrlScheme(result.secureUrl))) {
      return { url: null, line: '', reason: AUTOPAY_SKIP_REASONS.template_missing_link };
    }
    return {
      url: result.secureUrl,
      line: `${String(body).replace(/\s*\n+\s*/g, ' ').trim()}\n\n`,
      standalone: true,
      expiresAt: result.expiresAt || null,
    };
  }
  const reason = String(result?.reason || '');
  return { url: null, line: '', reason: AUTOPAY_SKIP_REASONS[reason] || `Could not build an Auto Pay setup link (${reason || 'unknown'})` };
}

// The /secure/:token bearer the composer inserts (autopay-setup-link mints
// 16 random bytes base64url = 22 chars; the visit lane's card requests share
// the page and the table). Bodies carry the link scheme-stripped
// (stripSmsLinkScheme), so the match is host + path, scheme optional.
// Percent-escapes decode before detection: React Router decodes the
// pathname, so "/secur%65/<token>" still opens the page and must still be
// judged (GH Codex #3812 r5 P1). Malformed escapes are left as typed.
function decodeLinkText(body) {
  // WHATWG parsing treats a backslash as a path separator for special
  // schemes — "portal…\\secure\\<token>" still opens the page (r7 P1).
  return String(body || '').replace(/\\/g, '/').replace(/(?:%[0-9A-Fa-f]{2})+/g, (seq) => {
    try { return decodeURIComponent(seq); } catch { return seq; }
  });
}

// Bearer tokens are randomBytes(16).toString('base64url') — 22 URL-safe
// characters — for both the standalone and the visit lane. A band rather
// than an exact width so a longer mint never slips past; a run that is no
// token simply finds no row.
const TOKEN_RUN_RE = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{20,64}(?![A-Za-z0-9_-])/g;
// Every whitespace-delimited run of the (decoded) body that carries a
// /secure/ path, with wrapping punctuation shed and a bare "Label:" prefix
// dropped ("Link:portal…" is how operators type it). Each run is PARSED as
// a URL (https:// assumed when schemeless — that is how the composer inserts
// owned-host links) and accepted only when its hostname is exactly the
// portal host and its pathname is exactly /secure/<token>. A substring
// match is never enough: "https://evil.example/?next=portal…/secure/<tok>"
// sends the bearer to evil.example (GH Codex #3812 r6 P1; earlier rounds
// covered path-nested, subdomain and suffix look-alikes the same way).
// Runs are split on the ORIGINAL text and decoded one by one: decoding
// first would let "%0A" inside a hostile URL manufacture a fresh,
// trusted-looking run ("https://evil.example/%0Aportal…/secure/<tok>" —
// the browser keeps the escape and follows evil.example; r8 P1). Decoded
// whitespace inside a run stays inside it, and the URL parser then judges
// the whole run against the real origin.
function decodedRuns(body) {
  return String(body || '').split(/\s+/).filter(Boolean).map(decodeLinkText);
}
function linkRuns(runs, fragmentRe) {
  return runs
    .filter((run) => fragmentRe.test(run))
    .map((run) => run.replace(/^[(\[<'"]+/, '').replace(/[.,;:!?)\]}>'"]+$/, ''))
    // A bare label glued to the link ("Link:", "now,") is shed — but only a
    // slash-free prefix, so an outer URL's own path/query is never cut away.
    .map((run) => run.replace(/^[^/]*?(?=https?:\/\/)/i, ''))
    .map((run) => (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(run) ? run : run.replace(/^[^/:,;]*[:,;]/, '')));
}
function secureLinkRuns(runs) {
  return linkRuns(runs, /\/secure\//i);
}
// `hosts`: one owned host or the whole owned set (ownedPortalHosts) — this
// Express app serves the SPA and every public bearer route on EVERY host it
// answers (server/index.js has no Host restriction), so a long-form
// /prep, /pay/statement, /appointment or /report URL on the branded short
// host is the same working page as on the portal origin and is judged the
// same (GH Codex #3844 r8 P1 — the long-form twin of the r6 short-link fix).
// `anyScheme`: the schedule/draft FENCE judges presence, not sendability —
// the public Express mounts are protocol-agnostic and a client or edge that
// upgrades HTTP opens the same bearer, so an explicit http:// owned link is
// a protected link that must park the message, not a link that is not there
// (GH Codex #3844 r11 P1). The immediate seams keep the https-only read and
// refuse the plaintext form outright.
function canonicalPortalToken(run, hosts, pathRe, { anyScheme = false } = {}) {
  let url;
  try {
    url = new URL(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(run) ? run : `https://${run}`);
  } catch {
    return null;
  }
  // HTTPS or the schemeless canonical form only — an explicit http:// would
  // expose the 30-day bearer before any redirect reaches HTTPS.
  if (url.protocol !== 'https:' && !(anyScheme && url.protocol === 'http:')) return null;
  // A DNS-equivalent FQDN form (`portal.wavespestcontrol.com.`) keeps its
  // terminal dot through WHATWG parsing and still resolves to us — the
  // same working page, judged the same (GH Codex #3844 r10 P1).
  if (![].concat(hosts).includes(url.host.toLowerCase().replace(/\.$/, ''))) return null;
  // The public routes match with a trailing slash too (React Router and the
  // Express /l and /secure mounts alike), so /prep/<token>/ is the same
  // working page as /prep/<token> — judged the same, or it would slip the
  // schedule/draft fence and every send-time check (GH Codex #3844 r7 P1).
  const m = pathRe.exec(url.pathname.replace(/\/+$/, ''));
  return m ? m[1] : null;
}
const SECURE_PATH_RE = /^\/secure\/([A-Za-z0-9_-]{16,})$/i;
function canonicalSecureToken(run, hosts, opts) {
  return canonicalPortalToken(run, hosts, SECURE_PATH_RE, opts);
}

/**
 * Delivery-seam check for a composer body carrying Auto Pay setup links
 * (GH Codex #3812 r2 P1/P2). The composer posts every send as
 * original_message_type 'manual', so the canonical Auto Pay classifier in
 * send-customer-message never sees it and the insert-time checks go stale
 * while a draft sits open. EVERY /secure occurrence in the body is judged
 * (pre-push Codex P0 — a visit link first must not shadow an Auto Pay link
 * after it), each must sit on the canonical portal host (pre-push P1 — a
 * look-alike host carrying a real token is not a Waves link), and each
 * customer-kind row is re-run through the mint's own side-effect-free
 * eligibility (pre-push P1). Called by /sms (with the recipient's last-10
 * AND the customer id the route trusts — the link's owner must be that
 * customer, so the send rides the owner's own SMS preferences instead of
 * the lead policy that permits a missing preferences row; GH Codex #3812
 * r3 P1), by /schedule-sms and the draft approve/revise endpoints
 * (presence is enough — they refuse):
 *   { present: false }                       — no customer-kind Auto Pay link in the body
 *   { present: true, ok: true, tokens }      — every Auto Pay link is live, eligible and
 *                                              owned by the recipient; the caller reclassifies
 *   { present: true, ok: false, error }      — refuse the send with this message
 * Visit-lane card requests (kind 'visit') use the same page but their own
 * gates — they are neither judged nor reclassified here.
 */
async function autopayLinkSendCheck(body, toLast10, { trustedCustomerId } = {}) {
  const runs = decodedRuns(body);
  const text = runs.join(' ');
  const refuse = (error) => ({ present: true, ok: false, error });
  const hosts = ownedPortalHosts();
  // 1. Every run carrying a /secure/ path must parse as a canonical link.
  const canonicalTokens = [];
  for (const run of secureLinkRuns(runs)) {
    const token = canonicalSecureToken(run, hosts);
    if (!token) return refuse('A /secure link in this message is not on the Waves portal — remove it before sending.');
    if (!canonicalTokens.includes(token)) canonicalTokens.push(token);
  }

  // 2. TOKEN-FIRST: the bearer is the token, and a working link must carry
  // it verbatim (decoded above) whatever the surrounding text looks like.
  // Every token-shaped run is looked up; a live standalone token that is
  // not inside a canonical link refuses — that closes the obfuscation
  // class (percent-encoding, backslashes, hostile outer URLs, look-alike
  // hosts) under one rule instead of one detector per trick.
  const candidates = [...new Set([...canonicalTokens, ...(text.match(TOKEN_RUN_RE) || [])])];
  if (!candidates.length) return { present: false };
  const { KIND, setupLinkIneligibility } = require('./autopay-setup-link');
  const rows = await db('appointment_card_requests')
    .whereIn('token', candidates)
    .select('id', 'kind', 'token', 'status', 'expires_at', 'customer_id');
  const byToken = new Map(rows.filter((r) => r.kind === KIND).map((r) => [r.token, r]));
  for (const [token] of byToken) {
    if (!canonicalTokens.includes(token)) {
      return refuse('An Auto Pay setup link in this message is not a plain Waves portal link — remove it and re-insert it from Insert Link.');
    }
  }
  const live = [];
  for (const token of canonicalTokens) {
    const row = byToken.get(token);
    if (!row) {
      // A canonical /secure link whose token is unknown or belongs to the
      // visit lane: the visit lane keeps its own gates; an unknown token is
      // a dead link.
      if (rows.some((r) => r.token === token)) continue;
      return refuse('This Auto Pay setup link is expired or no longer live — remove it and insert a fresh one.');
    }
    if (row.status !== 'pending' || (row.expires_at && new Date(row.expires_at).getTime() <= Date.now())) {
      return refuse('This Auto Pay setup link is expired or no longer live — remove it and insert a fresh one.');
    }
    live.push({ token, customerId: row.customer_id });
  }
  if (!live.length) return { present: false };

  // 3. Levers, eligibility, ownership, trust — per live link.
  const lever = await autopaySmsLever();
  if (lever) return refuse(`${AUTOPAY_SKIP_REASONS[lever]} — remove the Auto Pay link before sending.`);
  for (const { customerId } of live) {
    const eligibility = await setupLinkIneligibility(customerId);
    if (eligibility.reason) {
      return refuse(`${AUTOPAY_SKIP_REASONS[eligibility.reason] || `Auto Pay setup link no longer applies (${eligibility.reason})`} — remove the Auto Pay link before sending.`);
    }
    const ownerLast10 = String(eligibility.customer?.phone || '').replace(/\D/g, '').slice(-10);
    if (!ownerLast10 || ownerLast10 !== String(toLast10 || '')) {
      return refuse('This Auto Pay setup link belongs to a different customer — remove it before sending.');
    }
    if (trustedCustomerId !== undefined && String(trustedCustomerId || '') !== String(customerId)) {
      return refuse('Pick this customer from the search dropdown before sending an Auto Pay setup link — the text must ride their own SMS preferences.');
    }
  }
  return { present: true, ok: true, tokens: live.map((l) => l.token) };
}

// Immediate-send-only bearer links beyond Auto Pay (pre-push Codex P1 +
// GH Codex #3844 r1 P1): the composer's client-side refusal is transient
// state — a loaded draft or a scheduled body has none — and ONLY the
// immediate /sms path re-runs bearerLinkSendCheck at delivery (the
// scheduler and draft approve/revise dispatch straight into
// sendCustomerMessage). So every per-row bearer that seam judges is
// immediate-only: a contract signing link (time-boxed, rotates), a visit-
// lane card request, a payer statement pay link, and a prep page (bound to
// the recipient at /sms alone). Presence-only — the callers (/schedule-sms, draft
// approve/revise) refuse on any hit. Canonical portal host + path only,
// like the Auto Pay seam: a look-alike host is not a Waves bearer and is
// simply not this seam's business. Customer-kind /secure links are the
// Auto Pay seam's (its own presence check runs first at every caller).
// The fence reads presence under ANY_SCHEME — see canonicalPortalToken.
const ANY_SCHEME = { anyScheme: true };
const IMMEDIATE_ONLY_LINK_KINDS = [
  {
    // A project report page (WDO / specialty) shows the customer's name,
    // address and findings, can flip to a 402 payment hold, and only /sms
    // binds it to the recipient's account — same class as a service report.
    label: 'Project report',
    fragment: /\/report\/project\//i,
    token: (run, host) => canonicalPortalToken(run, host, PROJECT_REPORT_PATH_RE, ANY_SCHEME),
    applies: async () => true,
  },
  {
    label: 'Contract signing',
    fragment: /\/contract\//i,
    token: (run, host) => canonicalPortalToken(run, host, /^\/contract\/([A-Za-z0-9_-]{16,})$/i, ANY_SCHEME),
    applies: async () => true,
  },
  {
    // Every prep page — the page shows the customer's name and address and
    // only /sms binds it to the recipient (pre-push Codex P0), expiry or not.
    label: 'Prep guide',
    fragment: /\/prep\//i,
    token: (run, host) => canonicalPortalToken(run, host, /^\/prep\/([a-f0-9]{32})$/i, ANY_SCHEME),
    applies: async () => true,
  },
  {
    label: 'Statement pay',
    fragment: /\/pay\/statement\//i,
    token: (run, host) => canonicalPortalToken(run, host, /^\/pay\/statement\/([0-9a-f]{64})$/i, ANY_SCHEME),
    applies: async () => true,
  },
  {
    label: 'Card request',
    fragment: /\/secure\//i,
    token: (run, host) => canonicalSecureToken(run, host, ANY_SCHEME),
    applies: async (token) => {
      const row = await db('appointment_card_requests').where({ token }).first('kind');
      return row?.kind === 'visit';
    },
  },
];

// {short}/l/<code> runs → their short_codes rows. The composer inserts the
// branded short form of appointment and service-report links; the long
// forms are judged alongside. Codes are stored and resolved lower-case
// (public-shortlinks lowercases before its lookup), so a pasted upper- or
// mixed-case code — still a working link — is looked up the same way, or
// it would slip every fence and send-time check (GH Codex #3844 r5 P1).
// /l/:code is served on EVERY owned origin — the branded short host and the
// portal origin alike (server/index.js mounts /l with no host restriction) —
// so a branded URL rewritten onto the portal host is the same working link
// and is judged the same (GH Codex #3844 r6 P1) — and the long-form bearer
// paths the same way in reverse (r8 P1). Any other host is not ours.
function ownedPortalHosts() {
  return [...new Set([require('./short-url').shortLinkBaseUrl(), publicPortalUrl()].map((u) => new URL(u).host.toLowerCase()))];
}
async function shortCodeRows(runs, scheme = {}) {
  const shortRuns = linkRuns(runs, /\/l\//i);
  if (!shortRuns.length) return [];
  const hosts = ownedPortalHosts();
  const rows = [];
  for (const run of shortRuns) {
    const code = canonicalPortalToken(run, hosts, /^\/l\/([A-Za-z0-9_-]+)$/i, scheme);
    if (!code) continue;
    const row = await db('short_codes').where({ code: code.toLowerCase() }).first('code', 'kind', 'target_url', 'expires_at');
    const dest = row && shortRowDestination(row, hosts);
    // The seam refuses a plaintext run outright; the fence only needs presence.
    if (dest) rows.push({ code: row.code, expires_at: row.expires_at, plaintext: /^http:\/\//i.test(run), ...dest });
  }
  return rows;
}
// What /l/:code actually opens is its target_url (public-shortlinks 302s
// there); `kind` is an analytics classifier, so a legacy or misclassified
// code whose target is a protected page is judged by the target — the same
// token path as the long form (pre-push Codex P0). Metadata that claims a
// protected kind the target does not confirm fails closed: present to the
// fence, unverifiable (refused) at the send. The stored target is our own
// redirect, judged under ANY_SCHEME like the fence.
function shortRowDestination(row, hosts) {
  const target = String(row.target_url || '');
  const appointment = canonicalPortalToken(target, hosts, APPOINTMENT_TOKEN_RE, ANY_SCHEME);
  if (appointment) return { kind: 'appointment', token: appointment };
  const report = canonicalPortalToken(target, hosts, REPORT_TOKEN_RE, ANY_SCHEME);
  if (report) return { kind: 'service_report', token: report };
  if (['appointment', 'service_report'].includes(row.kind)) return { kind: row.kind, token: null };
  return null;
}
// /l/:code answers 410 past expires_at (public-shortlinks) — the same
// predicate, so an expired short bearer never rides an immediate send on
// the strength of an entity that still exists (pre-push Codex P1).
function expiredShortRow(row) {
  return Boolean(row.expires_at) && new Date(row.expires_at).getTime() < Date.now();
}

const APPOINTMENT_TOKEN_RE = /^\/appointment\/([A-Za-z0-9_-]{16,})$/i;
const REPORT_TOKEN_RE = /^\/report\/([A-Za-z0-9_-]{16,})$/i;
// /report/project/<vanity-slug>-<12-hex prefix> or /report/project/<32 hex>.
// The whole segment is taken and project-report-links.js
// extractProjectReportTokenLookup judges it — the viewer ignores the slug
// and accepts any characters ahead of the -<12 hex> suffix, so a narrower
// character class here would let a working vanity URL (`_` / `.` in the
// slug) slip the immediate-only fence and the account binding (GH Codex
// #3893 r5 P1). Judged before the service-report seam, which skips these runs.
const PROJECT_REPORT_PATH_RE = /^\/report\/project\/([^/]+)$/i;
const PROJECT_REPORT_RUN_RE = /\/report\/project\//i;

// Appointment page links (GH Codex #3844 r2 P1): every /appointment route
// 404s the moment GATE_APPOINTMENT_PAGE is off, and a queued message has no
// delivery-time re-check — so they are immediate-only, and /sms re-reads the
// gate. Service report links the same (pre-push Codex P0): only /sms binds
// the page to the recipient. Long form or the branded short form.
function appointmentLinkPresent(runs, hosts, shortRows, scheme = {}) {
  return linkRuns(runs, /\/appointment\//i).some((run) => canonicalPortalToken(run, hosts, APPOINTMENT_TOKEN_RE, scheme))
    || shortRows.some((row) => row.kind === 'appointment');
}
function reportLinkPresent(runs, hosts, shortRows, scheme = {}) {
  return linkRuns(runs, /\/report\//i).some((run) => canonicalPortalToken(run, hosts, REPORT_TOKEN_RE, scheme))
    || shortRows.some((row) => row.kind === 'service_report');
}

async function immediateOnlyLinkSendCheck(body) {
  const runs = decodedRuns(body);
  const hosts = ownedPortalHosts();
  for (const kind of IMMEDIATE_ONLY_LINK_KINDS) {
    for (const run of linkRuns(runs, kind.fragment)) {
      const token = kind.token(run, hosts);
      if (token && await kind.applies(token)) return { present: true, label: kind.label };
    }
  }
  const shortRows = await shortCodeRows(runs, ANY_SCHEME);
  if (appointmentLinkPresent(runs, hosts, shortRows, ANY_SCHEME)) return { present: true, label: 'Appointment page' };
  if (reportLinkPresent(runs, hosts, shortRows, ANY_SCHEME)) return { present: true, label: 'Service report' };
  return { present: false };
}

/**
 * Immediate-send seam for the other per-row bearers the composer inserts
 * (pre-push Codex P0 on the step-2 rows — the same protection the Auto Pay
 * seam gives /secure customer-kind links): a stale tab or a direct API
 * call must not deliver a signable contract or a payment-adjacent visit
 * card link to another phone, after rotation, or after expiry.
 *   contract  — /contract/<token>: the token's hash must match a live,
 *               unexpired, non-terminal customer_contracts row (a rotated
 *               or expired link matches nothing → refuse) — OR be the
 *               composer's own unwritten insert: the caller names the
 *               contract (`contractId`), the token VERIFIES as the
 *               server's mint for that contract, unexpired (HMAC over the
 *               id, a per-insert nonce and the expiry —
 *               composer-contract-token.js; a caller can never choose the
 *               bearer) and the contract's customer owns the recipient; the
 *               send then activates it under the row lock
 *               (activatePreparedShareLinks). Either way a marketing
 *               customer guide refuses — that document rides the Document
 *               Templates delivery's consent + opt-out footer, never a
 *               conversational text (GH Codex #3844 r4 P1).
 *   prep      — /prep/<token>: the public page's own predicates at the send
 *               (GH Codex #3844 r3 P2) — the token still resolves
 *               (unexpired) and its guide still has an active version.
 *   card      — /secure/<token> visit-lane rows (kind 'visit'; the Auto Pay
 *               seam judges kind 'customer'): status must still be pending,
 *               never texted, AND the canonical funnel
 *               (requestCardForAppointment, inline) must still answer this
 *               very token — gate, template, price, payer, hold lane,
 *               first-time customer, saved-card auto-secure all re-run at
 *               the send (GH Codex #3844 r2 P1).
 *   appointment — {short}/l/<code> (kind 'appointment') or /appointment/<token>:
 *               GATE_APPOINTMENT_PAGE must still be on (r2 P1), the visit
 *               must still resolve, and its customer must be on an account
 *               the recipient number is on file for (pre-push Codex P0).
 *   report    — {short}/l/<code> (kind 'service_report') or /report/<token>:
 *               the builder's own public predicate (completed v1 record
 *               with a token, typed delivery not suppressed) and the same
 *               account binding (pre-push Codex P0).
 *   statement — /pay/statement/<token>: GATE_PAYER_STATEMENTS still on (the
 *               pay page 404s the moment it is off — GH Codex #3844 r1 P1),
 *               a payable payer_statements row whose ACTIVE payer's AP phone
 *               is the recipient number (a statement is the payer's, never
 *               a customer's — no customer-id trust).
 * For prep, the row's customer must own the recipient number, and — when
 * the route trusts a customer id — be that customer. FAIL CLOSED on any
 * miss. { ok: true } when nothing applies or all checks out; `statements`
 * rides back with every verified statement id so a real send can stamp
 * finalized → sent (markStatementsSent); `cards` with every live visit-lane
 * link so the caller can CLAIM the card request's one-text-ever send before
 * dispatch (claimCardRequestSends) — a row already texted (sent_at) refuses
 * here; `contracts` with every verified signing link ({ id, tokenHash,
 * delivered }) so the caller can ACTIVATE an unwritten one before dispatch
 * (activatePreparedShareLinks). One function per link kind below (GH Codex
 * #3844 r5 P2); bearerLinkSendCheck is the composition.
 */
// One check per link kind (GH Codex #3844 r5 P2 — the seam was one
// 40-branch function); the shared parts are the parsed runs, the canonical
// host and the two binding rules below.
const refuseSend = (error) => ({ ok: false, error });
const NON_US_REFUSAL = 'Customer links only go to a US number — check the recipient before sending.';
const digitsLast10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);

// Per-ROW binding: the row's customer must own the recipient number and —
// when the route trusts a customer id — be that customer.
async function ownedByRecipient({ toLast10, trustedCustomerId }, customerId, label) {
  // A LIVE owner only (pre-push Codex P0): a deleted row's stale phone must
  // not authorize its page to whoever holds the number now.
  const owner = await db('customers').where({ id: customerId }).whereNull('deleted_at').first('id', 'phone');
  const ownerLast10 = digitsLast10(owner?.phone);
  if (!ownerLast10 || ownerLast10 !== toLast10) {
    return refuseSend(`This ${label} belongs to a different customer — remove it before sending.`);
  }
  // /sms passes null for "no customer selected" — that is no trusted id
  // (pre-push Codex P1 on r9): the row's owner rides on to the seam-wide
  // owner rule, which adopts a unique live owner and refuses an ambiguous one.
  if (trustedCustomerId != null && String(trustedCustomerId) !== String(customerId)) {
    return refuseSend(`Pick this customer from the search dropdown before sending a ${label}.`);
  }
  return null;
}

// Per-ACCOUNT binding for the account-scoped kinds (appointment page,
// service report — a household shares its visits and reports): the target's
// customer must be on an account the recipient number is on file for, and
// the trusted customer (when the route has one) on that account too. The
// client-side recipient-change strip is not authoritative (pre-push Codex
// P0). Returns the binder; the recipient's accounts are read once per send.
function recipientAccountBinder({ toLast10, trustedCustomerId }) {
  const accountKey = (c) => String(c.account_id || c.id);
  let recipientAccounts = null;
  return async (customerId, label) => {
    if (!recipientAccounts) {
      const rows = await db('customers')
        .whereNull('deleted_at')
        .whereRaw("right(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [toLast10])
        .select('id', 'account_id');
      recipientAccounts = new Set(rows.map(accountKey));
    }
    // A number on file for more than one ACCOUNT is ambiguous: with no
    // trusted customer naming the account, any of them would authorize a
    // bearer that belongs to the others (a stale or reassigned number). The
    // insert route 409s this same ambiguity; the send does too (GH Codex
    // #3844 r6 P1).
    if (!trustedCustomerId && recipientAccounts.size > 1) {
      return refuseSend(`That number is on file for more than one customer account — pick the customer from the search dropdown before sending a ${label}.`);
    }
    // The public appointment and report routes 404 once the owning customer
    // is deleted — a live sibling on the same account must not be texted a
    // dead bearer (pre-push Codex P1): the owner must be a LIVE row.
    const row = customerId ? await db('customers').where({ id: customerId }).whereNull('deleted_at').first('id', 'account_id') : null;
    if (!row) return refuseSend(`This ${label} no longer resolves — remove it and insert a fresh one.`);
    if (!recipientAccounts.has(accountKey(row))) {
      return refuseSend(`This ${label} belongs to a different customer — remove it before sending.`);
    }
    if (trustedCustomerId) {
      const trusted = await db('customers').where({ id: trustedCustomerId }).first('id', 'account_id');
      if (!trusted || accountKey(trusted) !== accountKey(row)) {
        return refuseSend(`This ${label} is not the selected customer's — remove it before sending.`);
      }
    }
    return null;
  };
}

// Prep guide pages: the page shows the customer's name and address and 404s
// once the token expires or its guide loses its active version — the public
// route's own predicates (resolvePrepSource, loadTemplateByKey), re-run at
// the send (GH Codex #3844 r3 P2).
// Every verified prep page's customer + pest identity lands in `preps` so a
// real send can write the tagger's dedupe marker (markPrepGuidesSent).
function guideLabelForTemplateKey(templateKey) {
  const { PREP_CONFIG } = require('./prep-guide-sender');
  return Object.values(PREP_CONFIG).find((c) => c.emailTemplateKey === templateKey)?.label || null;
}
// The guide the composer's prep line names for this page token, or null
// when the body carries no such line for it.
function namedGuideForToken(body, token) {
  const needle = `/prep/${String(token).toLowerCase()}`;
  for (const m of String(body || '').matchAll(PREP_LINE_RE)) {
    if (String(m[2]).toLowerCase().includes(needle)) return m[1].trim();
  }
  return null;
}

async function checkPrepLinks(ctx, preps) {
  const { PREP_CONFIG } = require('./prep-guide-sender');
  for (const run of linkRuns(ctx.runs, /\/prep\//i)) {
    const token = canonicalPortalToken(run, ctx.hosts, /^\/prep\/([a-f0-9]{32})$/i);
    if (!token) return refuseSend('A prep guide link in this message is not on the Waves portal — remove it before sending.');
    const source = await require('../routes/prep-public').resolvePrepSource(token);
    if (!source) return refuseSend('This prep guide link has expired — remove it and insert a fresh one.');
    const loaded = await require('./email-template-library').loadTemplateByKey(source.templateKey);
    if (!loaded?.activeVersion) return refuseSend('This prep guide has no active version in Email Templates — remove the prep link before sending.');
    // A page with no customer owner still shows a service address — nothing
    // can bind it to a recipient, so it never rides an SMS (pre-push Codex P0).
    if (!source.customerId) return refuseSend('This prep guide page has no customer on file — remove the prep link before sending.');
    // A scheduled-service prep page stays resolvable until its token
    // expires, so the visit's state is re-read NOW like the appointment
    // seam's: a visit underway, completed, cancelled or moved to a pending
    // rebook since the insert is not the "upcoming" treatment the text
    // names (GH Codex #3844 r14 P2). Project preps carry no visit.
    const serviceId = source.viewRow?.scheduled_service_id;
    if (serviceId) {
      const appointmentPublic = require('../routes/appointment-public');
      const visit = await db('scheduled_services').where({ id: serviceId })
        .first('id', 'customer_id', 'status', 'scheduled_date', 'window_start', 'window_end', 'source_action', 'customer_confirmed', 'visit_id');
      if (!visit || appointmentPublic.dispatchOwnedUnreviewed(visit) || (await appointmentPublic.pageStateForVisit(visit)).state !== 'upcoming') {
        return refuseSend('This prep guide\'s visit is no longer upcoming — remove the prep link and insert a fresh one.');
      }
    }
    const bad = await ownedByRecipient(ctx, source.customerId, 'prep guide link');
    if (bad) return bad;
    // The text must name the guide the page renders: the composer's line
    // carries the label the insert saw, and the page's key can differ
    // (a concurrent mint for another guide won the unkeyed visit; a fresh
    // claim released and re-claimed by another guide keeps the same token).
    // An operator-edited line that no longer matches the shape is not
    // checked — nothing to compare (GH Codex #3856 r27 P0).
    const named = namedGuideForToken(ctx.body, token);
    const rendersLabel = guideLabelForTemplateKey(source.templateKey);
    if (named && rendersLabel && named.toLowerCase() !== rendersLabel.toLowerCase()) {
      return refuseSend(`This prep guide link names ${named} but the page now shows the ${rendersLabel} guide — remove the link and insert a fresh one.`);
    }
    ctx.bearers += 1;
    // The marker is keyed by the tagger's pest type; a guide outside
    // PREP_CONFIG (a project prep page) has no replay guard to satisfy.
    const pestType = Object.keys(PREP_CONFIG).find((k) => PREP_CONFIG[k].emailTemplateKey === source.templateKey);
    // One entry per texted PAGE (visit): two links for different visits of
    // the same customer + pest each need their delivery stamp, or the
    // second visit's queued automation sends the guide again (pre-push
    // Codex P1 on 899bacd69). The interaction marker dedupes per customer +
    // pest in markPrepGuidesSent.
    const target = { customerId: source.customerId, pestType, serviceId: serviceId || null, templateKey: source.templateKey };
    if (pestType && !preps.some((p) => p.customerId === target.customerId && p.pestType === pestType && p.serviceId === target.serviceId)) {
      preps.push(target);
    }
  }
  return null;
}

// Statement pay links: the gate, a payable row, and the ACTIVE payer's AP
// phone as the recipient (a statement is the payer's, never a customer's).
// Every verified statement id lands in `statements`.
// Every live customer row whose phone is the recipient number (the seam-
// wide owner rule in bearerLinkSendCheck).
async function liveCustomersOnNumber(toLast10) {
  return db('customers')
    .whereNull('deleted_at')
    .whereRaw("right(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [toLast10])
    .select('id');
}

async function checkStatementLinks(ctx, statements) {
  for (const run of linkRuns(ctx.runs, /\/pay\/statement\//i)) {
    const token = canonicalPortalToken(run, ctx.hosts, /^\/pay\/statement\/([0-9a-f]{64})$/i);
    if (!token) return refuseSend('A statement link in this message is not on the Waves portal — remove it before sending.');
    if (!require('../config/feature-gates').isEnabled('payerStatements')) {
      return refuseSend('Payer statements are switched off (GATE_PAYER_STATEMENTS) — remove the statement link before sending.');
    }
    const { isPayableStatementStatus } = require('./payer-statement-settle');
    const stmt = await db('payer_statements').where({ token }).first('id', 'payer_id', 'status');
    if (!stmt || !isPayableStatementStatus(stmt.status)) {
      return refuseSend('This statement link is no longer payable — remove it and insert a fresh one.');
    }
    const payer = await db('payers').where({ id: stmt.payer_id, active: true }).first('id', 'ap_phone');
    if (!payer || !digitsLast10(payer.ap_phone) || digitsLast10(payer.ap_phone) !== ctx.toLast10) {
      return refuseSend("This statement link only goes to the payer's AP phone on file — remove it before sending.");
    }
    ctx.bearers += 1;
    if (!statements.includes(stmt.id)) statements.push(stmt.id);
  }
  return null;
}

// Appointment pages (long form by reschedule_token, or the branded short
// form): the visit must still resolve and bind to the recipient's account.
async function checkAppointmentLinks(ctx, shortRows, onRecipientAccount) {
  // Liveness NOW, not at the insert: the state the page would render —
  // grouped (a sibling in pending rebook / underway, or a membership that
  // no longer forms one stop, fails closed — GH Codex #3844 r13 P1) or the
  // row's own — plus the dispatch-owned-pending hide every visit-backed
  // link shares (r5 P1). A visit cancelled, completed, moved to a pending
  // rebook, elapsed, underway, or still unreviewed since the link was
  // inserted is not the upcoming appointment the text promises.
  const appointmentPublic = require('../routes/appointment-public');
  const visitById = async (where) => db('scheduled_services').where(where)
    .first('id', 'customer_id', 'status', 'scheduled_date', 'window_start', 'window_end', 'source_action', 'customer_confirmed', 'visit_id');
  const bind = async (visit) => {
    if (!visit) return refuseSend('This appointment link no longer resolves — remove it and insert a fresh one.');
    if (appointmentPublic.dispatchOwnedUnreviewed(visit) || (await appointmentPublic.pageStateForVisit(visit)).state !== 'upcoming') {
      return refuseSend('This appointment is no longer upcoming — remove the appointment link and insert a fresh one.');
    }
    const bad = await onRecipientAccount(visit.customer_id, 'appointment link');
    if (!bad) ctx.bearers += 1;
    return bad;
  };
  for (const run of linkRuns(ctx.runs, /\/appointment\//i)) {
    const token = canonicalPortalToken(run, ctx.hosts, APPOINTMENT_TOKEN_RE);
    if (!token) return refuseSend('An appointment link in this message is not on the Waves portal — remove it before sending.');
    const bad = await bind(await visitById({ reschedule_token: token }));
    if (bad) return bad;
  }
  for (const row of shortRows.filter((r) => r.kind === 'appointment')) {
    if (expiredShortRow(row)) return refuseSend('This appointment link has expired — remove it and insert a fresh one.');
    if (!row.token) return refuseSend('This appointment short link does not open an appointment page — remove it and insert a fresh one.');
    const bad = await bind(await visitById({ reschedule_token: row.token }));
    if (bad) return bad;
  }
  return null;
}

// Service reports (long form by report_view_token, or the short form): the
// builder's own public predicate re-run, then the account binding.
async function checkReportLinks(ctx, shortRows, onRecipientAccount) {
  const { suppressedTypedReport } = require('../routes/reports-public');
  const publicReport = async (where) => {
    const record = await db('service_records')
      .where(where)
      .where(PUBLIC_REPORT_WHERE)
      .whereNotNull('report_view_token')
      .first('id', 'customer_id', 'structured_notes');
    return record && !suppressedTypedReport(record) ? record : null;
  };
  const bind = async (record) => {
    if (!record) return refuseSend('This service report is no longer viewable — remove the link before sending.');
    const bad = await onRecipientAccount(record.customer_id, 'service report link');
    if (!bad) ctx.bearers += 1;
    return bad;
  };
  // /report/project/… runs are the project-report seam's (checkProjectReportLinks).
  for (const run of linkRuns(ctx.runs, /\/report\//i).filter((run) => !PROJECT_REPORT_RUN_RE.test(run))) {
    const token = canonicalPortalToken(run, ctx.hosts, REPORT_TOKEN_RE);
    if (!token) return refuseSend('A service report link in this message is not on the Waves portal — remove it before sending.');
    const bad = await bind(await publicReport({ report_view_token: token }));
    if (bad) return bad;
  }
  for (const row of shortRows.filter((r) => r.kind === 'service_report')) {
    if (expiredShortRow(row)) return refuseSend('This service report link has expired — remove it and insert a fresh one.');
    if (!row.token) return refuseSend('This service report short link does not open a report — remove it and insert a fresh one.');
    const bad = await bind(await publicReport({ report_view_token: row.token }));
    if (bad) return bad;
  }
  return null;
}

// Project reports (WDO / specialty; long vanity or full-token form): the
// public viewer's own lookup (extractProjectReportTokenLookup — a 12-hex
// prefix must resolve to exactly one project, as /data does), never a
// payment-held report (the page answers 402 with a pay card, not the
// report), then the account binding — a household shares its projects.
async function checkProjectReportLinks(ctx, onRecipientAccount, projectReports) {
  for (const run of linkRuns(ctx.runs, PROJECT_REPORT_RUN_RE)) {
    const segment = canonicalPortalToken(run, ctx.hosts, PROJECT_REPORT_PATH_RE);
    const lookup = segment && require('./project-report-links').extractProjectReportTokenLookup(segment);
    if (!lookup) return refuseSend('A project report link in this message is not on the Waves portal — remove it before sending.');
    const project = await linkableProjectReport(lookup);
    // Issued only (the builder's own predicate — status AND sent_at): a
    // /send that failed after stamping report_token leaves a draft, and a
    // closed-but-never-sent project keeps a token too; texting either would
    // bypass the project send flow's readiness and official-document checks
    // (GH Codex #3893 r1 + r3 P1).
    if (!issuedProjectReport(project)) {
      return refuseSend('This project report is no longer viewable — remove the link before sending.');
    }
    if (PROJECT_REPORT_HELD_STATUSES.includes(String(project.report_hold_status || ''))) {
      return refuseSend('This project report is on a payment hold — the page shows a pay card, not the report. Remove the link before sending.');
    }
    const bad = await onRecipientAccount(project.customer_id, 'project report link');
    if (bad) return bad;
    ctx.bearers += 1;
    // The send flow's delivery claim is taken by the caller BEFORE dispatch
    // (claimProjectReportSends), keyed to the delivery state seen here.
    projectReports.push({ id: project.id, deliveryStatus: project.delivery_status || null });
  }
  return null;
}

// The account-scoped kinds together: the appointment gate is re-read at the
// send (every /appointment route 404s the moment it is off — r2 P1), then
// each kind binds to the recipient's account.
async function checkAccountBoundLinks(ctx, projectReports) {
  // ANY_SCHEME here too: an http://<owned>/l/<code> run must not vanish from
  // the seam (nothing later sees the /l/ occurrence) — it is judged, and its
  // plaintext scheme refused like the long forms' (GH Codex #3844 r12 P1).
  const shortRows = await shortCodeRows(ctx.runs, ANY_SCHEME);
  if (shortRows.some((row) => row.plaintext)) {
    return refuseSend('A short link in this message uses http:// — remove it and insert a fresh one.');
  }
  if (appointmentLinkPresent(ctx.runs, ctx.hosts, shortRows) && process.env.GATE_APPOINTMENT_PAGE !== 'true') {
    return refuseSend('Appointment pages are switched off (GATE_APPOINTMENT_PAGE) — remove the appointment link before sending.');
  }
  const onRecipientAccount = recipientAccountBinder(ctx);
  return (await checkAppointmentLinks(ctx, shortRows, onRecipientAccount))
    || (await checkReportLinks(ctx, shortRows, onRecipientAccount))
    || checkProjectReportLinks(ctx, onRecipientAccount, projectReports);
}

// Contract signing links: a stored hash (a link the customer may hold —
// pasted from the Contracts page) must be live and non-terminal; otherwise
// the token must be the composer's own unwritten insert — the caller names
// the contract (`contractId`) and the token VERIFIES as the server's mint
// for it (HMAC over the id, a per-insert nonce and the expiry, 12h — the
// caller never chooses the bearer; pre-push Codex P0), on a row a fresh link
// may be written over (the writer's own rule — an expired document request
// re-opens, other expired contracts do not; pre-push Codex P1).
// Delivered-live is judged under the row lock at activation. Either way a
// marketing customer guide refuses (GH Codex #3844 r4 P1). Every verified
// link lands in `contracts` as { id, tokenHash, delivered }.
async function checkContractLinks(ctx, contracts) {
  const NOT_LIVE = 'This contract signing link is expired or no longer live — remove it and insert a fresh one.';
  const terminal = (status) => ['signed', 'cancelled', 'voided', 'expired'].includes(String(status || '').toLowerCase());
  for (const run of linkRuns(ctx.runs, /\/contract\//i)) {
    const token = canonicalPortalToken(run, ctx.hosts, /^\/contract\/([A-Za-z0-9_-]{16,})$/i);
    if (!token) return refuseSend('A contract link in this message is not on the Waves portal — remove it before sending.');
    const tokenHash = require('./contracts').hashContractToken(token);
    const row = await db('customer_contracts')
      .where({ share_token_hash: tokenHash })
      .first('id', 'customer_id', 'status', 'share_token_expires_at', ...CONTRACT_GUIDE_COLUMNS, ...CONTRACT_SIGN_COLUMNS);
    if (row) {
      const dead = terminal(row.status)
        || (row.share_token_expires_at && new Date(row.share_token_expires_at).getTime() <= Date.now());
      if (dead) return refuseSend(NOT_LIVE);
      if (await isMarketingGuideContract(row)) return refuseSend(MARKETING_GUIDE_REFUSAL);
      const bad = (await ownedByRecipient(ctx, row.customer_id, 'contract signing link')) || (await unsignableContractRefusal(row));
      if (bad) return bad;
      ctx.bearers += 1;
      if (!contracts.some((c) => c.tokenHash === tokenHash)) contracts.push({ id: row.id, tokenHash, delivered: true });
      continue;
    }
    if (!ctx.contractId || !require('../utils/composer-contract-token').verifyComposerContractToken(ctx.contractId, token)) {
      return refuseSend(NOT_LIVE);
    }
    const contract = await db('customer_contracts').where({ id: ctx.contractId }).first('id', 'customer_id', 'status', ...CONTRACT_GUIDE_COLUMNS, ...CONTRACT_SIGN_COLUMNS);
    const { shareLinkWritableStatuses } = require('../routes/admin-contracts');
    if (!contract || !shareLinkWritableStatuses(contract).includes(String(contract.status || '').toLowerCase())) {
      return refuseSend(NOT_LIVE);
    }
    if (await isMarketingGuideContract(contract)) return refuseSend(MARKETING_GUIDE_REFUSAL);
    const bad = (await ownedByRecipient(ctx, contract.customer_id, 'contract signing link')) || (await unsignableContractRefusal(contract));
    if (bad) return bad;
    ctx.bearers += 1;
    if (!contracts.some((c) => c.tokenHash === tokenHash)) contracts.push({ id: contract.id, tokenHash, delivered: false });
  }
  return null;
}

// Visit-lane card request links (kind 'visit'; the Auto Pay seam judges kind
// 'customer'): status must still be pending, never texted, owned by the
// recipient, AND the canonical funnel (requestCardForAppointment, inline)
// must still answer this very token — gate, template, price, payer, hold
// lane, first-time customer, saved-card auto-secure all re-run at the send
// (GH Codex #3844 r2 P1). Every live link lands in `cards` for the claim.
async function checkCardLinks(ctx, cards) {
  for (const run of secureLinkRuns(ctx.runs)) {
    const token = canonicalSecureToken(run, ctx.hosts);
    // Refused HERE too (GH Codex #3851 r2 P1): the Auto Pay seam refuses a
    // non-canonical /secure run at every caller, but this seam never leans
    // on that order — an http:// or look-alike card link is not a bearer
    // this send may carry.
    if (!token) return refuseSend('A /secure link in this message is not on the Waves portal — remove it before sending.');
    const row = await db('appointment_card_requests').where({ token }).first('id', 'kind', 'status', 'customer_id', 'scheduled_service_id', 'sent_at', 'selected_plan', 'annual_prepay_term_id');
    if (!row || row.kind !== 'visit') continue; // unknown → the Auto Pay seam's verdict; customer-kind → its own
    if (row.status !== 'pending') return refuseSend('This card request link is no longer live — remove it and insert a fresh one.');
    if (row.sent_at) return refuseSend('This card request was already texted — the customer gets one card request per appointment. Remove the link before sending.');
    const bad = await ownedByRecipient(ctx, row.customer_id, 'card request link');
    if (bad) return bad;
    ctx.bearers += 1;
    // The destination rule BEFORE the funnel (pre-push Codex P1): the
    // funnel is stateful — it can auto-secure the visit from a saved card —
    // and a non-US number sharing the owner's last ten must not drive it.
    if (!ctx.usDestination) return refuseSend(NON_US_REFUSAL);
    // auto_secured = a consented saved card covered the ask meanwhile (the
    // funnel secured the visit, as any trigger would) — nothing to ask.
    const funnel = await require('./appointment-card-request').requestCardForAppointment({
      scheduledServiceId: row.scheduled_service_id, trigger: 'admin', delivery: 'inline',
    });
    if (funnel?.action === 'auto_secured') {
      return refuseSend('A consented card already secures this appointment — remove the card request link before sending.');
    }
    if (funnel?.action !== 'link_created' || !String(funnel.secureUrl || '').endsWith(`/secure/${token}`)) {
      return refuseSend(`${cardRequestSkipReason(funnel?.reason)} — remove the card request link before sending.`);
    }
    if (!cards.some((c) => c.token === token)) {
      // The email twin follows the copy variant the funnel would send for
      // THIS request (GH Codex #3851 r2 P1) — the same rule that picked the
      // inserted text, re-read at the send.
      const planChoice = !!(await cardRequestPlanVariant(row.scheduled_service_id, row, { secure_link: funnel.secureUrl }));
      cards.push({ token, scheduledServiceId: row.scheduled_service_id, planChoice });
    }
  }
  return null;
}

// `usDestination` (default true): the route says whether `to` normalizes to a
// US number. Every check here binds by the LAST TEN digits, so a non-US
// E.164 destination whose last ten equal a customer's or payer's US number
// would pass ownership and even adopt that customer while the provider
// texts the other country (GH Codex #3844 r10 P1) — a bearer never goes to
// a non-US destination.
async function bearerLinkSendCheck(body, toLast10, { trustedCustomerId, usDestination = true, contractId = null } = {}) {
  const ctx = {
    runs: decodedRuns(body),
    body,
    hosts: ownedPortalHosts(),
    toLast10: String(toLast10 || ''),
    trustedCustomerId,
    usDestination,
    bearers: 0, // verified bearers seen — the owner rule below applies to any
    contractId,
  };
  const cards = [];
  const contracts = [];
  const statements = [];
  const preps = [];
  const projectReports = [];
  const checks = [
    () => checkContractLinks(ctx, contracts),
    () => checkPrepLinks(ctx, preps),
    () => checkStatementLinks(ctx, statements),
    () => checkAccountBoundLinks(ctx, projectReports),
    () => checkCardLinks(ctx, cards),
  ];
  for (const check of checks) {
    const refusal = await check();
    if (refusal) return refusal;
  }
  if (ctx.bearers && !ctx.usDestination) return refuseSend(NON_US_REFUSAL);
  const out = {
    ok: true,
    ...(cards.length ? { cards } : {}),
    ...(contracts.length ? { contracts } : {}),
    ...(statements.length ? { statements } : {}),
    ...(preps.length ? { preps } : {}),
    ...(projectReports.length ? { projectReports } : {}),
  };
  // Owner rule for EVERY bearer send (GH Codex #3844 r7 + r9 P1s): the text
  // goes to a phone that may be a customer's, and /sms applies that
  // customer's consent policy only when it trusts a customer id — with none
  // (a pasted URL, a direct /sms call, a same-account pair sharing the
  // number) the send would fall to the unverified-lead policy, whose exact-
  // phone consent read can miss a differently formatted number and deliver
  // past a row's sms_enabled=false. Exactly one live row on the number
  // rides back as `customerId` for /sms to adopt as the trusted customer;
  // several refuse (never an arbitrary pick — the insert route 409s the
  // same); none is a non-customer number (a payer's AP phone) and stays a lead.
  if (ctx.bearers && !ctx.trustedCustomerId) {
    const rows = await liveCustomersOnNumber(ctx.toLast10);
    if (rows.length > 1) {
      return refuseSend('That number is on file for more than one customer — pick the customer from the search dropdown before sending a customer link.');
    }
    if (rows.length === 1) out.customerId = rows[0].id;
  }
  return out;
}

/**
 * Prep links only, re-run INSIDE the manual sender's per-customer
 * `prep-send:<customer>` lock immediately before dispatch: bearerLinkSendCheck
 * ran before the lock, so a manual send's provisional page it verified can
 * have failed and been released (prep_template_key cleared → 404) between
 * that read and the lock — serialization alone does not protect the earlier
 * read (pre-push Codex P1 on 7f82e7564). Same predicates as the pre-lock
 * check (checkPrepLinks); the caller reports a refusal as a not-sent result.
 */
async function recheckPrepLinks(body, toLast10, { trustedCustomerId, usDestination = true } = {}) {
  const ctx = {
    runs: decodedRuns(body),
    body,
    hosts: ownedPortalHosts(),
    toLast10: String(toLast10 || ''),
    trustedCustomerId,
    usDestination,
    bearers: 0,
    contractId: null,
  };
  // The entries resolved HERE are the ones the post-send bookkeeping must
  // use: a provisional page released and re-claimed for another guide
  // between the checks renders a different key now, and stamping / settling
  // the pre-lock guide would record the wrong pest as delivered (pre-push
  // Codex P1 on e8b68e9cc).
  const preps = [];
  const refusal = await checkPrepLinks(ctx, preps);
  return refusal || { ok: true, preps };
}

/**
 * A REAL provider send of a composer prep link is a delivered prep text:
 * write the SAME customer_interactions marker the appointment tagger's
 * replay guard (hasSentPrepSms — sms_outbound + "<pestType> prep info
 * sent") looks for, as the manual Send prep guide path does, so a later
 * onServiceScheduled / regenerate-brief replay does not text prep again
 * (GH Codex #3844 r8 P2). Fail-soft: the text already went out.
 */
async function markPrepGuidesSent(preps, actorId) {
  const { settleHeldEnrollment } = require('./prep-guide-sender');
  const marked = new Set(); // customer + pest — one replay marker per pair
  for (const { customerId, pestType, serviceId, templateKey } of preps) {
    // The visit-level delivery fence FIRST: a texted page is a delivered
    // page — prep_sent_at is what every release predicate (the manual
    // sender's releasePrepPage, the executor's releaseFreshPrepClaim) fences
    // on, so an automation whose fresh claim this text rode cannot hand the
    // key back after a blocked or failed send and 404 a URL the customer
    // holds (pre-push Codex P1 on d5c33f299). Conditional on the key that
    // rendered; a lost stamp never fails a text that already left.
    if (serviceId) {
      try {
        await db('scheduled_services')
          .where({ id: serviceId, prep_template_key: templateKey })
          .whereNull('prep_sent_at')
          .update({ prep_sent_at: db.fn.now() });
      } catch (stampErr) {
        logger.warn(`[composer-customer-links] prep_sent_at stamp failed for service ${serviceId}: ${stampErr.message}`);
      }
    }
    if (marked.has(`${customerId}:${pestType}`)) continue;
    marked.add(`${customerId}:${pestType}`);
    // A sequence-backed guide (flea / bed bug / cockroach) texted here is the
    // prep delivery: the customer's live enrolment still awaiting its prep
    // step is settled, as the manual sender does, or the runner — which
    // consults neither the stamp above nor the marker — emails the same
    // prep on its next tick (GH Codex #3856 r30 P1). Fail-soft inside, and
    // BEFORE the audit marker: the duplicate-send fence must not depend on
    // a bookkeeping insert succeeding (GH Codex #3856 r31 P1).
    await settleHeldEnrollment(customerId, templateKey);
    try {
      await db('customer_interactions').insert({
        customer_id: customerId,
        interaction_type: 'sms_outbound',
        admin_user_id: actorId || null,
        subject: `${pestType} prep info sent`,
        body: 'Prep SMS sent via the Communications composer (prep guide link).',
      });
    } catch (markErr) {
      // The text already left; a lost marker only costs the tagger's replay
      // guard for this pest, and the next prep in the batch still settles.
      logger.warn(`[composer-customer-links] prep replay marker failed for customer ${customerId} (${pestType}): ${markErr.message}`);
    }
  }
}

/**
 * A REAL provider send of a composer statement link is the statement's
 * first delivery when it was still 'finalized' — stamp finalized → sent
 * through the email delivery's own writer so the viewed/dunning lifecycle
 * picks it up (GH Codex #3844 r2 P1). Value-guarded there (never
 * downgrades, never re-stamps a resend).
 */
async function markStatementsSent(statementIds) {
  const { markStatementSent } = require('./payer-statement-email');
  for (const id of statementIds) await markStatementSent(id);
}

/**
 * The composer's card-request send claim (GH Codex #3844 r1 P1 + pre-push
 * P1): requestCardForAppointment's inline delivery deliberately leaves the
 * one-text-ever markers unconsumed (the /book wizard's customer may
 * abandon the step), so the operator's /sms send has to run the SAME
 * claim mechanics the service's SMS path does — or two tabs, a resend, or
 * a later previsit/office trigger would text the same payment-adjacent
 * link again.
 *   claimCardRequestSends — BEFORE dispatch: the service's own claim
 *     (claimCardLinkSend — NULL → stamp, else the stale-claim lease
 *     adoption for a worker that died mid-send). A lost claim means
 *     another send owns this visit right now, or one already went out;
 *     every claim this call won is handed back and the send refuses.
 *   releaseCardRequestSends — the text never left (blocked, failed,
 *     suppressed, or a throw with no provider acceptance): value-guarded
 *     release so only THIS claim is cleared.
 *   markCardRequestSends — a REAL provider send: the service's own
 *     finalizer (markCardLinkSendOutcome — bounded retries, and a marker
 *     that cannot land PARKS the claim + alerts the office) stamps the
 *     request row's sent_at, the durable outcome marker the stale-claim
 *     lease reads, then starts the invite's EMAIL twin exactly as the
 *     service does after its own text (owner delivery rule: both
 *     channels; GH Codex #3844 r5 P1) — the composer inserts the base
 *     template copy, so the email follows the base variant. Returns
 *     false when any marker did not land. { emailTwin: false } = the
 *     AMBIGUOUS provider outcome: the marker lands (the claim stays
 *     consumed), no twin — nothing is known to have left.
 */
async function claimCardRequestSends(cards) {
  const { claimCardLinkSend } = require('./appointment-card-request');
  const stamp = new Date();
  const won = [];
  const CLAIMED = 'This card request is already being sent, or was already texted — the customer gets one card request per appointment. Remove the link before sending.';
  for (const card of cards) {
    if (!await claimCardLinkSend(card.scheduledServiceId, stamp, card.token)) {
      await releaseCardRequestSends({ stamp, cards: won });
      return { ok: false, error: CLAIMED };
    }
    won.push(card);
    // The claim stamps the VISIT; the request row is re-read under it
    // (pre-push Codex P1): a capture completed, a row rotated to another
    // token, or a text that went out between the seam's check and this
    // claim would otherwise ride a stale payment-adjacent link out under a
    // claim nobody finalizes.
    let row;
    try {
      row = await db('appointment_card_requests')
        .where({ scheduled_service_id: card.scheduledServiceId })
        .first('status', 'token', 'sent_at');
    } catch (err) {
      // A read that fails after the stamp landed: hand every claim back
      // before surfacing, or the visit sits claimed with nobody to finalize
      // it until the stale lease (GH Codex #3851 r3 P2).
      await releaseCardRequestSends({ stamp, cards: won });
      throw err;
    }
    if (!row || row.status !== 'pending' || row.sent_at || row.token !== card.token) {
      await releaseCardRequestSends({ stamp, cards: won });
      return { ok: false, error: row?.sent_at ? CLAIMED : 'This card request link is no longer live — remove it and insert a fresh one.' };
    }
  }
  return { ok: true, claim: { stamp, cards: won } };
}

async function releaseCardRequestSends(claim) {
  for (const { scheduledServiceId } of claim.cards) {
    await db('scheduled_services')
      .where({ id: scheduledServiceId, card_link_sent_at: claim.stamp })
      .update({ card_link_sent_at: null, updated_at: new Date() });
  }
}

async function markCardRequestSends(claim, { emailTwin = true } = {}) {
  const card = require('./appointment-card-request');
  let allMarked = true;
  // Every claimed visit finalizes on its own (GH Codex #3851 r1 P1): the
  // text already carried every link, so a marker that throws — or the
  // best-effort visit read for one email twin — must never leave a LATER
  // claim with neither sent_at nor a park, where the stale-claim lease
  // would let a later trigger text the same link again.
  for (const { scheduledServiceId } of claim.cards) {
    try {
      if (!await card.markCardLinkSendOutcome(scheduledServiceId, claim.stamp)) allMarked = false;
    } catch (err) {
      allMarked = false;
      logger.warn(`[composer-links] card request sent marker threw for visit ${scheduledServiceId}: ${err.message}`);
    }
  }
  if (!emailTwin) return allMarked;
  for (const { scheduledServiceId, token, planChoice } of claim.cards) {
    try {
      const visit = await db('scheduled_services')
        .where({ id: scheduledServiceId })
        .first('id', 'customer_id', 'service_type', 'scheduled_date');
      if (visit) card.startInvitationEmailLeg({ visit, secureUrl: `${publicPortalUrl()}/secure/${token}`, planChoice: !!planChoice });
    } catch (err) {
      logger.warn(`[composer-links] card request email twin did not start for visit ${scheduledServiceId}: ${err.message}`);
    }
  }
  return allMarked;
}

// The funnel's own copy-variant rule (requestCardForAppointment's SMS path:
// usedTemplateKey === PLAN_TEMPLATE_KEY): the plan-choice copy only when the
// link will open the plan picker for THIS request AND the variant template
// is active — else null, and the base copy stands. One rule for the inserted
// text and for the email twin's variant at the send (GH Codex #3851 r2 P1).
async function cardRequestPlanVariant(visitId, request, vars) {
  const card = require('./appointment-card-request');
  if (!await card.planInviteApplies(visitId, request || null)) return null;
  return card.renderTemplate({ first_name: 'there', service_type: 'service', date_line: '', cancel_fee_line: '', ...vars }, card.PLAN_TEMPLATE_KEY);
}

// ---------------------------------------------------------------------------
// Step 2 rows (Adam's rulings 2026-09-03): appointment page, card request,
// prep guide, latest service report, contract signing, payer statement.
// Every builder is MINT-ONLY — the operator's composer send is the only
// delivery — and each one is dark wherever its owning system's gate is off
// (the reason names the gate). The visit-anchored builders take the row the
// route already picked (soonestUpcomingVisit — the reschedule link's pick)
// so there is exactly one "next visit" definition across the sheet.
// ---------------------------------------------------------------------------

// Date-only columns (scheduled_date, service_date) read as their calendar
// day through the canonical helper — never via toISOString, which would
// shift an Eastern wall-clock timestamp a day (pre-push Codex P1).
const dateOnly = (value) => (value ? etCalendarDayOf(value) : null);

const NO_UPCOMING_VISIT = 'No upcoming appointment for this customer';

/**
 * Appointment page — delegates to appointment-link's builder (the one the
 * confirmation and 24h reminder texts use): reuses reschedule_token, one
 * short code per visit, mints nothing while GATE_APPOINTMENT_PAGE is off.
 */
async function buildAppointmentPageLink(visit) {
  if (!visit) return { url: null, line: '', reason: NO_UPCOMING_VISIT };
  if (process.env.GATE_APPOINTMENT_PAGE !== 'true') {
    return { url: null, line: '', reason: 'Appointment pages are switched off (GATE_APPOINTMENT_PAGE)' };
  }
  const { buildAppointmentLink } = require('./appointment-link');
  const { url, line } = await buildAppointmentLink(visit.id, { customerId: visit.customer_id });
  if (!url) return { url: null, line: '', reason: 'This appointment has no appointment link yet' };
  return {
    url,
    line,
    // Immediate sends only — the gate is re-read on /sms alone (r2 P1).
    immediateOnly: true,
    appointment: { id: visit.id, scheduledDate: dateOnly(visit.scheduled_date), serviceType: visit.service_type || null },
  };
}

// requestCardForAppointment's skip vocabulary, phrased for the composer.
// Unknown reasons stay visible (never pretend a link exists).
const CARD_REQUEST_SKIP_REASONS = {
  gate_off: 'Appointment card requests are switched off (APPOINTMENT_CARD_REQUEST)',
  visit_not_found: 'That appointment could not be found',
  no_customer: 'That appointment has no customer on it',
  visit_in_past: 'That appointment is in the past',
  unpriced_visit: 'This appointment has no price yet — price it before asking for a card',
  zero_price_visit: 'This appointment is $0 — nothing to secure with a card',
  template_inactive: 'The card request text is inactive in Templates — activate it before texting a card link',
  payer_billed: 'This customer bills to a third-party payer — no card request',
  payer_check_uncertain: 'Could not confirm who this customer bills to — try again in a moment',
  card_hold_lane: 'This appointment already holds a card through its estimate',
  hold_lookup_failed: 'Could not check the card-hold lane — try again in a moment',
  existing_customer: 'Card requests are for first-time customers only — this customer has completed history',
  existing_recurring_customer: 'Card requests are for first-time customers only — this customer is already on a plan',
  existing_plan_member: 'Card requests are for first-time customers only — this customer is already on a plan',
  request_exists: 'A card request for this appointment was already completed',
  rodent_setup_staff_review: 'This rodent setup needs staff review before a card request',
  commercial_rodent_setup_staff_review: 'Commercial rodent setups are billed by staff — no card request',
  rodent_setup_undisclosed: 'This rodent setup has no disclosure yet — no card request',
};

function cardRequestSkipReason(reason) {
  const key = String(reason || '');
  if (CARD_REQUEST_SKIP_REASONS[key]) return CARD_REQUEST_SKIP_REASONS[key];
  if (key.startsWith('visit_not_live')) return 'This appointment is not confirmed yet — confirm it before asking for a card';
  return `Could not build a card request link (${key || 'unknown'})`;
}

/**
 * Card request (the "secure your appointment" /secure/:token visit lane) —
 * delegates to requestCardForAppointment with inline delivery: every gate
 * (env + template levers, priced visit, first-time customer, payer
 * exemption, hold-rail exclusion, saved-card auto-secure, dedup) stays in
 * that one entry point; nothing is texted. The inserted copy is the
 * reviewed secure_appointment_card SMS template rendered with the real
 * link (same rule as Auto Pay: never a second hand-written copy).
 */
async function buildCardRequestLink(visit) {
  if (!visit) return { url: null, line: '', reason: NO_UPCOMING_VISIT };
  const card = require('./appointment-card-request');
  const result = await card.requestCardForAppointment({ scheduledServiceId: visit.id, trigger: 'admin', delivery: 'inline' });
  if (result?.action === 'auto_secured') return { url: null, line: '', autoSecured: true };
  if (result?.action !== 'link_created' || !result.secureUrl) {
    return { url: null, line: '', reason: cardRequestSkipReason(result?.reason) };
  }
  const profile = await db('customers').where({ id: visit.customer_id }).first('first_name');
  const templateVars = {
    first_name: profile?.first_name || 'there',
    service_type: visit.service_type || 'service',
    date_line: card.dateLineFor(visit.scheduled_date),
    secure_link: result.secureUrl,
    cancel_fee_line: card.cancelFeeLine(),
  };
  // The base render is the live kill-switch check, exactly as in the
  // funnel; only then the plan-choice overlay, honoring the EXISTING
  // request's own selection (a reused /book link that already picked
  // prepay opens the prepay_selected page — the base "only charged after
  // service" copy is false there; GH Codex #3851 r2 P1).
  const base = await card.renderTemplate(templateVars);
  if (!base) return { url: null, line: '', reason: CARD_REQUEST_SKIP_REASONS.template_inactive };
  const request = await db('appointment_card_requests')
    .where({ token: result.secureUrl.slice(result.secureUrl.lastIndexOf('/') + 1) })
    .first('id', 'status', 'token', 'selected_plan', 'annual_prepay_term_id');
  const body = (await cardRequestPlanVariant(visit.id, request, templateVars)) || base;
  const { stripPortalUrlScheme } = require('../routes/admin-sms-templates');
  if (!String(body).includes(stripPortalUrlScheme(result.secureUrl))) {
    return { url: null, line: '', reason: 'The card request text in Templates has no {secure_link} placeholder — add it before texting a card link' };
  }
  return {
    url: result.secureUrl,
    line: `${String(body).replace(/\s*\n+\s*/g, ' ').trim()}\n\n`,
    standalone: true,
    // Immediate sends only — the delivery seam that consumes the one-text
    // claim runs on /sms alone (immediateOnlyLinkSendCheck is the server fence).
    immediateOnly: true,
    appointment: { id: visit.id, scheduledDate: dateOnly(visit.scheduled_date), serviceType: visit.service_type || null },
  };
}

/**
 * Prep guide — insert-only: mints (or reuses) the /prep/:token page for the
 * soonest upcoming visit of a prep-supported family on the recipient's OWN
 * row (the route passes the phone owner only — the page shows that
 * customer's name and address, and the /sms send requires the recipient to
 * own it), using the prep sender's own visit pick and token mint. The tracker's
 * prep_sent_at proof is NOT stamped: that marks a confirmed guide-email
 * delivery, and this text is the operator's own send. Raw URL — the prep
 * sender never shortens prep links either.
 */
// The composer's prep line. The send fence (checkPrepLinks) parses this
// exact shape back out of the body: the guide it NAMES must be the guide
// the page RENDERS.
const PREP_LINE_RE = /prep checklist for the upcoming (.+?) is here: (\S+)/gi;
function prepGuideLine(label, url) {
  return `Your prep checklist for the upcoming ${label} is here: ${url}\n\n`;
}

async function buildPrepGuideLink(customerIds) {
  const { PREP_CONFIG, nextUpcomingVisit } = require('./prep-guide-sender');
  const { ensureServicePrepToken } = require('./project-email');
  // Soonest across families by date THEN arrival window (two same-day
  // visits of different families must not pick arbitrarily), id last.
  // A NULL window sorts LAST ('~' > any digit), as each family's SQL
  // orders it — a windowless same-day visit must not beat a timed one
  // (GH Codex #3844 r12 P2).
  const sortKey = (v) => `${dateOnly(v.scheduled_date)} ${v.window_start ? String(v.window_start).padStart(8, '0') : '~'} ${v.id}`;
  let pick = null;
  for (const [pestType, config] of Object.entries(PREP_CONFIG)) {
    const visit = await nextUpcomingVisit(customerIds, config.serviceKeywords[0]);
    if (!visit) continue;
    if (!pick || sortKey(visit) < sortKey(pick.visit)) pick = { visit, config, pestType };
  }
  if (!pick) {
    return { url: null, line: '', reason: 'No upcoming visit of a prep-guide service on this account' };
  }
  let { config, pestType } = pick;
  const { visit } = pick;
  // ensureServicePrepToken deliberately keeps an existing token's stored
  // prep_template_key (it is what the last DELIVERED guide rendered), so
  // the page shows the STORED guide, not the keyword-inferred one. Label
  // the text with the guide the link will actually open, or refuse when
  // the stored key is one the composer cannot name (pre-push Codex P1).
  if (visit.prep_template_key && visit.prep_template_key !== config.emailTemplateKey) {
    const stored = Object.entries(PREP_CONFIG).find(([, c]) => c.emailTemplateKey === visit.prep_template_key);
    if (!stored) {
      return { url: null, line: '', reason: 'This appointment\'s prep page is set to a guide the composer cannot name — send it from Send prep guide instead' };
    }
    [pestType, config] = stored;
  }
  // The page 404s past prep_expires_at and the mint would hand back the
  // same expired token — refuse rather than insert a dead link.
  if (visit.prep_expires_at && new Date(visit.prep_expires_at).getTime() <= Date.now()) {
    return { url: null, line: '', reason: 'The prep guide link for this appointment has expired' };
  }
  // prep-public renders the guide from the template's ACTIVE version and
  // 404s without one (renderGuideForSource) — a deactivated guide would
  // mint a link that cannot render (GH Codex #3844 r1 P1). Same predicate.
  const loaded = await require('./email-template-library').loadTemplateByKey(config.emailTemplateKey);
  if (!loaded?.activeVersion) {
    return { url: null, line: '', reason: `The ${config.label} prep guide has no active version in Email Templates — activate it before texting a prep link` };
  }
  const token = await ensureServicePrepToken(visit.id, config.emailTemplateKey);
  // The mint is not locked against a concurrent manual send or automation
  // claiming this unkeyed visit for ANOTHER guide: the losing mint still
  // returns the winning token, whose page renders that other guide. Re-read
  // the key the row actually carries and name THAT guide in the line — or
  // refuse when it is one the composer cannot name (GH Codex #3856 r27 P0).
  const keyed = await db('scheduled_services').where({ id: visit.id }).first('prep_template_key');
  if (keyed?.prep_template_key && keyed.prep_template_key !== config.emailTemplateKey) {
    const stored = Object.entries(PREP_CONFIG).find(([, c]) => c.emailTemplateKey === keyed.prep_template_key);
    if (!stored) {
      return { url: null, line: '', reason: 'This appointment\'s prep page is set to a guide the composer cannot name — send it from Send prep guide instead' };
    }
    [pestType, config] = stored;
  }
  const url = `${publicPortalUrl()}/prep/${token}`;
  return {
    url,
    line: prepGuideLine(config.label, url),
    // Immediate sends only — /sms binds the page to the recipient.
    immediateOnly: true,
    prep: { pestType, label: config.label, scheduledDate: dateOnly(visit.scheduled_date) },
    expiresAt: visit.prep_expires_at || null,
  };
}

/**
 * Latest service report — the newest completed visit that already carries
 * a public report token. Never mints: a completed record with no token is
 * one whose typed delivery was disabled (admin-dispatch mints on closeout
 * only while the mode is not 'disabled'), and an internal_only/disabled
 * typed report 404s publicly, so those are skipped too (reports-public's
 * own predicate). Short-wrapped with the closeout text's idiom.
 */
// The React report page reads /:token/data, which answers only for
// service_report_v1 records — a legacy-template row with a token would
// insert a link that 404s (pre-push Codex P1). Shared with the send seam.
const PUBLIC_REPORT_WHERE = { status: 'completed', report_template_version: 'service_report_v1' };

async function buildServiceReportLink(customerIds) {
  const { suppressedTypedReport } = require('../routes/reports-public');
  const PAGE = 15;
  let record = null;
  for (let offset = 0; ; offset += PAGE) {
    const rows = await db('service_records')
      .whereIn('customer_id', customerIds)
      .where(PUBLIC_REPORT_WHERE)
      .whereNotNull('report_view_token')
      // Unique tie-breaker last: bulk/backfilled records share a service_date
      // AND created_at, and OFFSET pages over a tie have no stable order
      // without it (GH Codex #3844 r6 P2).
      .orderBy([{ column: 'service_date', order: 'desc' }, { column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }])
      .offset(offset)
      .limit(PAGE);
    record = rows.find((row) => !suppressedTypedReport(row)) || null;
    if (record || rows.length < PAGE) break;
  }
  if (!record) return { url: null, line: '', reason: 'No service report on this account yet' };
  const url = await shortenOrPassthrough(`${publicPortalUrl()}/report/${record.report_view_token}`, {
    kind: 'service_report',
    entityType: 'service_records',
    entityId: record.id,
    customerId: record.customer_id,
    channel: 'sms',
    purpose: 'composer_insert',
    codePrefix: 'report',
  });
  return {
    url,
    line: `Here is your latest service report: ${url}\n\n`,
    // Immediate sends only — /sms binds the report to the recipient's account.
    immediateOnly: true,
    report: { id: record.id, serviceDate: dateOnly(record.service_date), serviceType: record.service_type || null },
  };
}

// A contract a signing link can still be minted for — the share-link
// route's own status allow-list (expired only re-opens for document
// requests, which re-issue on a fresh window).
const CONTRACT_LINKABLE_STATUSES = ['draft', 'sent', 'viewed'];

// The customer_contracts columns the marketing-guide predicate reads (plus
// the template id its joined columns come from).
const CONTRACT_GUIDE_COLUMNS = ['contract_type', 'document_template_id', 'document_render_summary', 'requires_signature_snapshot'];
// payment_method_id feeds the public sign handler's eligibility re-read
// (unsignableContractReason, the share-link writer's — GH Codex #3851 r2 P2).
const CONTRACT_SIGN_COLUMNS = ['payment_method_id'];

async function unsignableContractRefusal(contract) {
  const reason = await require('../routes/admin-contracts').unsignableContractReason(contract);
  return reason ? refuseSend(reason) : null;
}
const MARKETING_GUIDE_REFUSAL = 'This is a customer guide — it goes out from Document Templates (marketing opt-in and opt-out footer), never the composer. Remove the link before sending.';

/**
 * A marketing customer guide (a bulk product-safety send, or a marketing
 * customer_guide template needing no signature) is the Document Templates
 * delivery's alone: the seasonal_tips opt-in, the marketing_seasonal policy
 * and the opt-out footer live there (document-contract-delivery.js). The
 * composer sends conversationally, so the contract row never picks one and
 * the send seam refuses one however it got into the body (GH Codex #3844
 * r4 P1). The delivery's own predicate, fed the template columns it joins.
 */
async function isMarketingGuideContract(row) {
  if (!row || row.contract_type !== 'document_template') return false;
  const template = row.document_template_id
    ? await db('document_templates').where({ id: row.document_template_id }).first('category', 'document_type', 'requires_signature')
    : null;
  return require('./document-contract-delivery').isMarketingCustomerGuide({
    ...row,
    document_template_category: template?.category ?? null,
    document_template_document_type: template?.document_type ?? null,
    document_template_requires_signature: template?.requires_signature ?? null,
  });
}

/**
 * Contract signing link — the phone-owning customer's newest contract
 * still awaiting a signature (the route passes that ONE row, never account
 * siblings — a signable bearer follows the document delivery's own
 * recipient rule). The insert mints the token IN MEMORY and writes nothing:
 * a bearer nobody can use exists only once the /sms send ACTIVATES it
 * (bearerLinkSendCheck → activatePreparedShareLinks, the composer naming
 * the contract and the token proving it was minted here for it — an HMAC
 * over the contract id, a per-insert nonce and a 12-hour expiry,
 * composer-contract-token.js),
 * which writes the hash with status sent and a window
 * opened from the send — the document delivery's prepare → activate →
 * send shape, spread across the insert and the send (GH Codex #3844 r3 P1
 * + pre-push P0: nothing is publicly live before delivery, an abandoned
 * insert leaves nothing behind). A link the customer may still hold
 * (delivered, window open) refuses here as a courtesy and again under the
 * row lock at the send — never rotated (pre-push Codex P0); re-sending a
 * live link stays the Contracts page's deliberate action. The recipient-
 * phone trust the document delivery enforces (SMS_RECIPIENT_UNTRUSTED)
 * already holds: /customer-link only resolves a customer whose phone is
 * the recipient, and the send re-checks ownership. Marketing customer
 * guides are skipped — never the composer's to send (isMarketingGuideContract).
 */
async function buildContractSigningLink(customerIds) {
  const PAGE = 15;
  let row = null;
  for (let offset = 0; ; offset += PAGE) {
    const rows = await db('customer_contracts')
      .whereIn('customer_id', customerIds)
      .where((qb) => qb
        .whereIn('status', CONTRACT_LINKABLE_STATUSES)
        .orWhere({ status: 'expired', contract_type: 'document_template' }))
      // A unique final key: bulk-created document requests share created_at,
      // and an OFFSET page over a non-unique order may repeat and skip rows
      // (GH Codex #3851 r3 P2).
      .orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }])
      .offset(offset)
      .limit(PAGE);
    for (const candidate of rows) {
      if (!(await isMarketingGuideContract(candidate))) { row = candidate; break; }
    }
    if (row || rows.length < PAGE) break;
  }
  if (!row) return { url: null, line: '', reason: 'No contract awaiting signature on this account' };
  const title = String(row.title || '').trim() || 'agreement';
  if (require('../routes/admin-contracts').deliveredLiveShareLink(row)) {
    return {
      url: null,
      line: '',
      reason: `A signing link for ${title} was already sent and is still live — the customer can use it, or resend it from the Contracts page`,
    };
  }
  // Server-minted, contract-bound, short-lived (composer-contract-token.js):
  // the send proves the token is this insert's before it writes the hash —
  // the caller can never choose the bearer (pre-push Codex P0).
  const token = require('../utils/composer-contract-token').mintComposerContractToken(row.id);
  if (!token) return { url: null, line: '', reason: 'Contract signing links are not configured on this server (no signing secret)' };
  const { publicContractUrl, documentRequiresSignature } = require('./contracts');
  const url = publicContractUrl(token);
  // A document request whose template needs no signature is review-only —
  // the text must not ask for one (pre-push Codex P1). contracts.js's own
  // predicate: the creation-time snapshot, defaulting to signature required.
  const needsSignature = documentRequiresSignature(row);
  return {
    url,
    line: `Please review${needsSignature ? ' and sign' : ''} your ${title} here: ${url}\n\n`,
    // Immediate sends only — /sms is the one path that activates the link
    // (immediateOnlyLinkSendCheck is the server fence).
    immediateOnly: true,
    contract: { id: row.id, title, requiresSignature: needsSignature },
  };
}

// A project whose public viewer would answer 402 (pay card) instead of the
// report — reports-public heldReportPaymentContext's own set.
const PROJECT_REPORT_HELD_STATUSES = ['held', 'releasing'];
// Reports that have been issued: the same status set project-report-links
// numbers vanity paths over — AND delivery evidence: completing a project-
// backed visit mints report_token and closes the project even when the
// report was never sent (project-completion.js report_not_sent), and the
// public viewer has no status gate past the token, so a closed row alone is
// not an issued report; the project send flow stamps sent_at (GH Codex
// #3893 r3 P1).
// Owner ruling (2026-09-05, GH Codex #3893 r17): the project report takes
// the SERVICE REPORT's bar, not the price notice's. The report email is the
// delivery; a composer text of the same public page is a deliberate
// operator re-share, exactly as a service report link is — so no per-leg
// SMS evidence is required (the r15–r17 rounds each narrowed "was it
// texted" and each opened the next gap: email-only stamps, queued
// after-hours texts, kill-switch sentinels). A migrated 'legacy_sent'
// delivery stays out (owner ruling, same day): its delivery_status is its
// only issuance record, and the send claim below must never overwrite it.
const PROJECT_REPORT_STATUSES = ['sent', 'closed'];
const PROJECT_REPORT_LEGACY_DELIVERY = 'legacy_sent';
const PROJECT_REPORT_NOT_LEGACY_SQL = "delivery_status IS DISTINCT FROM 'legacy_sent'";
const issuedProjectReport = (project) => Boolean(project)
  && PROJECT_REPORT_STATUSES.includes(String(project.status || ''))
  && Boolean(project.sent_at)
  && project.delivery_status !== PROJECT_REPORT_LEGACY_DELIVERY;
// The columns the eligibility predicates read — never `*`: projects carries
// multi-MB blobs (wdo_signature, property_profile, wdo_history) that the
// list route also skips, and a Quick Link scan may touch 15 rows (r16 P2).
const PROJECT_REPORT_LINK_COLUMNS = ['id', 'customer_id', 'status', 'sent_at', 'delivery_status', 'report_token', 'report_hold_status'];
// What the line and toast read for the ONE chosen project: the title scrub
// (projectTitle — findings' and archived filings' recorded fees) and the
// vanity path (report_token, customer_id, id).
const PROJECT_REPORT_TITLE_COLUMNS = ['id', 'customer_id', 'title', 'project_type', 'project_date', 'report_token', 'findings', 'wdo_sent_filings'];

/**
 * The project send flow's duplicate-delivery claim (admin-projects /send):
 * a resend of an issued report holds delivery_status 'sending' — status and
 * sent_at unchanged — for its provider window, and treats a claim older
 * than ten minutes as a crashed send it may take over. A composer text of
 * the report link is the duplicate that claim exists to stop, and a
 * read-only look at 'sending' cannot close the check-to-dispatch race (GH
 * Codex #3893 r10 + r11 P1) — so the composer send takes the SAME claim,
 * exactly as it takes the card request claim:
 *   claimProjectReportSends — BEFORE dispatch: the flow's own conditional
 *     UPDATE (not 'sending', or a stale claim), keyed to the delivery state
 *     the seam saw so the hand-back is exact; a lost claim means the flow
 *     is sending right now (or the state moved) — every claim this call won
 *     is handed back and the send refuses.
 *   releaseProjectReportSends — after the provider answered, sent or not:
 *     the composer's text is a re-share, not a delivery, so the row's
 *     delivery state is restored, token-guarded (only THIS claim is
 *     cleared). A stale claim taken over restores to 'failed', as the flow
 *     itself normalizes a crashed send.
 * A migrated 'legacy_sent' row never reaches here (issuedProjectReport
 * excludes it), so its delivery_status — its only issuance evidence — is
 * never overwritten by a claim.
 */
async function claimProjectReportSends(projectReports) {
  const crypto = require('crypto');
  const won = [];
  const CLAIMED = 'This project report is being re-sent right now — give it a moment, then send again.';
  // One claim per project: the same report linked twice (vanity and full
  // form, or a repeated URL) is one send, and a second claim against the
  // state the first replaced would refuse a message with no competitor
  // (pre-push Codex P1).
  const unique = [...new Map(projectReports.map((p) => [p.id, p])).values()];
  for (const { id, deliveryStatus } of unique) {
    const token = crypto.randomBytes(12).toString('hex');
    const seenSending = deliveryStatus === 'sending';
    const q = db('projects').where({ id });
    if (seenSending) q.whereRaw("delivery_status = 'sending' AND updated_at < now() - interval '10 minutes'");
    else if (deliveryStatus == null) q.whereNull('delivery_status');
    else q.where({ delivery_status: deliveryStatus });
    let claimed;
    try {
      claimed = await q.update({ delivery_status: 'sending', delivery_claim_token: token, updated_at: db.fn.now() });
    } catch (err) {
      await releaseProjectReportSends({ projects: won });
      throw err;
    }
    if (!claimed) {
      await releaseProjectReportSends({ projects: won });
      return { ok: false, error: CLAIMED };
    }
    won.push({ id, token, previousStatus: seenSending ? 'failed' : deliveryStatus });
  }
  return { ok: true, claim: { projects: won } };
}

async function releaseProjectReportSends(claim) {
  for (const { id, token, previousStatus } of claim.projects) {
    await db('projects')
      .where({ id, delivery_status: 'sending', delivery_claim_token: token })
      .update({ delivery_status: previousStatus, delivery_claim_token: null, updated_at: db.fn.now() });
  }
}

// The project a public report segment opens, exactly as the viewer resolves
// it (reports-public loadProjectForReport): a full token matches its row; a
// vanity prefix must match exactly one.
async function linkableProjectReport(lookup) {
  if (lookup.type === 'full') return db('projects').where({ report_token: lookup.value }).first(...PROJECT_REPORT_LINK_COLUMNS);
  const rows = await db('projects').select(PROJECT_REPORT_LINK_COLUMNS).where('report_token', 'like', `${lookup.value}%`).limit(2);
  return rows.length === 1 ? rows[0] : null;
}

/**
 * Project report link — the account's newest issued project report (WDO /
 * specialty; a household shares them like service reports), skipping one on
 * a payment hold (its page is a pay card until the invoice settles). The
 * vanity path the report emails use (projectReportPathForProject); the
 * token is the project's permanent report_token, nothing minted.
 */
async function buildProjectReportLink(customerIds) {
  const PAGE = 15;
  let pick = null;
  for (let offset = 0; ; offset += PAGE) {
    // The eligibility scan carries only what the pick needs; the chosen
    // project's title fields are loaded once below (r16 P2).
    const rows = await db('projects')
      .select('id', 'customer_id', 'report_hold_status')
      .whereIn('customer_id', customerIds)
      .whereIn('status', PROJECT_REPORT_STATUSES)
      .whereNotNull('sent_at')
      .whereRaw(PROJECT_REPORT_NOT_LEGACY_SQL)
      .whereNotNull('report_token')
      // Newest issued first; ties by creation — projects.id is a random
      // UUID, not a chronological key (r8 P2).
      .orderByRaw('sent_at DESC, created_at DESC, id DESC')
      .offset(offset)
      .limit(PAGE);
    pick = rows.find((row) => !PROJECT_REPORT_HELD_STATUSES.includes(String(row.report_hold_status || ''))) || null;
    if (pick || rows.length < PAGE) break;
  }
  if (!pick) return { url: null, line: '', reason: 'No project report on this account yet' };
  const project = await db('projects').where({ id: pick.id }).first(...PROJECT_REPORT_TITLE_COLUMNS);
  if (!project) return { url: null, line: '', reason: 'No project report on this account yet' };
  const customer = await db('customers').where({ id: project.customer_id }).first('first_name', 'last_name');
  const path = await require('./project-report-links').projectReportPathForProject(db, project, customer || {});
  if (!path) return { url: null, line: '', reason: 'No project report on this account yet' };
  const url = `${publicPortalUrl()}${path}`;
  // The email path's own customer-facing title: a legacy or deploy-window
  // title can carry the inspection fee literally or as a bare amount, and
  // projectTitle runs the same type-gated cue + recorded-amount scrub the
  // public /data headline does (GH Codex #3893 r4 P1). Reads findings.
  const title = require('./project-email').projectTitle(project);
  return {
    url,
    line: `Here is your ${title} report: ${url}\n\n`,
    // Immediate sends only — /sms binds the report to the recipient's
    // account and re-checks the payment hold.
    immediateOnly: true,
    projectReport: { id: project.id, title, projectType: project.project_type || null, projectDate: dateOnly(project.project_date) },
  };
}

/**
 * Payer statement pay link — FAIL CLOSED on identity: a statement covers
 * the bill-to's whole book and its pay page charges the PAYER's Stripe
 * customer, so the link only ever goes to the payer's own AP phone. The
 * recipient is resolved as a PAYER, not a customer (GH Codex #3844 r2 P1 —
 * the AP phone is normally no customer's phone at all): every active payer
 * whose AP phone is the number, newest payable statement (finalized/sent/
 * viewed — the settle module's own status set) across all of them. A
 * homeowner's number never qualifies. Raw URL, same as the follow-up emails.
 */
async function buildStatementLink(recipientLast10) {
  if (!require('../config/feature-gates').isEnabled('payerStatements')) {
    return { url: null, line: '', reason: 'Payer statements are switched off (GATE_PAYER_STATEMENTS)' };
  }
  if (!/^\d{10}$/.test(String(recipientLast10 || ''))) {
    return { url: null, line: '', reason: 'Enter a full 10-digit phone number first' };
  }
  const matching = await db('payers')
    .where({ active: true })
    .whereRaw("right(regexp_replace(COALESCE(ap_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [recipientLast10])
    .select('id', 'display_name');
  if (!matching.length) {
    return { url: null, line: '', reason: "This number is not a payer's AP phone on file — statement links go to the bill-to contact only" };
  }
  // Payability filtered in SQL (the settle module's own status set), so an
  // older payable statement behind a run of paid ones is still found.
  const { PAYABLE_STATEMENT_STATUSES } = require('./payer-statement-settle');
  const stmt = await db('payer_statements')
    .whereIn('payer_id', matching.map((p) => p.id))
    .whereIn('status', [...PAYABLE_STATEMENT_STATUSES])
    .whereNotNull('token')
    .orderBy('created_at', 'desc')
    .first();
  const names = matching.map((p) => p.display_name).join(' / ');
  if (!stmt) return { url: null, line: '', reason: `No payable statement for ${names}` };
  const payer = matching.find((p) => String(p.id) === String(stmt.payer_id)) || matching[0];
  const url = `${publicPortalUrl()}/pay/statement/${stmt.token}`;
  const number = `S-${stmt.id}`;
  return {
    url,
    line: `You can view and pay statement ${number} securely here: ${url}\n\n`,
    // Immediate sends only — payability + the gate are re-checked on /sms alone.
    immediateOnly: true,
    statement: { id: stmt.id, number, total: Number(stmt.total) || 0, payerName: payer.display_name },
  };
}

module.exports = {
  OPEN_ESTIMATE_STATUSES,
  REVIEW_GATE_REASONS,
  buildReviewRequestLink,
  buildPayBalanceLink,
  buildLatestEstimateLink,
  findLatestOpenEstimate,
  mintEstimateLink,
  resolveConfirmationEstimate,
  appendEstimateAcceptLine,
  buildReferralLink,
  AUTOPAY_SKIP_REASONS,
  buildAutopaySetupLink,
  autopayLinkSendCheck,
  immediateOnlyLinkSendCheck,
  bearerLinkSendCheck,
  markStatementsSent,
  markPrepGuidesSent,
  recheckPrepLinks,
  claimCardRequestSends,
  releaseCardRequestSends,
  markCardRequestSends,
  claimProjectReportSends,
  releaseProjectReportSends,
  buildAppointmentPageLink,
  CARD_REQUEST_SKIP_REASONS,
  buildCardRequestLink,
  buildPrepGuideLink,
  buildServiceReportLink,
  buildContractSigningLink,
  buildStatementLink,
  buildProjectReportLink,
};
