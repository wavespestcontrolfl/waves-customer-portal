const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
const db = require('../models/db');
const logger = require('../services/logger');
const stripeConfig = require('../config/stripe-config');
const config = require('../config');
const {
  adminAuthenticate,
  requireAdmin,
  isStaffAccessToken,
  staffTokenVersionMatches,
} = require('../middleware/admin-auth');
const { isEnabled } = require('../config/feature-gates');
const { noStore } = require('../middleware/no-store');
const { sessionMfaBlock } = require('../services/staff-mfa');
const {
  buildSurchargeAmountDetails,
  computeSurchargeCents,
  planCardPresentSurcharge,
  SURCHARGE_API_VERSION,
} = require('../services/stripe-pricing');
const { invoiceAmountDue, invoiceWithdrawnFromCustomer } = require('../services/invoice-helpers');
const { assertInvoiceDepositSettlementReady } = require('../services/estimate-deposits');
const {
  assertNoInvoiceChargeReconciliationPending,
  parkInvoiceForSavedCardReconciliation,
} = require('../services/stripe');

function terminalChargeFenceResponse(err) {
  if (err?.code === 'DEPOSIT_RECONCILIATION_REQUIRED') {
    return { error: err.message, code: err.code, reconciliationRequired: true };
  }
  return {
    error: err?.code === 'STRIPE_CHARGE_IN_PROGRESS'
      ? 'Another payment attempt is already in progress for this invoice'
      : 'This invoice has a payment awaiting reconciliation',
    code: err?.code === 'STRIPE_CHARGE_IN_PROGRESS'
      ? 'payment_charge_in_progress'
      : 'payment_reconciliation_pending',
    reconciliationRequired: err?.reconciliationRequired === true,
  };
}

function terminalHandoffNeedsReissue(handoff) {
  const usedAt = new Date(handoff?.used_at || '').getTime();
  const expiresAt = new Date(handoff?.expires_at || '').getTime();
  return Number.isFinite(usedAt) && Number.isFinite(expiresAt) && expiresAt <= usedAt;
}

// Accepts both regular admin JWTs and terminal-scoped JWTs (minted by
// /validate-handoff). Regular adminAuthenticate rejects scope:'terminal'
// so these tokens can't escalate to other admin routes.
//
// Token kinds. A terminal token minted by /validate-save-card-handoff carries
// `save_card: true`: it may open a Terminal connection and complete the card
// save, and it can NEVER move money. The default guard below therefore refuses
// it (403 save_card_token); only the connection-token and complete-setup
// routes opt in. A future route that uses terminalAuthenticate is a payment
// route unless it says otherwise.
function terminalAuthenticateFor(allow) {
  return async function authenticate(req, res, next) {
    return authenticateTerminalToken(req, res, next, allow);
  };
}

async function authenticateTerminalToken(req, res, next, allow) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], config.jwt.secret);
    if (!isStaffAccessToken(decoded)) return res.status(401).json({ error: 'Invalid token type' });
    if (!decoded.technicianId) return res.status(401).json({ error: 'Invalid token' });
    if (decoded.scope && decoded.scope !== 'terminal') {
      return res.status(401).json({ error: 'Invalid token scope' });
    }
    const isSaveCardToken = decoded.save_card === true;
    if (isSaveCardToken && allow === 'collect') {
      return res.status(403).json({ error: 'This token can only save a card, not take a payment', code: 'save_card_token' });
    }
    if (!isSaveCardToken && allow === 'save_card') {
      return res.status(403).json({ error: 'A card-save token is required', code: 'save_card_token_required' });
    }
    const tech = await db('technicians').where({ id: decoded.technicianId }).first();
    if (!tech || !tech.active) return res.status(401).json({ error: 'Account not found or inactive' });
    if (!['admin', 'technician'].includes(tech.role)) {
      return res.status(401).json({ error: 'Account not found or inactive' });
    }
    if (!staffTokenVersionMatches(decoded, tech) || tech.must_change_password) {
      return res.status(401).json({ error: 'Session has been revoked', code: 'TOKEN_REVOKED' });
    }
    // Every token here follows the two-step rule (GATE_ADMIN_MFA), judged
    // now: a terminal-scoped token carries the minting session's proof
    // through the handoff (staff_mfa -> mfa).
    const mfaBlock = sessionMfaBlock(decoded, tech);
    if (mfaBlock) return res.status(mfaBlock.status).json({ error: mfaBlock.error, code: mfaBlock.code });
    req.technician = tech;
    req.technicianId = tech.id;
    req.techRole = tech.role;
    req.terminalClaims = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Payment routes: /payment-intent, /apply-surcharge.
const terminalAuthenticate = terminalAuthenticateFor('collect');
// /connection-token: both kinds (the reader connects the same way).
const terminalAuthenticateAnyKind = terminalAuthenticateFor('any');
// /complete-setup: the card-save token only.
const terminalAuthenticateSaveCard = terminalAuthenticateFor('save_card');

const {
  auditTerminalHandoffMint,
  auditTerminalHandoffRateLimited,
  auditTerminalHandoffValidate,
  ipFromReq,
  uaFromReq,
} = require('../services/audit-log');

const TERMINAL_LOCATION_ID = process.env.STRIPE_TERMINAL_LOCATION_ID || null;

// Handoff JWT lifetime. Short enough that a leaked token from a logged
// screenshot or sniffed link is useless within minutes.
const HANDOFF_TTL_SECONDS = 60;
const HANDOFF_ISS = 'waves-portal';
const HANDOFF_AUD = 'waves-pay-ios';
// terminal_handoff_tokens.kind of a Tap to Pay card save (no charge).
const SAVE_CARD_KIND = 'save_card';

// What the customer pays for, as the Waves Admin amount and Paid screens list
// it: the invoice number, its service lines and the totals rows the invoice
// PDF prints, down to the amount due. When those rows do not add up to the
// amount due (legacy data), the lines go without prices, so the screen never
// shows numbers that disagree with the charge. /validate-handoff has already
// burned the jti, so a failure here returns no lines instead of throwing.
function terminalInvoiceLines(invoice, customer, amountDueCents) {
  const invoice_number = invoice.invoice_number || null;
  try {
    const { visibleInvoiceLines, invoiceLineParts, invoiceTotalsFacts } = require('../services/pdf/invoice-pdf');
    const cents = (dollars) => Math.round((Number(dollars) || 0) * 100);
    const items = visibleInvoiceLines(invoice.line_items).map((line) => {
      const { description, qty, amount } = invoiceLineParts(line);
      return { description: qty === 1 ? description : `${description} × ${qty}`, amount_cents: cents(amount) };
    });
    const f = invoiceTotalsFacts(invoice, customer);
    const adjustments = [
      f.discount > 0 ? { label: f.discountLabel, amount_cents: -cents(f.discount) } : null,
      f.showTax ? { label: f.taxLabel, amount_cents: cents(f.tax) } : null,
      f.depositCredit > 0 ? { label: 'Deposit paid at acceptance', amount_cents: -cents(f.depositCredit) } : null,
      f.creditApplied > 0 ? { label: 'Account credit applied', amount_cents: -cents(f.creditApplied) } : null,
      f.amountPaid > 0 ? { label: 'Paid so far', amount_cents: -cents(f.amountPaid) } : null,
    ].filter(Boolean);
    const sum = [...items, ...adjustments].reduce((total, row) => total + row.amount_cents, 0);
    if (sum === amountDueCents) return { invoice_number, items, adjustments };
    return { invoice_number, items: items.map(({ description }) => ({ description, amount_cents: null })), adjustments: [] };
  } catch (err) {
    logger.warn(`[stripe-terminal] invoice lines failed for ${invoice.id}: ${err.message}`);
    return { invoice_number, items: [], adjustments: [] };
  }
}

function handoffStaffSessionMatches(claims, tech) {
  const claimedVersion = claims?.staff_token_version;
  const currentVersion = Number(tech?.auth_token_version);
  return Boolean(tech?.active)
    && ['admin', 'technician'].includes(tech.role)
    && !tech.must_change_password
    && Number.isInteger(claimedVersion)
    && claimedVersion >= 1
    && Number.isInteger(currentVersion)
    && currentVersion >= 1
    && claimedVersion === currentVersion;
}

// Per-tech mint ceiling. The limiter is a security control (handoff tokens
// authorize real-money charges) — it MUST survive deploys and be accurate
// across replicas. Enforced in Postgres, not in-memory.
//
// Baseline reasoning for 20/hr: a normal field day is 8–12 stops. 20 mints
// gives 8–12 legitimate taps plus generous headroom for retries (tech
// fumbles the flow, customer says "wait let me grab a different card",
// reader disconnects and has to reconnect). Any tech hitting 20 in a
// rolling hour is either in trouble or the token is leaked — either way
// we want a 429 + audit row, not silent passage.
//
// Env-overridable so dev can use 100 for easier testing and so the number
// can be tuned in production without a deploy.
const HANDOFF_MINTS_PER_HOUR = (() => {
  const raw = parseInt(process.env.HANDOFF_MINT_RATE_LIMIT_PER_HOUR, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 20;
})();

function getStripe() {
  return new Stripe(stripeConfig.secretKey);
}

function getHandoffSecret() {
  const s = process.env.TERMINAL_HANDOFF_SECRET;
  if (!s || s.length < 32) return null;
  return s;
}

// POST /api/stripe/terminal/handoff
// Mints a 60-second HMAC-JWT that the PWA embeds in a wavespay:// deep link.
// The native iOS app POSTs the token to /validate-handoff, which atomically
// burns the jti — second use is rejected.
//
// Body: { invoice_id }
// Returns: { token, deep_link, jti, expires_at }
//
// Rate limit: HANDOFF_MINTS_PER_HOUR per tech_user_id, enforced by counting
// rows in terminal_handoff_tokens inside the same transaction that reserves
// the jti. An advisory lock keyed on tech_user_id serializes concurrent
// mints for the same tech so two near-simultaneous requests can't both
// pass the count check (READ COMMITTED isolation otherwise allows it).
// adminAuthenticate guarantees req.technicianId is set — if that ever
// changes the transaction aborts (advisory lock call throws on NULL).
// Technician scope for in-person collection: the invoice's customer must be
// on the technician's current/recent assigned route (technicianServicesCustomer
// — the same predicate the schedule and customer routers use). Admins pass.
async function technicianMayCollectInvoice(req, invoice) {
  if (req.techRole !== 'technician') return true;
  if (!invoice?.customer_id) return false;
  const { technicianServicesCustomer } = require('../services/technician-visit-scope');
  return technicianServicesCustomer(req, invoice.customer_id);
}

// The same predicate as technicianMayCollectInvoice, re-judged INSIDE the mint
// transaction with the qualifying visit row locked FOR UPDATE (codex #5568 r14
// P1): the unlocked check above runs before credit-apply and the separate mint
// transaction, so a reassignment landing in between could still let the former
// technician mint a collection token. Holding the row lock to commit means the
// reassignment either lands first (this finds no row) or waits for the mint.
async function technicianMayCollectInvoiceLocked(trx, req, invoice) {
  if (req.techRole !== 'technician') return true;
  if (!invoice?.customer_id) return false;
  const { technicianCurrentVisitFilter } = require('../services/technician-visit-scope');
  const assigned = await technicianCurrentVisitFilter(
    req,
    trx('scheduled_services').where({ customer_id: invoice.customer_id }),
  ).forUpdate().first('scheduled_services.id');
  return !!assigned;
}

router.post('/handoff', adminAuthenticate, async (req, res) => {
  // Hoisted so the generic catch below can reverse seam-applied credit when no
  // handoff token ends up minted (any abort after the credit-apply).
  let handoffAppliedCredit = 0;
  let handoffTokenMinted = false;
  try {
    const secret = getHandoffSecret();
    if (!secret) {
      logger.error('[stripe-terminal] handoff mint refused — TERMINAL_HANDOFF_SECRET unset or too short');
      return res.status(500).json({ error: 'Handoff signing not configured' });
    }

    const { invoice_id } = req.body || {};
    if (!invoice_id) return res.status(400).json({ error: 'invoice_id required' });

    let invoice = await db('invoices').where({ id: invoice_id }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    // Technician scope (codex #5568 r1 P1): a technician mints a Tap to Pay
    // handoff only for a customer on their current/recent route; an admin is
    // unscoped. 404 so an invoice id observed elsewhere does not confirm
    // existence. Runs before any credit-apply side effect.
    if (!(await technicianMayCollectInvoice(req, invoice))) return res.status(404).json({ error: 'Invoice not found' });

    // Status + Bill-To guards run FIRST — before any Stripe cancellation or
    // credit-apply side effect — so we never cancel a payer's PaymentIntent (or
    // touch a terminal invoice) only to then reject the in-person collection.
    if (invoice.status === 'paid') return res.status(400).json({ error: 'Invoice already paid' });
    if (invoice.status === 'prepaid') return res.status(400).json({ error: 'Invoice is already prepaid' });
    if (invoice.status === 'processing') return res.status(409).json({ error: 'Bank payment is already processing' });
    // Third-party Bill-To: never mint an in-person collection handoff for a
    // payer-billed invoice — the tech must not collect the AP's invoice from the
    // service recipient. AR routes to the payer AP inbox.
    if (invoice.payer_id || invoiceWithdrawnFromCustomer(invoice)) {
      // A WITHDRAWN combined-visit invoice keeps payer_id NULL and a
      // collectible status — the Bill-To move is recorded only in its stamp
      // (Codex #4311 r31 P1) — so a payer_id-only guard let a technician mint
      // a card-present charge against debt the payer now owes.
      return res.status(400).json({ error: 'Invoice is billed to a third-party payer — do not collect in person' });
    }

    // Apply available account credit before pricing the handoff so the tech
    // collects amount due (total − applied credit), not the gross total — on this
    // charge-now path nothing else applies the credit first. No PI mutation here:
    // applyAccountCreditToInvoice fail-closes on any attached PaymentIntent, so a
    // stale /pay session simply isn't auto-applied rather than us cancelling it
    // (cancelling races with /pay and the later mint — that belongs inside the
    // mint's row lock, a follow-up). The common Tap-to-Pay flow is a
    // completion-created invoice with no PI and gets amount due here. Gated +
    // best-effort + idempotent; full coverage flips to 'prepaid', rejected below.
    //
    // Ownership + credit are ONE transaction (codex #5568 r16 P1): the locked
    // technician re-check runs FIRST and credit is applied only on a pass, so a
    // reassignment can never leave credit consumed — a full-coverage apply
    // flips the invoice to 'prepaid', which reverseAppliedCredit refuses to
    // undo. A miss applies nothing. Full-coverage side effects (stop dunning,
    // annual-prepay term sync) are deferred and run after commit.
    const { autoApplyAccountCreditIfEnabled, runPostFullCoverageSideEffects } = require('../services/customer-credit');
    let handoffCreditResult = null;
    const ownershipHeld = await db.transaction(async (trx) => {
      // Billing lock order (invoice → customer → visit), the order the credit
      // apply and saved-card collection take, so a concurrent collection
      // cannot deadlock against this ownership check (pre-push P1). The
      // credit apply below re-locks the same rows within this transaction.
      await trx('invoices').where({ id: invoice_id }).forUpdate().first('id');
      if (invoice.customer_id) await trx('customers').where({ id: invoice.customer_id }).forUpdate().first('id');
      if (!(await technicianMayCollectInvoiceLocked(trx, req, invoice))) return false;
      handoffCreditResult = await autoApplyAccountCreditIfEnabled(invoice_id, { trx, deferFullCoverageSideEffects: true });
      return true;
    });
    if (!ownershipHeld) return res.status(404).json({ error: 'Invoice not found' });
    handoffAppliedCredit = handoffCreditResult?.applied || 0;
    if (handoffCreditResult?.fullyCovered) {
      try {
        await runPostFullCoverageSideEffects(invoice_id);
      } catch (e) {
        logger.warn(`[stripe-terminal] post-coverage side effects skipped for ${invoice_id}: ${e.message}`);
      }
    }
    invoice = (await db('invoices').where({ id: invoice_id }).first()) || invoice;
    if (invoice.status === 'prepaid') {
      return res.status(400).json({ error: 'Invoice is now covered by account credit — no in-person collection needed' });
    }

    // Collect the amount DUE (total − applied account credit), not raw total.
    const amount_cents = Math.round(invoiceAmountDue(invoice) * 100);
    if (!amount_cents || amount_cents < 50) {
      return res.status(400).json({ error: 'Invalid invoice amount' });
    }

    let rateLimited = false;
    let rateLimitedCount = 0;
    let rateLimitedRetryAfter = 3600;
    let mintedJti = null;
    let mintedExpiresAt = null;
    let ownershipLostAtMint = false;

    await db.transaction(async (trx) => {
      // Locked re-validation of the technician's assignment BEFORE anything
      // else in the mint (no token row, no rate-limit write on a miss), in
      // the billing lock order invoice → customer → visit (pre-push P1).
      if (req.techRole === 'technician') {
        await trx('invoices').where({ id: invoice_id }).forUpdate().first('id');
        if (invoice.customer_id) await trx('customers').where({ id: invoice.customer_id }).forUpdate().first('id');
      }
      if (!(await technicianMayCollectInvoiceLocked(trx, req, invoice))) {
        ownershipLostAtMint = true;
        return;
      }

      // Serialize concurrent mints for this tech. Two int4 args give us a
      // namespace + key pair; the lock is held until the transaction ends.
      // Different techs get different keys and proceed in parallel.
      //
      // Explicit ::text cast on tech_user_id: hashtext() accepts text and
      // uuid has no implicit cast to text in all postgres versions. The
      // cast is free and makes the call safe if Knex ever hands us the
      // uuid as something other than a JS string.
      await trx.raw(
        'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
        ['terminal.handoff.mint', String(req.technicianId)],
      );

      // Single query for both the count AND the oldest qualifying row.
      // oldest.created_at + 1 hour is the moment the bucket frees up a
      // slot — we return that delta as Retry-After so iOS can render
      // "try again in N minutes" instead of a generic error.
      const [row] = await trx('terminal_handoff_tokens')
        .where('tech_user_id', req.technicianId)
        .where('created_at', '>', trx.raw("NOW() - INTERVAL '1 hour'"))
        .select(
          trx.raw('COUNT(*)::int AS count'),
          trx.raw('MIN(created_at) AS oldest'),
        );

      const recent = Number(row?.count || 0);

      if (recent >= HANDOFF_MINTS_PER_HOUR) {
        rateLimited = true;
        rateLimitedCount = recent;
        const oldestMs = row?.oldest ? new Date(row.oldest).getTime() : Date.now();
        const retryAtMs = oldestMs + 60 * 60 * 1000;
        rateLimitedRetryAfter = Math.max(1, Math.ceil((retryAtMs - Date.now()) / 1000));
        return; // commit with no writes — lock releases, count is unchanged
      }

      // 16 random bytes = 128 bits of entropy, 32 hex chars. Avoids the
      // UUID v4 dependency and gives us a primary-key-safe string we can
      // atomically burn on /validate-handoff.
      const jti = crypto.randomBytes(16).toString('hex');
      const expires_at = new Date(Date.now() + HANDOFF_TTL_SECONDS * 1000);

      // Insert the replay-tracking row BEFORE signing, so the PK is
      // reserved and the row is visible to the next rate-limit count. A
      // jti collision is ~1 in 2^128 — if it ever happens, the unique
      // violation surfaces here and no token is returned.
      //
      // invoice_id + amount_cents lock in the mint-time binding. /payment-
      // intent reads both from this row (not the request body, not the JWT
      // claims) so the data model enforces "this jti can only ever charge
      // this invoice for this amount." If the invoice total changes between
      // mint and validate, /validate-handoff rejects on amount_changed and
      // the tech re-handoffs for the new total. amount_cents here is also
      // the durable reconciliation record for disputes months down the road.
      await trx('terminal_handoff_tokens').insert({
        jti,
        tech_user_id: req.technicianId,
        invoice_id: invoice.id,
        amount_cents,
        expires_at,
        // Two-step proof of the minting session (GATE_ADMIN_MFA); this row is
        // the authority at validation, not the claim.
        staff_mfa: req.staffToken.mfa === true,
      });

      mintedJti = jti;
      mintedExpiresAt = expires_at;
    });

    if (ownershipLostAtMint) {
      // Same refusal as the pre-check above. Reverse the credit this seam
      // applied so the customer's credit is not consumed (and the invoice not
      // edit-locked) for a collection the technician is no longer assigned to.
      if (handoffCreditResult?.applied > 0) {
        try {
          const { reverseAppliedCredit } = require('../services/customer-credit');
          await reverseAppliedCredit({ invoiceId: invoice_id, amount: handoffCreditResult.applied, createdBy: 'system:handoff_not_assigned' });
        } catch (e) {
          logger.warn(`[stripe-terminal] credit reversal after unassigned handoff skipped for ${invoice_id}: ${e.message}`);
        }
      }
      return res.status(404).json({ error: 'Invoice not found' });
    }

    if (rateLimited) {
      auditTerminalHandoffRateLimited({
        tech_user_id: req.technicianId,
        invoice_id: invoice.id,
        recent_count: rateLimitedCount,
        retry_after_seconds: rateLimitedRetryAfter,
        ip_address: ipFromReq(req),
        user_agent: uaFromReq(req),
      });
      // Mint was rate-limited — no handoff/deep link issued. Reverse any credit
      // this seam applied above so we don't consume the customer's credit and
      // edit-lock an invoice the tech couldn't actually collect on.
      if (handoffCreditResult?.applied > 0) {
        try {
          const { reverseAppliedCredit } = require('../services/customer-credit');
          await reverseAppliedCredit({ invoiceId: invoice_id, amount: handoffCreditResult.applied, createdBy: 'system:handoff_rate_limited' });
        } catch (e) {
          logger.warn(`[stripe-terminal] credit reversal after rate-limited handoff skipped for ${invoice_id}: ${e.message}`);
        }
      }
      res.setHeader('Retry-After', String(rateLimitedRetryAfter));
      return res.status(429).json({
        error: 'Too many handoff mints. Try again in an hour.',
        retry_after_seconds: rateLimitedRetryAfter,
      });
    }

    const token = jwt.sign(
      {
        invoice_id: String(invoice.id),
        amount_cents,
        tech_user_id: req.technicianId,
        staff_token_version: req.staffToken.tokenVersion,
        // Two-step proof of the minting session (GATE_ADMIN_MFA), carried
        // into the terminal token so the current policy is applied to it.
        staff_mfa: req.staffToken.mfa === true,
        jti: mintedJti,
      },
      secret,
      {
        algorithm: 'HS256',
        issuer: HANDOFF_ISS,
        audience: HANDOFF_AUD,
        expiresIn: HANDOFF_TTL_SECONDS,
      },
    );

    // Fire-and-forget — the handoff_tokens row + Stripe PI are the primary
    // record. audit_log is secondary forensics.
    auditTerminalHandoffMint({
      tech_user_id: req.technicianId,
      invoice_id: invoice.id,
      amount_cents,
      jti: mintedJti,
      ip_address: ipFromReq(req),
      user_agent: uaFromReq(req),
    });

    handoffTokenMinted = true;
    res.json({
      token,
      deep_link: `wavespay://collect?t=${encodeURIComponent(token)}`,
      jti: mintedJti,
      expires_at: mintedExpiresAt.toISOString(),
    });
  } catch (err) {
    logger.error(`[stripe-terminal] handoff mint failed: ${err.message}`);
    // No handoff token was minted but we already applied credit above — return it
    // so an aborted mint doesn't strand the customer's credit + edit-lock the invoice.
    if (!handoffTokenMinted && handoffAppliedCredit > 0) {
      try {
        const { reverseAppliedCredit } = require('../services/customer-credit');
        await reverseAppliedCredit({ invoiceId: req.body?.invoice_id, amount: handoffAppliedCredit, createdBy: 'system:handoff_mint_failed' });
      } catch (e) {
        logger.warn(`[stripe-terminal] credit reversal after failed handoff mint skipped: ${e.message}`);
      }
    }
    res.status(500).json({ error: 'Handoff mint failed' });
  }
});

// POST /api/stripe/terminal/validate-handoff
// Called by the native iOS app with the handoff JWT. Authenticates the request
// purely via the signed token — no adminAuthenticate middleware. The jti is
// atomically burned so a second call with the same token is rejected.
//
// Body: { token }
// Returns (200): { invoice_id, customer_name, amount_cents, currency }
// Returns (401): signature_invalid (bad sig, wrong aud/iss, unknown jti)
// Returns (410): expired | replay
// Returns (409): invoice_status_changed | invoice_amount_changed | technician_not_active
//
// Every outcome is audited — mint-to-validate funnel + failure-mode
// distribution are the primary signals for the Tool Health Dashboard.
router.post('/validate-handoff', async (req, res) => {
  const ip = ipFromReq(req);
  const ua = uaFromReq(req);
  try {
    const secret = getHandoffSecret();
    if (!secret) {
      logger.error('[stripe-terminal] validate-handoff refused — TERMINAL_HANDOFF_SECRET unset or too short');
      return res.status(500).json({ error: 'Handoff signing not configured' });
    }

    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: 'token required' });

    let claims;
    try {
      claims = jwt.verify(token, secret, {
        audience: HANDOFF_AUD,
        issuer: HANDOFF_ISS,
        algorithms: ['HS256'],
      });
    } catch (err) {
      // Forensic-only decode: claims here are UNTRUSTED (signature failed or
      // aud/iss mismatched). We record them anyway so we can see what
      // tech_user_id / jti an attacker tried to forge against.
      const forensic = jwt.decode(token) || {};
      const expired = err.name === 'TokenExpiredError';
      auditTerminalHandoffValidate({
        tech_user_id: forensic.tech_user_id || null,
        invoice_id: forensic.invoice_id || null,
        jti: forensic.jti || null,
        outcome: expired ? 'expired' : 'signature_invalid',
        ip_address: ip,
        user_agent: ua,
      });
      if (expired) {
        return res.status(410).json({ error: 'Token expired', code: 'expired' });
      }
      return res.status(401).json({ error: 'Invalid token', code: 'signature_invalid' });
    }

    // A card-save token belongs to /validate-save-card-handoff. Refused BEFORE
    // the burn so a mis-routed token is not spent (the tech retries the right
    // route with the same token).
    if (claims.kind === SAVE_CARD_KIND) {
      auditTerminalHandoffValidate({
        tech_user_id: claims.tech_user_id || null,
        invoice_id: null,
        jti: claims.jti,
        outcome: 'wrong_kind',
        ip_address: ip,
        user_agent: ua,
      });
      return res.status(400).json({ error: 'This is a card-save token', code: 'wrong_token_kind' });
    }

    // Atomic burn. UPDATE ... WHERE used_at IS NULL holds a row lock under
    // any isolation level, so two concurrent validates for the same jti
    // cannot both succeed — one wins, the other sees zero rows affected.
    // DB-side expiry check protects against the narrow window where the JWT
    // exp hasn't quite fired but the DB row's expires_at has (clock drift).
    //
    // RETURNING the DB-side bindings (tech_user_id, invoice_id, amount_cents)
    // so the belt-and-suspenders recheck below can compare them against the
    // signed JWT claims. If they disagree, that's a signal of DB corruption,
    // cross-environment replay, or a bug — reject rather than trust either
    // source. Costs one extra comparison per validate.
    const burned = await db('terminal_handoff_tokens')
      .where({ jti: claims.jti, kind: 'collect' })
      .whereNull('used_at')
      .where('expires_at', '>', db.fn.now())
      .update({ used_at: db.fn.now() })
      .returning(['jti', 'tech_user_id', 'invoice_id', 'amount_cents', 'staff_mfa']);

    if (burned.length === 0) {
      // Disambiguate. Three reasons the UPDATE hit nothing:
      //   - row exists, used_at is set     → replay (410)
      //   - row exists, expires_at past    → expired (410) [rare — JWT exp
      //                                      would usually catch this first]
      //   - no row                         → forged jti against a valid sig
      //                                      (impossible unless secret leaked;
      //                                      treat as signature_invalid 401)
      const existing = await db('terminal_handoff_tokens').where({ jti: claims.jti }).first();
      if (existing && existing.kind !== 'collect') {
        return res.status(400).json({ error: 'This is a card-save token', code: 'wrong_token_kind' });
      }
      let outcome = 'signature_invalid';
      let status = 401;
      let errMsg = 'Invalid token';
      if (existing?.used_at) {
        outcome = 'replay';
        status = 410;
        errMsg = 'Token already used';
      } else if (existing) {
        outcome = 'expired';
        status = 410;
        errMsg = 'Token expired';
      }
      auditTerminalHandoffValidate({
        tech_user_id: claims.tech_user_id || null,
        invoice_id: claims.invoice_id || null,
        jti: claims.jti,
        outcome,
        ip_address: ip,
        user_agent: ua,
      });
      return res.status(status).json({ error: errMsg, code: outcome });
    }

    // jti is burned. Any failure path below leaves a consumed token and a
    // clear audit row — by design. The mint can't be re-used, the tech has
    // to request a fresh handoff, and the reason is explicit in the audit log.

    // Belt-and-suspenders: JWT claims must agree with the DB row that was
    // written at mint time. The JWT signature check already proves the
    // issuer signed these claims — but if the DB row's bindings disagree,
    // something is wrong (cross-env replay, DB corruption, migration bug).
    // Trust the DB row over the claim and reject. Cheap comparison, catches
    // a class of bug that would otherwise silently charge the wrong invoice.
    const handoffRow = burned[0];
    const claimInvoiceMatches = String(handoffRow.invoice_id) === String(claims.invoice_id);
    const claimAmountMatches = Number(handoffRow.amount_cents) === Number(claims.amount_cents);
    const claimTechMatches = String(handoffRow.tech_user_id) === String(claims.tech_user_id);
    const claimMfaMatches = (handoffRow.staff_mfa === true) === (claims.staff_mfa === true);
    if (!claimInvoiceMatches || !claimAmountMatches || !claimTechMatches || !claimMfaMatches) {
      logger.error(
        `[stripe-terminal] validate-handoff claim/db mismatch jti=${claims.jti} ` +
          `inv_claim=${claims.invoice_id} inv_db=${handoffRow.invoice_id} ` +
          `amt_claim=${claims.amount_cents} amt_db=${handoffRow.amount_cents} ` +
          `tech_claim=${claims.tech_user_id} tech_db=${handoffRow.tech_user_id}`,
      );
      auditTerminalHandoffValidate({
        tech_user_id: handoffRow.tech_user_id || null,
        invoice_id: handoffRow.invoice_id || null,
        jti: claims.jti,
        outcome: 'signature_invalid',
        ip_address: ip,
        user_agent: ua,
      });
      return res.status(401).json({ error: 'Invalid token', code: 'signature_invalid' });
    }

    // From here on the DB row is the authoritative source for invoice_id,
    // amount_cents, and tech_user_id. Stop reading from `claims` for those.
    const invoice = await db('invoices').where({ id: handoffRow.invoice_id }).first();
    // A Bill-To move committed between the mint and this validation is the
    // same refusal as a status change (r31 P1): the stamp is the only record.
    if (!invoice || invoiceWithdrawnFromCustomer(invoice)
      || ['paid', 'prepaid', 'processing', 'void', 'refunded'].includes(invoice.status)) {
      auditTerminalHandoffValidate({
        tech_user_id: handoffRow.tech_user_id || null,
        invoice_id: handoffRow.invoice_id || null,
        jti: claims.jti,
        outcome: 'invoice_changed',
        ip_address: ip,
        user_agent: ua,
      });
      return res.status(409).json({
        error: invoice ? `Invoice is ${invoice.status}` : 'Invoice not found',
        code: 'invoice_status_changed',
      });
    }

    // Compare the CURRENT invoice total against the mint-time amount stored
    // on the handoff row — not against the JWT claim. If the admin adjusted
    // the invoice between mint and validate, that shows up here and the tech
    // re-handoffs for the new total. handoffRow.amount_cents is the durable
    // reconciliation record.
    const invoiceAmountCents = Math.round(invoiceAmountDue(invoice) * 100);
    if (invoiceAmountCents !== Number(handoffRow.amount_cents)) {
      auditTerminalHandoffValidate({
        tech_user_id: handoffRow.tech_user_id || null,
        invoice_id: invoice.id,
        jti: claims.jti,
        outcome: 'invoice_changed',
        ip_address: ip,
        user_agent: ua,
      });
      return res.status(409).json({
        error: 'Invoice amount changed since handoff',
        code: 'invoice_amount_changed',
      });
    }

    const tech = await db('technicians').where({ id: handoffRow.tech_user_id }).first();
    if (!tech || !tech.active) {
      auditTerminalHandoffValidate({
        tech_user_id: handoffRow.tech_user_id || null,
        invoice_id: invoice.id,
        jti: claims.jti,
        outcome: 'tech_inactive',
        ip_address: ip,
        user_agent: ua,
      });
      return res.status(409).json({
        error: 'Technician not active',
        code: 'technician_not_active',
      });
    }
    if (!handoffStaffSessionMatches(claims, tech) || sessionMfaBlock({ mfa: handoffRow.staff_mfa === true }, tech)) {
      auditTerminalHandoffValidate({
        tech_user_id: handoffRow.tech_user_id || null,
        invoice_id: invoice.id,
        jti: claims.jti,
        outcome: 'session_revoked',
        ip_address: ip,
        user_agent: ua,
      });
      return res.status(401).json({
        error: 'Staff session has been revoked',
        code: 'staff_session_revoked',
      });
    }

    const customer = invoice.customer_id
      ? await db('customers').where({ id: invoice.customer_id }).first()
      : null;
    const customer_name = customer
      ? `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || null
      : null;

    auditTerminalHandoffValidate({
      tech_user_id: handoffRow.tech_user_id,
      invoice_id: invoice.id,
      jti: claims.jti,
      outcome: 'success',
      ip_address: ip,
      user_agent: ua,
    });

    // Mint a short-lived, terminal-scoped JWT so the iOS app's subsequent
    // /connection-token and /payment-intent calls succeed even if the
    // Keychain login token expired. scope:'terminal' is rejected by
    // adminAuthenticate, so this token can't access other admin routes.
    const authToken = jwt.sign(
      {
        technicianId: tech.id,
        role: tech.role,
        name: tech.name,
        scope: 'terminal',
        type: 'access',
        tokenVersion: Number(tech.auth_token_version),
        ...(handoffRow.staff_mfa === true ? { mfa: true } : {}),
      },
      config.jwt.secret,
      { expiresIn: '15m' },
    );

    const surchargeEnabled = isEnabled('terminalSurcharge');
    // Pre-tap disclosure amounts come from the SAME server surcharge calc the
    // PI is later raised by (computeSurchargeCents → planCardPresentSurcharge),
    // so the dollar amount the customer is shown, the Stripe amount, and the
    // recorded surcharge all agree. Funding is unknown until the tap, so we
    // surface BOTH the credit total (incl. 2.9%) and the unchanged debit base.
    const baseCents = Number(handoffRow.amount_cents);
    const surchargeCents = surchargeEnabled ? computeSurchargeCents(baseCents) : 0;
    return res.json({
      invoice_id: String(invoice.id),
      customer_name,
      amount_cents: baseCents,
      currency: 'usd',
      authToken,
      // Tells the iOS app whether the two-step credit-card surcharge is live.
      // When false the app skips /apply-surcharge entirely and collects
      // base-only (today's behavior); when true it shows the pre-tap surcharge
      // disclosure and runs the apply step between collect and confirm.
      surcharge_enabled: surchargeEnabled,
      // Server-calculated so the displayed credit total matches the charge.
      // Both zero/equal-to-base when the feature is off.
      surcharge_cents: surchargeCents,
      credit_total_cents: baseCents + surchargeCents,
      // What the customer pays for, shown on the amount and Paid screens.
      ...terminalInvoiceLines(invoice, customer, baseCents),
    });
  } catch (err) {
    logger.error(`[stripe-terminal] validate-handoff failed: ${err.message}`);
    return res.status(500).json({ error: 'Validation failed' });
  }
});

// ===========================================================================
// Tap to Pay card save (no charge) — "Book at the Table", PR 2.
//
//   POST /save-card-handoff           admin mints the 60 s deep link
//   POST /validate-save-card-handoff  the iPhone app burns it, gets the
//                                     SetupIntent and a card-save-only token
//   POST /complete-setup              the app reports the tap; the server
//                                     verifies Stripe and saves the card
//
// The shape mirrors the payment handoff (same secret, iss, aud, TTL, jti
// table, rate limit), but nothing here can move money: the terminal token
// carries save_card:true and terminalAuthenticate refuses it everywhere else.
// ===========================================================================

// The 404-when-off gate sits BEFORE auth so a dark gate is unobservable.
function tapSaveCardGate(req, res, next) {
  if (!isEnabled('tapSaveCard')) return res.status(404).json(require('../middleware/errors').notFoundBody(req));
  return next();
}

function saveCardMintRefusal(body) {
  if (body?.agreed !== true) {
    return { status: 400, body: { error: 'The customer must agree before the card is saved', code: 'consent_required' } };
  }
  const { renderedConsentVersionIsCurrent, consentVersionStaleResponse } = require('../services/payment-method-consent-text');
  if (!renderedConsentVersionIsCurrent(body.consent_text_version)) {
    return { status: 409, body: consentVersionStaleResponse() };
  }
  if (typeof body.secure_token !== 'string' || !body.secure_token) {
    return { status: 400, body: { error: 'secure_token required' } };
  }
  return null;
}

// Rate limit + jti reservation + SetupIntent + row, in the same advisory-locked
// transaction shape as /handoff (shared HANDOFF_MINTS_PER_HOUR budget). The
// SetupIntent is created INSIDE the transaction, after the limit check, so a
// limited mint creates nothing at Stripe; a Stripe failure rolls the whole
// mint back (no row, no token). The idempotency key is the jti, so a retried
// create replays the same intent.
async function mintSaveCardRow(req, { request, stripeCustomerId, consentTextVersion, feeMetadata = {} }) {
  const out = { rateLimited: false, count: 0, retryAfter: 3600, jti: null, expiresAt: null, setupIntentId: null };
  await db.transaction(async (trx) => {
    await trx.raw(
      'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
      ['terminal.handoff.mint', String(req.technicianId)],
    );
    const [row] = await trx('terminal_handoff_tokens')
      .where('tech_user_id', req.technicianId)
      .where('created_at', '>', trx.raw("NOW() - INTERVAL '1 hour'"))
      .select(trx.raw('COUNT(*)::int AS count'), trx.raw('MIN(created_at) AS oldest'));
    const recent = Number(row?.count || 0);
    if (recent >= HANDOFF_MINTS_PER_HOUR) {
      const oldestMs = row?.oldest ? new Date(row.oldest).getTime() : Date.now();
      out.rateLimited = true;
      out.count = recent;
      out.retryAfter = Math.max(1, Math.ceil((oldestMs + 60 * 60 * 1000 - Date.now()) / 1000));
      return;
    }
    const jti = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + HANDOFF_TTL_SECONDS * 1000);
    const setupIntent = await getStripe().setupIntents.create({
      payment_method_types: ['card_present'],
      customer: stripeCustomerId,
      usage: 'off_session',
      description: 'Waves appointment — card on file (Tap to Pay)',
      metadata: {
        appointment_card_request_id: String(request.id),
        scheduled_service_id: String(request.scheduled_service_id),
        source: 'admin_tap_to_pay',
        // The deferred-capture rule (finishVerifiedSecureCapture) records a
        // consent only under a current stamp.
        consent_text_version: consentTextVersion,
        ...feeMetadata,
      },
    }, { idempotencyKey: `tap_save_card_${jti}` });
    await trx('terminal_handoff_tokens').insert({
      jti,
      tech_user_id: req.technicianId,
      kind: SAVE_CARD_KIND,
      invoice_id: null,
      amount_cents: 0,
      appointment_card_request_id: request.id,
      stripe_setup_intent_id: setupIntent.id,
      consent_text_version: consentTextVersion,
      expires_at: expiresAt,
      staff_mfa: req.staffToken.mfa === true,
    });
    out.jti = jti;
    out.expiresAt = expiresAt;
    out.setupIntentId = setupIntent.id;
  });
  return out;
}

// Resolves the request behind the secure token and judges it. Returns
// { request, stripeCustomerId } or { refusal: { status, body } }.
async function resolveSaveCardMintTarget(secureToken) {
  const { resolveSaveCardRequest, saveCardEligibility, refusalBody } = require('../services/terminal-save-card');
  const resolved = await resolveSaveCardRequest(secureToken);
  if (!resolved.ok) return { refusal: { status: 404, body: { error: 'Not found' } } };
  const eligibility = await saveCardEligibility(resolved.request);
  if (!eligibility.ok) {
    return { refusal: { status: eligibility.code === 'completion_failed' ? 503 : 409, body: refusalBody(eligibility.code) } };
  }
  const stripeCustomerId = await require('../services/stripe').ensureStripeCustomer(resolved.request.customer_id);
  return { request: resolved.request, stripeCustomerId };
}

// POST /api/stripe/terminal/save-card-handoff
// Admin-only (same session/MFA rules as /handoff). Body:
//   { secure_token, consent_text_version, agreed, disclosure_version?,
//     fee_disclosed_amount? }
// fee_disclosed_amount (optional number): the cancellation fee the /secure page
// showed the customer. Fee consent is verified only when the request row has
// no_show_fee_amount > 0 and this equals it exactly; otherwise the capture saves
// the card and enrolls Auto Pay but stamps no fee agreement.
// disclosure_version (optional): the sticky cancel-window echo ('sticky_v1');
// any other value is ignored. Both are written into the SetupIntent metadata
// (fee_terms_agreed, fee_terms_amount_cents, disclosure_version), which is the
// only place completion (the app or the webhook) reads them from.
// Returns: { token, deep_link, jti, expires_at }
router.post('/save-card-handoff', tapSaveCardGate, noStore, adminAuthenticate, requireAdmin, async (req, res) => {
  try {
    const secret = getHandoffSecret();
    if (!secret) {
      logger.error('[stripe-terminal] save-card handoff mint refused — TERMINAL_HANDOFF_SECRET unset or too short');
      return res.status(500).json({ error: 'Handoff signing not configured' });
    }
    const bodyRefusal = saveCardMintRefusal(req.body);
    if (bodyRefusal) return res.status(bodyRefusal.status).json(bodyRefusal.body);

    const target = await resolveSaveCardMintTarget(req.body.secure_token);
    if (target.refusal) return res.status(target.refusal.status).json(target.refusal.body);
    const { request, stripeCustomerId } = target;
    const consentTextVersion = String(req.body.consent_text_version).trim();

    // Fee consent is verified here and written into the SetupIntent metadata
    // (the one source completion reads). Only the sticky echo the /secure
    // complete route honors is kept.
    const { STICKY_DISCLOSURE_VERSION } = require('../services/appointment-card-request');
    const disclosureVersion = req.body.disclosure_version === STICKY_DISCLOSURE_VERSION ? STICKY_DISCLOSURE_VERSION : null;
    const feeMetadata = require('../services/terminal-save-card').feeMetadata(request, {
      feeDisclosedAmount: req.body.fee_disclosed_amount,
      disclosureVersion,
    });
    const minted = await mintSaveCardRow(req, { request, stripeCustomerId, consentTextVersion, feeMetadata });
    if (minted.rateLimited) {
      auditTerminalHandoffRateLimited({
        tech_user_id: req.technicianId,
        invoice_id: null,
        recent_count: minted.count,
        retry_after_seconds: minted.retryAfter,
        ip_address: ipFromReq(req),
        user_agent: uaFromReq(req),
      });
      res.setHeader('Retry-After', String(minted.retryAfter));
      return res.status(429).json({
        error: 'Too many handoff mints. Try again in an hour.',
        retry_after_seconds: minted.retryAfter,
      });
    }

    const token = jwt.sign(
      {
        tech_user_id: req.technicianId,
        staff_token_version: req.staffToken.tokenVersion,
        staff_mfa: req.staffToken.mfa === true,
        jti: minted.jti,
        kind: SAVE_CARD_KIND,
        card_request_id: String(request.id),
      },
      secret,
      { algorithm: 'HS256', issuer: HANDOFF_ISS, audience: HANDOFF_AUD, expiresIn: HANDOFF_TTL_SECONDS },
    );
    auditTerminalHandoffMint({
      tech_user_id: req.technicianId,
      amount_cents: 0,
      jti: minted.jti,
      kind: SAVE_CARD_KIND,
      card_request_id: request.id,
      ip_address: ipFromReq(req),
      user_agent: uaFromReq(req),
    });
    return res.json({
      token,
      deep_link: `wavespay://save-card?t=${encodeURIComponent(token)}`,
      jti: minted.jti,
      expires_at: minted.expiresAt.toISOString(),
    });
  } catch (err) {
    logger.error(`[stripe-terminal] save-card handoff mint failed: ${err.message}`);
    return res.status(500).json({ error: 'Handoff mint failed' });
  }
});

// Atomic burn of a save_card jti (same contract as /validate-handoff's burn).
function burnSaveCardJti(jti) {
  return db('terminal_handoff_tokens')
    .where({ jti, kind: SAVE_CARD_KIND })
    .whereNull('used_at')
    .where('expires_at', '>', db.fn.now())
    .update({ used_at: db.fn.now() })
    .returning(['jti', 'tech_user_id', 'staff_mfa', 'appointment_card_request_id', 'stripe_setup_intent_id']);
}

// Why a burn hit nothing: replay / expired / unknown jti / a payment token.
async function saveCardBurnMiss(jti) {
  const existing = await db('terminal_handoff_tokens').where({ jti }).first();
  if (existing && existing.kind !== SAVE_CARD_KIND) {
    return { outcome: 'wrong_kind', status: 400, error: 'This is a payment token', code: 'wrong_token_kind' };
  }
  if (existing?.used_at) return { outcome: 'replay', status: 410, error: 'Token already used', code: 'replay' };
  if (existing) return { outcome: 'expired', status: 410, error: 'Token expired', code: 'expired' };
  return { outcome: 'signature_invalid', status: 401, error: 'Invalid token', code: 'signature_invalid' };
}

// The live SetupIntent the app confirms with the reader. Returns
// { setupIntent } or { refusal }.
async function loadSaveCardSetupIntent(row) {
  let setupIntent;
  try {
    setupIntent = await getStripe().setupIntents.retrieve(row.stripe_setup_intent_id);
  } catch (err) {
    logger.warn(`[stripe-terminal] save-card SetupIntent read failed for ${row.stripe_setup_intent_id}: ${err.message}`);
    return { refusal: { status: 503, body: { error: 'Could not reach the card service. Start a new handoff.', code: 'setup_intent_unavailable' } } };
  }
  if (!setupIntent
    || String(setupIntent.metadata?.appointment_card_request_id) !== String(row.appointment_card_request_id)
    || setupIntent.status !== 'requires_payment_method'
    || !setupIntent.client_secret) {
    return { refusal: { status: 409, body: { error: 'This card save cannot be started. Start a new handoff.', code: 'setup_intent_not_usable' } } };
  }
  return { setupIntent };
}

// Each step below returns { refusal: { status, body } } or its result; the
// route stops at the first refusal. `audit` writes the validate audit row.
function verifySaveCardJwt(token, secret, audit) {
  let claims;
  try {
    claims = jwt.verify(token, secret, { audience: HANDOFF_AUD, issuer: HANDOFF_ISS, algorithms: ['HS256'] });
  } catch (err) {
    const forensic = jwt.decode(token) || {};
    const expired = err.name === 'TokenExpiredError';
    audit({
      tech_user_id: forensic.tech_user_id || null,
      card_request_id: forensic.card_request_id || null,
      jti: forensic.jti || null,
      outcome: expired ? 'expired' : 'signature_invalid',
    });
    return expired
      ? { refusal: { status: 410, body: { error: 'Token expired', code: 'expired' } } }
      : { refusal: { status: 401, body: { error: 'Invalid token', code: 'signature_invalid' } } };
  }
  if (claims.kind !== SAVE_CARD_KIND) {
    audit({ tech_user_id: claims.tech_user_id || null, jti: claims.jti, outcome: 'wrong_kind' });
    return { refusal: { status: 400, body: { error: 'This is a payment token', code: 'wrong_token_kind' } } };
  }
  return { claims };
}

// Burns the jti and binds the DB row to the signed claims. The row, not the
// claim, is the authority from here on.
async function burnSaveCardHandoff(claims, audit) {
  const burned = await burnSaveCardJti(claims.jti);
  if (burned.length === 0) {
    const miss = await saveCardBurnMiss(claims.jti);
    audit({
      tech_user_id: claims.tech_user_id || null,
      card_request_id: claims.card_request_id || null,
      jti: claims.jti,
      outcome: miss.outcome,
    });
    return { refusal: { status: miss.status, body: { error: miss.error, code: miss.code } } };
  }
  const row = burned[0];
  const rowMatchesClaims = String(row.tech_user_id) === String(claims.tech_user_id)
    && (row.staff_mfa === true) === (claims.staff_mfa === true)
    && String(row.appointment_card_request_id) === String(claims.card_request_id);
  if (!rowMatchesClaims) {
    logger.error(`[stripe-terminal] validate-save-card-handoff claim/db mismatch jti=${claims.jti}`);
    audit({ tech_user_id: row.tech_user_id || null, card_request_id: row.appointment_card_request_id, jti: claims.jti, outcome: 'signature_invalid' });
    return { refusal: { status: 401, body: { error: 'Invalid token', code: 'signature_invalid' } } };
  }
  return { row };
}

// Staff re-checks: still active, same token version, two-step proof.
async function checkSaveCardStaff(row, claims, audit) {
  const base = { tech_user_id: row.tech_user_id || null, card_request_id: row.appointment_card_request_id, jti: claims.jti };
  const tech = await db('technicians').where({ id: row.tech_user_id }).first();
  if (!tech || !tech.active) {
    audit({ ...base, outcome: 'tech_inactive' });
    return { refusal: { status: 409, body: { error: 'Technician not active', code: 'technician_not_active' } } };
  }
  if (!handoffStaffSessionMatches(claims, tech) || sessionMfaBlock({ mfa: row.staff_mfa === true }, tech)) {
    audit({ ...base, outcome: 'session_revoked' });
    return { refusal: { status: 401, body: { error: 'Staff session has been revoked', code: 'staff_session_revoked' } } };
  }
  return { tech };
}

// The request must still be completable, and its SetupIntent still unused.
async function checkSaveCardRequest(row, claims, audit) {
  const base = { tech_user_id: row.tech_user_id, card_request_id: row.appointment_card_request_id, jti: claims.jti };
  const request = await db('appointment_card_requests').where({ id: row.appointment_card_request_id }).first();
  const eligibility = request
    ? await require('../services/terminal-save-card').saveCardEligibility(request)
    : { ok: false };
  if (!eligibility.ok) {
    audit({ ...base, outcome: 'request_changed' });
    return { refusal: { status: 409, body: { error: 'This card request changed since the handoff', code: 'request_changed' } } };
  }
  const loaded = await loadSaveCardSetupIntent(row);
  if (loaded.refusal) {
    audit({ ...base, outcome: 'setup_intent_unusable' });
    return loaded;
  }
  return { request, setupIntent: loaded.setupIntent };
}

// Terminal-scoped JWT, minted exactly like /validate-handoff's, plus the
// save_card marker (the fence reads it) and the jti /complete-setup reads.
function signSaveCardTerminalToken(tech, row) {
  return jwt.sign(
    {
      technicianId: tech.id,
      role: tech.role,
      name: tech.name,
      scope: 'terminal',
      type: 'access',
      tokenVersion: Number(tech.auth_token_version),
      ...(row.staff_mfa === true ? { mfa: true } : {}),
      save_card: true,
      jti: row.jti,
    },
    config.jwt.secret,
    { expiresIn: '15m' },
  );
}

// POST /api/stripe/terminal/validate-save-card-handoff
// PUBLIC like /validate-handoff: the signed token IS the auth.
// Body: { token }
// Returns (200): { kind: 'save_card', auth_token, setup_intent_client_secret,
//   setup_intent_id, customer_name, service_name, card_request_id }
// Errors: 401 signature_invalid, staff_session_revoked | 400 wrong_token_kind |
//   410 expired, replay | 409 technician_not_active, request_changed,
//   setup_intent_not_usable | 503 setup_intent_unavailable
router.post('/validate-save-card-handoff', noStore, async (req, res) => {
  const ip = ipFromReq(req);
  const ua = uaFromReq(req);
  const audit = (fields) => auditTerminalHandoffValidate({
    kind: SAVE_CARD_KIND, ip_address: ip, user_agent: ua, ...fields,
  });
  const refuse = (step) => res.status(step.refusal.status).json(step.refusal.body);
  try {
    const secret = getHandoffSecret();
    if (!secret) {
      logger.error('[stripe-terminal] validate-save-card-handoff refused — TERMINAL_HANDOFF_SECRET unset or too short');
      return res.status(500).json({ error: 'Handoff signing not configured' });
    }
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: 'token required' });

    const verified = verifySaveCardJwt(token, secret, audit);
    if (verified.refusal) return refuse(verified);
    // The jti is burned from here on. Any refusal leaves a spent token and an
    // audit row by design; the technician mints a fresh handoff.
    const burned = await burnSaveCardHandoff(verified.claims, audit);
    if (burned.refusal) return refuse(burned);
    const { row } = burned;
    const staff = await checkSaveCardStaff(row, verified.claims, audit);
    if (staff.refusal) return refuse(staff);
    const target = await checkSaveCardRequest(row, verified.claims, audit);
    if (target.refusal) return refuse(target);

    const { request, setupIntent } = target;
    const customer = await db('customers').where({ id: request.customer_id }).first();
    const visit = await db('scheduled_services').where({ id: request.scheduled_service_id }).first('service_type');
    audit({ tech_user_id: row.tech_user_id, card_request_id: row.appointment_card_request_id, jti: row.jti, outcome: 'success' });
    return res.json({
      kind: SAVE_CARD_KIND,
      auth_token: signSaveCardTerminalToken(staff.tech, row),
      setup_intent_client_secret: setupIntent.client_secret,
      setup_intent_id: setupIntent.id,
      customer_name: customer
        ? `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || null
        : null,
      service_name: visit?.service_type || null,
      card_request_id: String(request.id),
    });
  } catch (err) {
    logger.error(`[stripe-terminal] validate-save-card-handoff failed: ${err.message}`);
    return res.status(500).json({ error: 'Validation failed' });
  }
});

// Which handoff row a /complete-setup call may act on, or a refusal.
async function loadCompleteSetupHandoff(req, setupIntentId) {
  const jti = req.terminalClaims?.jti;
  const handoff = jti ? await db('terminal_handoff_tokens').where({ jti }).first() : null;
  if (!handoff) return { refusal: { status: 404, body: { error: 'Handoff not found', code: 'handoff_unknown' } } };
  if (handoff.kind !== SAVE_CARD_KIND) {
    return { refusal: { status: 403, body: { error: 'A card-save token is required', code: 'save_card_token_required' } } };
  }
  if (!handoff.used_at) {
    return { refusal: { status: 409, body: { error: 'Handoff not validated', code: 'handoff_not_validated' } } };
  }
  if (String(handoff.tech_user_id) !== String(req.technicianId)) {
    return { refusal: { status: 403, body: { error: 'Handoff belongs to a different technician', code: 'tech_mismatch' } } };
  }
  if (handoff.stripe_setup_intent_id !== setupIntentId) {
    return { refusal: { status: 409, body: { error: 'This is not the card save that was started', code: 'setup_intent_mismatch' } } };
  }
  return { handoff };
}

function completeSetupRefusal(result) {
  const { refusalBody } = require('../services/terminal-save-card');
  if (result.code === 'not_found') return { status: 404, body: { error: 'Not found' } };
  if (result.code === 'verification_failed') {
    return { status: 503, body: { error: 'Could not verify the card save. Try again.', code: 'verification_failed' } };
  }
  if (result.code === 'consent_version_stale') {
    const { consentVersionStaleResponse } = require('../services/payment-method-consent-text');
    return { status: 409, body: consentVersionStaleResponse() };
  }
  return { status: 409, body: refusalBody(result.code) };
}

// POST /api/stripe/terminal/complete-setup
// Terminal-authenticated with the save_card token. Body: { setup_intent_id }
// Returns: { ok: true, card: { brand, last4, funding } }. Safe to retry.
router.post('/complete-setup', noStore, terminalAuthenticateSaveCard, async (req, res) => {
  try {
    const setupIntentId = typeof req.body?.setup_intent_id === 'string' ? req.body.setup_intent_id.trim() : '';
    if (!setupIntentId) return res.status(400).json({ error: 'setup_intent_id required' });
    const loaded = await loadCompleteSetupHandoff(req, setupIntentId);
    if (loaded.refusal) return res.status(loaded.refusal.status).json(loaded.refusal.body);

    const result = await require('../services/terminal-save-card').completeTerminalSetup({
      handoff: loaded.handoff,
      setupIntentId,
      ip: ipFromReq(req) || null,
      userAgent: uaFromReq(req) || null,
    });
    if (!result.ok) {
      const refusal = completeSetupRefusal(result);
      return res.status(refusal.status).json(refusal.body);
    }
    return res.json({ ok: true, card: result.card });
  } catch (err) {
    logger.error(`[stripe-terminal] complete-setup failed: ${err.message}`);
    return res.status(500).json({ error: 'Could not save the card' });
  }
});

// POST /api/stripe/terminal/connection-token
// Issues a short-lived connection token to the iOS Terminal SDK.
// Auth: admin OR tech JWT (both roles can collect in person).
router.post('/connection-token', terminalAuthenticateAnyKind, async (req, res) => {
  try {
    const stripe = getStripe();
    const opts = TERMINAL_LOCATION_ID ? { location: TERMINAL_LOCATION_ID } : {};
    const token = await stripe.terminal.connectionTokens.create(opts);
    res.json({ secret: token.secret });
  } catch (err) {
    logger.error(`[stripe-terminal] connection-token failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stripe/terminal/payment-intent
// Creates the card_present PaymentIntent for a previously-validated handoff.
// iOS sends this after /validate-handoff has burned the jti and surfaced
// amount to the tech for confirmation. By the time this route is hit the
// binding work is already done — we just need to create the PI and record
// it on the handoff row.
//
// Auth: terminalAuthenticate (regular admin JWT or terminal-scoped JWT).
// Body: { jti }. invoice_id, amount, and the authorized tech are all
// read from the handoff row — never from the request.
//
// Timing: no TTL on this call. Once validate has burned the jti, the tech
// can take as long as they need to show the amount to the customer, answer
// questions, and tap charge. The 60s JWT mint window is UX-hostile for real
// customer interactions; this flow bounds the validate→PI gap with a 15m
// sweeper in scheduler.js instead.
//
// Idempotency: Stripe call uses Idempotency-Key `handoff_<jti>`. If the PI
// create succeeds but the subsequent UPDATE fails (DB blip, crash, network
// flake), the retry hits Stripe with the same key and Stripe returns the
// original PI — no duplicate charge. The UPDATE is idempotent too
// (stripe_payment_intent_id column, SET to the same value).
//
// Returns: { clientSecret, paymentIntentId, amount }
router.post('/payment-intent', terminalAuthenticate, async (req, res) => {
  try {
    const { jti } = req.body || {};
    if (!jti || typeof jti !== 'string') {
      return res.status(400).json({ error: 'jti required' });
    }

    // When the surcharge feature is live, only mint a PI for a client that can
    // run the post-tap surcharge step (it sends surcharge_capable:true). An app
    // that can't would confirm the base PI directly and settle a credit card
    // base-only — refuse rather than under-collect; the tech updates WavesPay and
    // retries. (The webhook also quarantines any un-finalized terminal credit PI
    // as a settlement-time backstop.)
    if (isEnabled('terminalSurcharge') && req.body?.surcharge_capable !== true) {
      return res.status(409).json({
        error: 'This WavesPay version cannot apply the required card surcharge. Update the app and try again.',
        code: 'app_update_required',
      });
    }

    // Look up the handoff row. The ONLY trusted source for invoice binding,
    // amount, and the tech who minted this handoff. Request body cannot
    // lie because the fields that matter aren't in the request body.
    const handoff = await db('terminal_handoff_tokens').where({ jti }).first();
    if (!handoff) {
      return res.status(404).json({ error: 'Handoff not found', code: 'handoff_unknown' });
    }
    // Second fence behind the token check: a save_card handoff row is never a
    // payment, whatever token presents its jti.
    if (handoff.kind === SAVE_CARD_KIND) {
      return res.status(403).json({ error: 'This handoff can only save a card', code: 'save_card_token' });
    }
    if (terminalHandoffNeedsReissue(handoff)) {
      return res.status(409).json({
        error: 'This payment handoff was canceled. Start a new handoff and try again.',
        code: 'handoff_reissue_required',
      });
    }
    if (!handoff.used_at) {
      return res.status(409).json({ error: 'Handoff not validated', code: 'handoff_not_validated' });
    }
    if (handoff.stripe_payment_intent_id) {
      // Clean "your iOS app already created a PI for this jti — use that
      // clientSecret" path. iOS should be retrieving the existing PI via
      // the Stripe API using the ID we return here, not re-creating.
      return res.status(409).json({
        error: 'Payment intent already created for this handoff',
        code: 'payment_intent_already_created',
        paymentIntentId: handoff.stripe_payment_intent_id,
      });
    }

    // Prevent tech-cross-use: if tech A's validated jti somehow ends up in
    // tech B's iOS app, the authenticated tech won't match the handoff row's
    // tech_user_id. 403 because this is a permission violation, not a state
    // violation. Logged at error level — this shouldn't happen in the
    // normal flow and warrants investigation.
    if (String(handoff.tech_user_id) !== String(req.technicianId)) {
      logger.error(
        `[stripe-terminal] payment-intent tech mismatch jti=${jti} ` +
          `handoff_tech=${handoff.tech_user_id} req_tech=${req.technicianId}`,
      );
      return res.status(403).json({ error: 'Handoff belongs to a different technician', code: 'tech_mismatch' });
    }

    // Re-verify invoice state at PI-create time. Between /validate-handoff
    // and /payment-intent, the invoice could have been voided, paid by the
    // office, or adjusted. These checks run against the current invoice
    // state and the mint-time snapshot in handoff.amount_cents.
    const invoice = await db('invoices').where({ id: handoff.invoice_id }).first();
    if (!invoice || ['paid', 'prepaid', 'processing', 'void', 'refunded'].includes(invoice.status)) {
      return res.status(409).json({
        error: invoice ? `Invoice is ${invoice.status}` : 'Invoice not found',
        code: 'invoice_status_changed',
      });
    }
    if (invoiceWithdrawnFromCustomer(invoice)) {
      return res.status(409).json({
        error: 'Invoice is billed to a third-party payer — do not collect in person',
        code: 'invoice_withdrawn_from_customer',
      });
    }
    const currentAmountCents = Math.round(invoiceAmountDue(invoice) * 100);
    if (currentAmountCents !== Number(handoff.amount_cents)) {
      return res.status(409).json({
        error: 'Invoice amount changed since handoff',
        code: 'invoice_amount_changed',
      });
    }
    try {
      await assertNoInvoiceChargeReconciliationPending(invoice.id);
      await assertInvoiceDepositSettlementReady(db, invoice, { lock: false });
    } catch (fenceErr) {
      if (fenceErr.code !== 'DEPOSIT_RECONCILIATION_REQUIRED'
        && fenceErr.code !== 'STRIPE_CHARGE_IN_PROGRESS'
        && fenceErr.code !== 'STRIPE_AMBIGUOUS_OUTCOME') throw fenceErr;
      if (fenceErr.reconciliationRequired) {
        await parkInvoiceForSavedCardReconciliation({ invoiceId: invoice.id, error: fenceErr });
      }
      return res.status(409).json(terminalChargeFenceResponse(fenceErr));
    }
    const tech = await db('technicians').where({ id: handoff.tech_user_id }).first();
    if (!tech || tech.active === false) {
      return res.status(409).json({
        error: 'Technician not active',
        code: 'technician_not_active',
      });
    }

    // Stripe PI create. Idempotency-Key ensures a retry returns the
    // original PI instead of creating a duplicate — the key scenario is
    // "Stripe succeeded but our UPDATE failed, iOS retries." The key is
    // bound to the jti so it's stable across retries but unique per handoff.
    const stripe = getStripe();
    const pi = await stripe.paymentIntents.create(
      {
        amount: Number(handoff.amount_cents),
        currency: 'usd',
        payment_method_types: ['card_present'],
        capture_method: 'automatic',
        metadata: {
          handoff_jti: jti,
          tech_user_id: String(handoff.tech_user_id),
          invoice_id: String(invoice.id),
          customer_id: String(invoice.customer_id || ''),
          source: 'tap_to_pay',
        },
      },
      { idempotencyKey: `handoff_${jti}` },
    );

    // Atomic backfill + FINAL collectibility re-check under a row lock. The
    // pre-create check at line ~560 is unlocked, so the office could mark the
    // invoice prepaid (apply account credit) between that read and here. Lock
    // the invoice, re-verify it's still collectible, and only then bind the PI.
    // If it went terminal in the meantime, cancel the PI we just minted and
    // reject — never hand a live client secret back for a settled invoice.
    // (apply-credit does the mirror re-check under the same lock, so whichever
    // transaction commits second detects the other and backs off.)
    let bound;
    try {
      bound = await db.transaction(async (trx) => {
      // Combined-session reservation INSIDE the bind transaction (codex
      // #3427 r30 P0, serialized r31 P0): the helper takes the
      // per-customer combined lock, re-reads the invoice under it, and
      // releases any combined session — held through the stamp write
      // below, so /setup cannot stamp a confirmable combined PI in the
      // gap before Terminal binds its card-present PI.
      await require('../services/pay-combined').releaseCombinedSessionBeforeCollection(trx, invoice, { context: 'collecting at the terminal' });
      const locked = await trx('invoices').where({ id: invoice.id }).forUpdate().first();
      if (!locked || ['paid', 'prepaid', 'processing', 'void', 'refunded'].includes(locked.status)) {
        return { ok: false, status: locked ? locked.status : null };
      }
      // The withdrawal re-read UNDER THE LOCK, like every other money seam:
      // a Bill-To assignment can commit while this transaction waits here.
      if (invoiceWithdrawnFromCustomer(locked)) {
        return { ok: false, withdrawn: true, status: locked.status };
      }
      // Amount agreement under the lock. Partial account credit can land between
      // the unlocked pre-create check and here WITHOUT flipping the invoice
      // terminal (it stays collectible at a reduced amount due), so the status
      // recheck above wouldn't catch it. Re-verify amount due against the minted
      // PI's amount — a mismatch means we'd bind a stale, pre-credit PI and
      // overcharge the card (and the terminal webhook, which skips tender
      // matching, would fold credit_applied back into total and corrupt
      // reconciliation). Back off and cancel the PI. (apply-credit skips when a
      // PI is already attached, so the two paths can't both commit.)
      const lockedAmountCents = Math.round(invoiceAmountDue(locked) * 100);
      if (lockedAmountCents !== Number(handoff.amount_cents)) {
        return { ok: false, amountChanged: true };
      }
      try {
        await assertInvoiceDepositSettlementReady(trx, locked);
      } catch (fenceErr) {
        if (fenceErr.code !== 'DEPOSIT_RECONCILIATION_REQUIRED') throw fenceErr;
        return { ok: false, chargeFence: terminalChargeFenceResponse(fenceErr) };
      }
      try {
        // Close the race between the unlocked pre-create fence check and PI
        // creation. If a saved-card owner claimed the invoice meanwhile, do
        // not bind or return this PI; the caller cancels it below.
        await assertNoInvoiceChargeReconciliationPending(invoice.id, trx);
      } catch (fenceErr) {
        if (fenceErr.reconciliationRequired) {
          // The invoice row is already locked by this transaction. Park it on
          // the same connection so status-only collection paths cannot race the
          // ambiguous saved-card owner while the new terminal PI is canceled.
          await trx('invoices').where({ id: invoice.id }).update({
            status: 'processing',
            stripe_payment_intent_id: fenceErr.stripePaymentIntentId || null,
            updated_at: trx.fn.now(),
          });
        }
        return { ok: false, chargeFence: terminalChargeFenceResponse(fenceErr) };
      }
      // Retire any OTHER open PaymentIntent the invoice still points at — the
      // /pay page mints one on load, and the bind below overwrites the pointer,
      // which would leave that client secret live and confirmable from a
      // still-open tab (Apple Pay / ACH confirm client-side) after the card is
      // tapped here: a second charge. The ONE mechanism for this is
      // services/prepaid-pi-guard (same as apply-credit, mark-prepaid and manual
      // payment): it cancels an open PI and refuses when money is in flight or
      // the PI can't be verified. Run AFTER the combined-session release above
      // (which already cleared any combined PI) and under the invoice row lock
      // taken here, so a pay-page mint serialized on that lock can't slip a new
      // PI in between this check and the bind. The invoice's own card-present PI
      // (pointer already equals pi.id) is never retired.
      if (locked.stripe_payment_intent_id && String(locked.stripe_payment_intent_id) !== String(pi.id)) {
        const piGuard = await require('../services/prepaid-pi-guard').guardOpenPaymentIntentForPrepaid(locked);
        if (!piGuard.ok) return { ok: false, piGuard };
      }
      // SET only if still NULL — two concurrent /payment-intent calls for the
      // same jti share an idempotency key and get the same PI back; first
      // UPDATE wins, second is a no-op.
      await trx('terminal_handoff_tokens')
        .where({ jti })
        .whereNull('stripe_payment_intent_id')
        .update({ stripe_payment_intent_id: pi.id });
      // Backfill the invoice row for admin-portal consistency (handoff row is
      // the source of truth for the terminal flow).
      await trx('invoices').where({ id: invoice.id }).update({ stripe_payment_intent_id: pi.id });
      return { ok: true };
    });
    } catch (releaseErr) {
      // 409-shaped combined-session refusals from the in-transaction
      // reservation surface as retryable conflicts.
      if (releaseErr.statusCode === 409) {
        return res.status(409).json({ error: releaseErr.message, code: 'combined_session_release_failed' });
      }
      throw releaseErr;
    }

    if (!bound.ok) {
      // PI was minted but the invoice changed under the lock (went terminal, or
      // account credit reduced the amount due) — cancel it so the card can't be
      // charged at the stale amount, then report the changed state. Permanently
      // invalidate this jti too: Stripe keys create by handoff_${jti}, so a later
      // retry would otherwise replay the canceled PI and return its unusable
      // client secret. expires_at <= used_at is the durable reissue marker; a
      // naturally expired but otherwise valid handoff remains distinguishable.
      let handoffInvalidated = false;
      try {
        const invalidated = await db('terminal_handoff_tokens')
          .where({ jti })
          .update({ expires_at: handoff.used_at });
        handoffInvalidated = invalidated > 0;
      } catch (invalidateErr) {
        logger.error(`[stripe-terminal] failed to invalidate canceled handoff ${jti}: ${invalidateErr.message}`);
      }
      await stripe.paymentIntents
        .cancel(pi.id, { cancellation_reason: 'abandoned' })
        .catch((e) => logger.warn(`[stripe-terminal] failed to cancel orphaned PI ${pi.id}: ${e.message}`));
      if (!handoffInvalidated) {
        // Fail closed. A retry will replay the same Stripe PI, reach this branch,
        // and retry the durable invalidation before any client secret is exposed.
        throw new Error('Payment handoff could not be invalidated; start a new handoff');
      }
      if (bound.amountChanged) {
        return res.status(409).json({
          error: 'Invoice amount changed since handoff',
          code: 'invoice_amount_changed',
        });
      }
      if (bound.chargeFence) {
        return res.status(409).json({ ...bound.chargeFence, newHandoffRequired: true });
      }
      if (bound.withdrawn) {
        return res.status(409).json({
          error: 'Invoice is billed to a third-party payer — do not collect in person',
          code: 'invoice_withdrawn_from_customer',
        });
      }
      if (bound.piGuard) {
        // The customer's own pay-page payment is already settling (or could not
        // be verified/closed) — never take a second payment beside it.
        if (bound.piGuard.reason === 'payment_in_flight') {
          return res.status(409).json({
            error: 'A payment is already in progress on this invoice — do not collect in person. Check the invoice status before trying again.',
            code: 'payment_in_flight',
            newHandoffRequired: true,
          });
        }
        return res.status(409).json({
          error: 'Could not verify or close the customer\'s open payment session — try again with a new handoff.',
          code: 'payment_session_unverifiable',
          newHandoffRequired: true,
        });
      }
      return res.status(409).json({
        error: bound.status ? `Invoice is ${bound.status}` : 'Invoice not found',
        code: 'invoice_status_changed',
      });
    }

    res.json({
      clientSecret: pi.client_secret,
      paymentIntentId: pi.id,
      amount: Number(handoff.amount_cents),
    });
  } catch (err) {
    logger.error(`[stripe-terminal] payment-intent failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stripe/terminal/apply-surcharge
// The second step of the card-present surcharge flow. Card-present funding is
// only known AFTER the tap, so /payment-intent mints the PI at base; the iOS app
// calls this between collectPaymentMethod and confirmPaymentIntent — once Stripe
// has read the card and attached the card_present PaymentMethod — to raise the PI
// to base + 2.9% surcharge, but ONLY when the card reads as credit. Debit,
// prepaid, and unknown funding stay at base (metadata stamped, amount untouched),
// matching the online flow's positively-confirmed-credit-only rule.
//
// Gate: GATE_TERMINAL_SURCHARGE. When OFF this is a hard no-op (applied:false),
// so an iOS build that always calls it still collects base-only exactly like
// today until the feature is field-tested and flipped on.
//
// Auth: terminalAuthenticate. Body: { jti }. Like /payment-intent, every
// trusted field (invoice, base amount, tech) is read from the handoff row.
//
// Idempotency: re-invocation is safe. Once a prior call stamps
// surcharge_policy_version on the PI we report the existing state without
// re-raising the amount. The Stripe update also carries Idempotency-Key
// `surcharge_<jti>` so a retried network flake can't double-apply.
//
// Structured result, never a 500 for recoverable states: a too-early call
// (awaiting_card), a non-updatable PI (pi_not_updatable), or a Stripe update
// failure (apply_failed) all return 200 with applied:false + a reason. The iOS
// client decides from that reason whether to confirm (applied:true, or a
// definitive debit/prepaid/unknown no-surcharge) or abort+retry (any failure
// reason) — it must NOT silently confirm at base once disclosure was shown.
//
// Returns: { applied, funding, base, surcharge, total, rateBps, reason? } (cents).
router.post('/apply-surcharge', terminalAuthenticate, async (req, res) => {
  try {
    const { jti } = req.body || {};
    if (!jti || typeof jti !== 'string') {
      return res.status(400).json({ error: 'jti required' });
    }

    const handoff = await db('terminal_handoff_tokens').where({ jti }).first();
    if (!handoff) {
      return res.status(404).json({ error: 'Handoff not found', code: 'handoff_unknown' });
    }
    // Second fence behind the token check: a save_card handoff row is never a
    // payment, whatever token presents its jti.
    if (handoff.kind === SAVE_CARD_KIND) {
      return res.status(403).json({ error: 'This handoff can only save a card', code: 'save_card_token' });
    }
    if (!handoff.used_at) {
      return res.status(409).json({ error: 'Handoff not validated', code: 'handoff_not_validated' });
    }
    if (!handoff.stripe_payment_intent_id) {
      // Surcharge can only be applied after /payment-intent has minted the PI.
      return res.status(409).json({ error: 'Payment intent not created yet', code: 'payment_intent_not_created' });
    }
    if (String(handoff.tech_user_id) !== String(req.technicianId)) {
      logger.error(
        `[stripe-terminal] apply-surcharge tech mismatch jti=${jti} ` +
          `handoff_tech=${handoff.tech_user_id} req_tech=${req.technicianId}`,
      );
      return res.status(403).json({ error: 'Handoff belongs to a different technician', code: 'tech_mismatch' });
    }

    // Re-verify the invoice hasn't gone terminal or changed its amount due since
    // the PI was minted — mirror of the /payment-intent checks. The surcharge rides
    // on the PI, not the invoice, but if the base itself moved the whole charge is
    // stale and the tech must re-handoff. The handoff is minted for the amount DUE
    // (total − applied account credit), so verify against that, not the gross total
    // — else a partially credit-applied invoice always mismatches here.
    // Keep the invoice and estimate ledger locks through either Stripe update
    // or the already-finalized response. A deposit can arrive after the
    // Terminal PI was minted but before the technician confirms it.
    return await db.transaction(async (trx) => {
      const invoice = await trx('invoices').where({ id: handoff.invoice_id }).forUpdate().first();
      if (!invoice || ['paid', 'prepaid', 'processing', 'void', 'refunded'].includes(invoice.status)) {
        return res.status(409).json({
          error: invoice ? `Invoice is ${invoice.status}` : 'Invoice not found',
          code: 'invoice_status_changed',
        });
      }
      const baseCents = Number(handoff.amount_cents);
      if (Math.round(invoiceAmountDue(invoice) * 100) !== baseCents) {
        return res.status(409).json({ error: 'Invoice amount changed since handoff', code: 'invoice_amount_changed' });
      }
      await assertInvoiceDepositSettlementReady(trx, invoice);

      // Feature off → no surcharge write. Still fence the last server step
      // before this already-created PI can be confirmed by the device.
      if (!isEnabled('terminalSurcharge')) {
        return res.json({ applied: false, reason: 'disabled' });
      }

      const stripe = getStripe();
      // Retrieve under the preview API version so amount_details (a preview field)
      // is present on re-reads; expand payment_method to read card_present funding.
      const pi = await stripe.paymentIntents.retrieve(
        handoff.stripe_payment_intent_id,
        { expand: ['payment_method'] },
        { apiVersion: SURCHARGE_API_VERSION },
      );

      // Only finalize once the card has actually been read: the PI must be at
      // requires_confirmation WITH the card_present PaymentMethod attached. Before
      // that (requires_payment_method / no PM) funding is unknowable — return a
      // retryable signal and write NOTHING (no metadata, no idempotency-key burn).
      // Stamping the PI base-only here would otherwise let a later, post-collect
      // credit-card call short-circuit on the already-finalized path and settle
      // without the surcharge (the exact leak this route closes).
      const pm = pi.payment_method && typeof pi.payment_method === 'object' ? pi.payment_method : null;
      if (pi.status === 'requires_payment_method' || !pm) {
        return res.json({ applied: false, reason: 'awaiting_card', retryable: true });
      }
      if (pi.status !== 'requires_confirmation') {
        // succeeded / processing / canceled / requires_capture / requires_action —
        // past the point of a safe amount change.
        return res.json({ applied: false, reason: 'pi_not_updatable', status: pi.status });
      }

      // Funding is now final (credit/debit/prepaid/unknown). null/unknown → no
      // surcharge (fail-safe), same as the online flow.
      const funding = pm.card_present?.funding || pm.card?.funding || null;
      const alreadyFinalized = !!pi.metadata?.surcharge_policy_version;

      const plan = planCardPresentSurcharge({ baseCents, funding, alreadyFinalized });

      if (plan.action === 'already') {
        // A prior call already stamped/raised this PI. Report what's on it now —
        // derive the surcharge from the amount delta so it's correct regardless of
        // whether amount_details came back on this read.
        const existingSurcharge = Math.max(0, Number(pi.amount) - baseCents);
        return res.json({
          applied: existingSurcharge > 0,
          funding,
          base: baseCents,
          surcharge: existingSurcharge,
          total: Number(pi.amount),
          rateBps: Number(pi.metadata?.surcharge_rate_bps || 0),
          reason: 'already_finalized',
        });
      }

      // Metadata mirrors the online finalize path so the webhook's payment-insert
      // records base/surcharge/funding identically for card-present and online.
      const metadata = {
        base_amount: String(baseCents / 100),
        card_surcharge: String(plan.surchargeCents / 100),
        surcharge_rate_bps: String(plan.rateBps),
        surcharge_policy_version: plan.policyVersion,
        card_funding: funding || 'unknown',
      };

      try {
        if (plan.action === 'apply_surcharge') {
          // Raise amount + attach the surcharge breakdown. amount_details requires
          // the preview API version, passed per-request so the rest of the app
          // stays on the account's stable version.
          await stripe.paymentIntents.update(
            pi.id,
            {
              amount: plan.totalCents,
              amount_details: buildSurchargeAmountDetails(plan.surchargeCents, { enforceValidation: 'disabled' }),
              metadata,
            },
            { apiVersion: SURCHARGE_API_VERSION, idempotencyKey: `surcharge_${jti}` },
          );
          logger.info(
            `[stripe-terminal] apply-surcharge jti=${jti} PI=${pi.id} funding=${funding} ` +
              `base=${baseCents}c surcharge=${plan.surchargeCents}c total=${plan.totalCents}c`,
          );
          return res.json({
            applied: true,
            funding,
            base: baseCents,
            surcharge: plan.surchargeCents,
            total: plan.totalCents,
            rateBps: plan.rateBps,
          });
        }

        // finalize_base — debit/prepaid/unknown. Stamp funding + zero surcharge so
        // the payment record is honest; never touch the amount, never go preview.
        await stripe.paymentIntents.update(pi.id, { metadata }, { idempotencyKey: `surcharge_${jti}` });
        logger.info(`[stripe-terminal] apply-surcharge jti=${jti} PI=${pi.id} funding=${funding || 'unknown'} no-surcharge (base only)`);
        return res.json({ applied: false, funding, base: baseCents, surcharge: 0, total: baseCents });
      } catch (updateErr) {
        // The update failed, so the PI is untouched (still at base) and no metadata
        // was stamped — retrying is safe. Report apply_failed so the client aborts
        // rather than settling a credit card at base after disclosure. Surface for
        // monitoring; the tech re-taps.
        logger.error(`[stripe-terminal] apply-surcharge update failed jti=${jti} PI=${pi.id}: ${updateErr.message}`);
        return res.json({ applied: false, reason: 'apply_failed', funding, base: baseCents });
      }
    });
  } catch (err) {
    if (err.code === 'DEPOSIT_RECONCILIATION_REQUIRED') {
      return res.status(409).json(terminalChargeFenceResponse(err));
    }
    logger.error(`[stripe-terminal] apply-surcharge failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stripe/terminal/capture
// Manual capture path (if we ever switch capture_method to 'manual').
// Body: { paymentIntentId }
// Admin-only (codex #5568 r1 P1): captures an arbitrary PaymentIntent id with
// no handoff binding, and no field flow calls it (capture_method is automatic).
router.post('/capture', adminAuthenticate, requireAdmin, async (req, res) => {
  try {
    const { paymentIntentId } = req.body;
    if (!paymentIntentId) return res.status(400).json({ error: 'paymentIntentId required' });
    const stripe = getStripe();
    const pi = await stripe.paymentIntents.capture(paymentIntentId);
    res.json({ status: pi.status, paymentIntentId: pi.id });
  } catch (err) {
    logger.error(`[stripe-terminal] capture failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports._test = {
  handoffStaffSessionMatches,
  terminalAuthenticate,
  terminalAuthenticateAnyKind,
  terminalAuthenticateSaveCard,
  technicianMayCollectInvoice,
  technicianMayCollectInvoiceLocked,
  terminalChargeFenceResponse,
  terminalHandoffNeedsReissue,
  terminalInvoiceLines,
};
