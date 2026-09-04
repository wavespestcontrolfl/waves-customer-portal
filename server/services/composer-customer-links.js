/**
 * Per-customer link builders for the SMS composer's Insert Link sheet —
 * the link kinds beyond the existing reschedule/re-service pair:
 * review request, pay balance, latest estimate, referral, Auto Pay setup,
 * and (step 2) appointment page, prep guide, latest service report, payer
 * statement (card request + contract signing: PR 2b).
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
function canonicalPortalToken(run, hosts, pathRe) {
  let url;
  try {
    url = new URL(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(run) ? run : `https://${run}`);
  } catch {
    return null;
  }
  // HTTPS or the schemeless canonical form only — an explicit http:// would
  // expose the 30-day bearer before any redirect reaches HTTPS.
  if (url.protocol !== 'https:') return null;
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
function canonicalSecureToken(run, hosts) {
  return canonicalPortalToken(run, hosts, /^\/secure\/([A-Za-z0-9_-]{16,})$/i);
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
// immediate-only: a payer statement pay link and a prep page (bound to the
// recipient at /sms alone). Presence-only — the callers (/schedule-sms, draft
// approve/revise) refuse on any hit. Canonical portal host + path only,
// like the Auto Pay seam: a look-alike host is not a Waves bearer and is
// simply not this seam's business. Customer-kind /secure links are the
// Auto Pay seam's (its own presence check runs first at every caller).
const IMMEDIATE_ONLY_LINK_KINDS = [
  {
    // Every prep page — the page shows the customer's name and address and
    // only /sms binds it to the recipient (pre-push Codex P0), expiry or not.
    label: 'Prep guide',
    fragment: /\/prep\//i,
    token: (run, host) => canonicalPortalToken(run, host, /^\/prep\/([a-f0-9]{32})$/i),
    applies: async () => true,
  },
  {
    label: 'Statement pay',
    fragment: /\/pay\/statement\//i,
    token: (run, host) => canonicalPortalToken(run, host, /^\/pay\/statement\/([0-9a-f]{64})$/i),
    applies: async () => true,
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
async function shortCodeRows(runs) {
  const shortRuns = linkRuns(runs, /\/l\//i);
  if (!shortRuns.length) return [];
  const hosts = ownedPortalHosts();
  const rows = [];
  for (const run of shortRuns) {
    const code = canonicalPortalToken(run, hosts, /^\/l\/([A-Za-z0-9_-]+)$/i);
    if (!code) continue;
    const row = await db('short_codes').where({ code: code.toLowerCase() }).first('code', 'kind', 'entity_type', 'entity_id');
    if (row) rows.push(row);
  }
  return rows;
}

const APPOINTMENT_TOKEN_RE = /^\/appointment\/([A-Za-z0-9_-]{16,})$/i;
const REPORT_TOKEN_RE = /^\/report\/([A-Za-z0-9_-]{16,})$/i;

// Appointment page links (GH Codex #3844 r2 P1): every /appointment route
// 404s the moment GATE_APPOINTMENT_PAGE is off, and a queued message has no
// delivery-time re-check — so they are immediate-only, and /sms re-reads the
// gate. Service report links the same (pre-push Codex P0): only /sms binds
// the page to the recipient. Long form or the branded short form.
function appointmentLinkPresent(runs, hosts, shortRows) {
  return linkRuns(runs, /\/appointment\//i).some((run) => canonicalPortalToken(run, hosts, APPOINTMENT_TOKEN_RE))
    || shortRows.some((row) => row.kind === 'appointment');
}
function reportLinkPresent(runs, hosts, shortRows) {
  return linkRuns(runs, /\/report\//i).some((run) => canonicalPortalToken(run, hosts, REPORT_TOKEN_RE))
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
  const shortRows = await shortCodeRows(runs);
  if (appointmentLinkPresent(runs, hosts, shortRows)) return { present: true, label: 'Appointment page' };
  if (reportLinkPresent(runs, hosts, shortRows)) return { present: true, label: 'Service report' };
  return { present: false };
}

/**
 * Immediate-send seam for the other per-row bearers the composer inserts
 * (pre-push Codex P0 on the step-2 rows — the same protection the Auto Pay
 * seam gives /secure customer-kind links): a stale tab or a direct API
 * call must not deliver a customer's page to another phone, or after
 * expiry. (The contract signing and card request bearers: PR 2b.)
 *   prep      — /prep/<token>: the public page's own predicates at the send
 *               (GH Codex #3844 r3 P2) — the token still resolves
 *               (unexpired) and its guide still has an active version.
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
 * finalized → sent (markStatementsSent). One function per link kind below;
 * bearerLinkSendCheck is the composition.
 */
// One check per link kind (GH Codex #3844 r5 P2 — the seam was one
// 40-branch function); the shared parts are the parsed runs, the canonical
// host and the two binding rules below.
const refuseSend = (error) => ({ ok: false, error });
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
    const bad = await ownedByRecipient(ctx, source.customerId, 'prep guide link');
    if (bad) return bad;
    ctx.bearers += 1;
    // The marker is keyed by the tagger's pest type; a guide outside
    // PREP_CONFIG (a project prep page) has no replay guard to satisfy.
    const pestType = Object.keys(PREP_CONFIG).find((k) => PREP_CONFIG[k].emailTemplateKey === source.templateKey);
    if (pestType && !preps.some((p) => p.customerId === source.customerId && p.pestType === pestType)) {
      preps.push({ customerId: source.customerId, pestType });
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
  const visitById = async (where) => db('scheduled_services').where(where).first('id', 'customer_id');
  const bind = async (visit) => {
    if (!visit) return refuseSend('This appointment link no longer resolves — remove it and insert a fresh one.');
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
    const bad = await bind(row.entity_type === 'scheduled_services' && row.entity_id ? await visitById({ id: row.entity_id }) : null);
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
  for (const run of linkRuns(ctx.runs, /\/report\//i)) {
    const token = canonicalPortalToken(run, ctx.hosts, REPORT_TOKEN_RE);
    if (!token) return refuseSend('A service report link in this message is not on the Waves portal — remove it before sending.');
    const bad = await bind(await publicReport({ report_view_token: token }));
    if (bad) return bad;
  }
  for (const row of shortRows.filter((r) => r.kind === 'service_report')) {
    const bad = await bind(row.entity_type === 'service_records' && row.entity_id ? await publicReport({ id: row.entity_id }) : null);
    if (bad) return bad;
  }
  return null;
}

// The account-scoped kinds together: the appointment gate is re-read at the
// send (every /appointment route 404s the moment it is off — r2 P1), then
// each kind binds to the recipient's account.
async function checkAccountBoundLinks(ctx) {
  const shortRows = await shortCodeRows(ctx.runs);
  if (appointmentLinkPresent(ctx.runs, ctx.hosts, shortRows) && process.env.GATE_APPOINTMENT_PAGE !== 'true') {
    return refuseSend('Appointment pages are switched off (GATE_APPOINTMENT_PAGE) — remove the appointment link before sending.');
  }
  const onRecipientAccount = recipientAccountBinder(ctx);
  return (await checkAppointmentLinks(ctx, shortRows, onRecipientAccount))
    || checkReportLinks(ctx, shortRows, onRecipientAccount);
}

// `usDestination` (default true): the route says whether `to` normalizes to a
// US number. Every check here binds by the LAST TEN digits, so a non-US
// E.164 destination whose last ten equal a customer's or payer's US number
// would pass ownership and even adopt that customer while the provider
// texts the other country (GH Codex #3844 r10 P1) — a bearer never goes to
// a non-US destination.
async function bearerLinkSendCheck(body, toLast10, { trustedCustomerId, usDestination = true } = {}) {
  const ctx = {
    runs: decodedRuns(body),
    hosts: ownedPortalHosts(),
    toLast10: String(toLast10 || ''),
    trustedCustomerId,
    bearers: 0, // verified bearers seen — the owner rule below applies to any
  };
  const statements = [];
  const preps = [];
  const refusal = (await checkPrepLinks(ctx, preps))
    || (await checkStatementLinks(ctx, statements))
    || (await checkAccountBoundLinks(ctx));
  if (refusal) return refusal;
  if (ctx.bearers && !usDestination) {
    return refuseSend('Customer links only go to a US number — check the recipient before sending.');
  }
  const out = { ok: true, ...(statements.length ? { statements } : {}), ...(preps.length ? { preps } : {}) };
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
 * A REAL provider send of a composer prep link is a delivered prep text:
 * write the SAME customer_interactions marker the appointment tagger's
 * replay guard (hasSentPrepSms — sms_outbound + "<pestType> prep info
 * sent") looks for, as the manual Send prep guide path does, so a later
 * onServiceScheduled / regenerate-brief replay does not text prep again
 * (GH Codex #3844 r8 P2). Fail-soft: the text already went out.
 */
async function markPrepGuidesSent(preps, actorId) {
  for (const { customerId, pestType } of preps) {
    await db('customer_interactions').insert({
      customer_id: customerId,
      interaction_type: 'sms_outbound',
      admin_user_id: actorId || null,
      subject: `${pestType} prep info sent`,
      body: 'Prep SMS sent via the Communications composer (prep guide link).',
    });
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

// ---------------------------------------------------------------------------
// Step 2 rows (Adam's rulings 2026-09-03): appointment page, prep guide,
// latest service report, payer statement (card request + contract signing
// follow in PR 2b).
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
async function buildPrepGuideLink(customerIds) {
  const { PREP_CONFIG, nextUpcomingVisit } = require('./prep-guide-sender');
  const { ensureServicePrepToken } = require('./project-email');
  // Soonest across families by date THEN arrival window (two same-day
  // visits of different families must not pick arbitrarily), id last.
  const sortKey = (v) => `${dateOnly(v.scheduled_date)} ${String(v.window_start || '').padStart(8, '0')} ${v.id}`;
  let pick = null;
  for (const [pestType, config] of Object.entries(PREP_CONFIG)) {
    const visit = await nextUpcomingVisit(customerIds, config.serviceKeyword);
    if (!visit) continue;
    if (!pick || sortKey(visit) < sortKey(pick.visit)) pick = { visit, config, pestType };
  }
  if (!pick) {
    return { url: null, line: '', reason: 'No upcoming flea, bed bug, or cockroach visit on this account' };
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
  const url = `${publicPortalUrl()}/prep/${token}`;
  return {
    url,
    line: `Your prep checklist for the upcoming ${config.label} is here: ${url}\n\n`,
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
  buildAppointmentPageLink,
  buildPrepGuideLink,
  buildServiceReportLink,
  buildStatementLink,
};
