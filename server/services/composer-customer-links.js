/**
 * Per-customer link builders for the SMS composer's Insert Link sheet —
 * the link kinds beyond the existing reschedule/re-service pair:
 * review request, pay balance, latest estimate, referral, Auto Pay setup.
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
 *   referral — referral-engine.enrollPromoter: idempotent, self-healing,
 *              guarantees a personal /r/CODE link. No short code (referral
 *              links go out raw everywhere).
 */

const db = require('../models/db');
const logger = require('./logger');
const { publicPortalUrl } = require('../utils/portal-url');
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
  const { enrollPromoter, getLiveSettings } = require('./referral-engine');
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
    ({ promoter } = await enrollPromoter(customerId));
  } catch (err) {
    // enrollPromoter is strictly per-customer while referral_promoters.
    // customer_phone stays unique, so a multi-property sibling whose phone
    // already backs another sibling's promoter loses the insert (23505).
    // Same household fallback as the report referral endpoint
    // (reports-public.js): resolve the promoter read-only, scoped to the
    // SAME account_id — phone alone is not identity (recycled/shared
    // numbers cross unrelated customers). No account-scoped match = a
    // genuine cross-account collision → the plain reason, never a guessed
    // attribution. Log err.code only, never err.message — PG constraint
    // violations quote the conflicting value, which here is a phone number
    // (AGENTS.md PII-in-logs rule).
    if (err?.code === '23505') {
      const profile = await db('customers')
        .where({ id: customerId })
        .first('id', 'phone', 'account_id');
      promoter = profile?.phone && profile?.account_id
        ? await db('referral_promoters as rp')
          .join('customers as c', 'rp.customer_id', 'c.id')
          .where('rp.customer_phone', profile.phone)
          .where('c.account_id', profile.account_id)
          .first('rp.*')
        : null;
    }
    if (!promoter) {
      logger.warn(`[composer-links] referral enroll failed (customerId=${customerId}, code=${err?.code || 'none'})`);
      return { url: null, line: '', reason: 'Could not build a referral link for this customer' };
    }
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
// Case-insensitive: the React route is not case-sensitive, so /Secure/<tok>
// still opens the page and must still be judged (GH Codex #3812 r4 P1).
const SECURE_PATH_RE = /\/secure\/([A-Za-z0-9_-]{16,})/gi;

// Percent-escapes decode before detection: React Router decodes the
// pathname, so "/secur%65/<token>" still opens the page and must still be
// judged (GH Codex #3812 r5 P1). Malformed escapes are left as typed.
function decodeLinkText(body) {
  return String(body || '').replace(/(?:%[0-9A-Fa-f]{2})+/g, (seq) => {
    try { return decodeURIComponent(seq); } catch { return seq; }
  });
}

// Cheap presence probe for callers that refuse on presence alone (drafts).
function bodyMayCarrySecureLink(body) {
  return /\/secure\//i.test(decodeLinkText(body));
}
// Every whitespace-delimited run of the (decoded) body that carries a
// /secure/ path, with wrapping punctuation shed and a bare "Label:" prefix
// dropped ("Link:portal…" is how operators type it). Each run is PARSED as
// a URL (https:// assumed when schemeless — that is how the composer inserts
// owned-host links) and accepted only when its hostname is exactly the
// portal host and its pathname is exactly /secure/<token>. A substring
// match is never enough: "https://evil.example/?next=portal…/secure/<tok>"
// sends the bearer to evil.example (GH Codex #3812 r6 P1; earlier rounds
// covered path-nested, subdomain and suffix look-alikes the same way).
function secureLinkRuns(text) {
  return String(text || '')
    .split(/\s+/)
    .filter((run) => /\/secure\//i.test(run))
    .map((run) => run.replace(/^[(\[<'"]+/, '').replace(/[.,;:!?)\]}>'"]+$/, ''))
    // A bare label glued to the link ("Link:", "now,") is shed — but only a
    // slash-free prefix, so an outer URL's own path/query is never cut away.
    .map((run) => run.replace(/^[^/]*?(?=https?:\/\/)/i, ''))
    .map((run) => (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(run) ? run : run.replace(/^[^/:,;]*[:,;]/, '')));
}
function canonicalSecureToken(run, host) {
  let url;
  try {
    url = new URL(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(run) ? run : `https://${run}`);
  } catch {
    return null;
  }
  // HTTPS or the schemeless canonical form only — an explicit http:// would
  // expose the 30-day bearer before any redirect reaches HTTPS.
  if (url.protocol !== 'https:') return null;
  if (url.host.toLowerCase() !== host) return null;
  const m = /^\/secure\/([A-Za-z0-9_-]{16,})$/i.exec(url.pathname);
  return m ? m[1] : null;
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
  const text = decodeLinkText(body);
  if (!SECURE_PATH_RE.test(text)) return { present: false };
  SECURE_PATH_RE.lastIndex = 0;
  const refuse = (error) => ({ present: true, ok: false, error });
  const host = new URL(publicPortalUrl()).host.toLowerCase();
  const tokens = [];
  for (const run of secureLinkRuns(text)) {
    const token = canonicalSecureToken(run, host);
    if (!token) return refuse('A /secure link in this message is not on the Waves portal — remove it before sending.');
    if (!tokens.includes(token)) tokens.push(token);
  }
  if (!tokens.length) return refuse('A /secure link in this message is not on the Waves portal — remove it before sending.');
  const { KIND, setupLinkIneligibility } = require('./autopay-setup-link');
  const live = [];
  for (const token of tokens) {
    const row = await db('appointment_card_requests')
      .where({ token })
      .first('id', 'kind', 'status', 'expires_at', 'customer_id');
    if (row && row.kind !== KIND) continue;
    if (!row || row.status !== 'pending' || (row.expires_at && new Date(row.expires_at).getTime() <= Date.now())) {
      return refuse('This Auto Pay setup link is expired or no longer live — remove it and insert a fresh one.');
    }
    live.push({ token, customerId: row.customer_id });
  }
  if (!live.length) return { present: false };
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
  bodyMayCarrySecureLink,
};
