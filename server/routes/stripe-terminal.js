const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
const db = require('../models/db');
const logger = require('../services/logger');
const stripeConfig = require('../config/stripe-config');
const config = require('../config');
const { adminAuthenticate } = require('../middleware/admin-auth');
const { isEnabled } = require('../config/feature-gates');
const {
  buildSurchargeAmountDetails,
  computeSurchargeCents,
  planCardPresentSurcharge,
  SURCHARGE_API_VERSION,
} = require('../services/stripe-pricing');
const { invoiceAmountDue } = require('../services/invoice-helpers');

// Accepts both regular admin JWTs and terminal-scoped JWTs (minted by
// /validate-handoff). Regular adminAuthenticate rejects scope:'terminal'
// so these tokens can't escalate to other admin routes.
async function terminalAuthenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], config.jwt.secret);
    if (!decoded.technicianId) return res.status(401).json({ error: 'Invalid token' });
    if (decoded.scope && decoded.scope !== 'terminal') {
      return res.status(401).json({ error: 'Invalid token scope' });
    }
    const tech = await db('technicians').where({ id: decoded.technicianId }).first();
    if (!tech || !tech.active) return res.status(401).json({ error: 'Account not found or inactive' });
    req.technician = tech;
    req.technicianId = tech.id;
    req.techRole = tech.role;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    return res.status(401).json({ error: 'Invalid token' });
  }
}

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

    // Status + Bill-To guards run FIRST — before any Stripe cancellation or
    // credit-apply side effect — so we never cancel a payer's PaymentIntent (or
    // touch a terminal invoice) only to then reject the in-person collection.
    if (invoice.status === 'paid') return res.status(400).json({ error: 'Invoice already paid' });
    if (invoice.status === 'prepaid') return res.status(400).json({ error: 'Invoice is already prepaid' });
    if (invoice.status === 'processing') return res.status(409).json({ error: 'Bank payment is already processing' });
    // Third-party Bill-To: never mint an in-person collection handoff for a
    // payer-billed invoice — the tech must not collect the AP's invoice from the
    // service recipient. AR routes to the payer AP inbox.
    if (invoice.payer_id) return res.status(400).json({ error: 'Invoice is billed to a third-party payer — do not collect in person' });

    // Apply available account credit before pricing the handoff so the tech
    // collects amount due (total − applied credit), not the gross total — on this
    // charge-now path nothing else applies the credit first. No PI mutation here:
    // applyAccountCreditToInvoice fail-closes on any attached PaymentIntent, so a
    // stale /pay session simply isn't auto-applied rather than us cancelling it
    // (cancelling races with /pay and the later mint — that belongs inside the
    // mint's row lock, a follow-up). The common Tap-to-Pay flow is a
    // completion-created invoice with no PI and gets amount due here. Gated +
    // best-effort + idempotent; full coverage flips to 'prepaid', rejected below.
    const { autoApplyAccountCreditIfEnabled } = require('../services/customer-credit');
    const handoffCreditResult = await autoApplyAccountCreditIfEnabled(invoice_id);
    handoffAppliedCredit = handoffCreditResult?.applied || 0;
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

    await db.transaction(async (trx) => {
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
      });

      mintedJti = jti;
      mintedExpiresAt = expires_at;
    });

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
      .where({ jti: claims.jti })
      .whereNull('used_at')
      .where('expires_at', '>', db.fn.now())
      .update({ used_at: db.fn.now() })
      .returning(['jti', 'tech_user_id', 'invoice_id', 'amount_cents']);

    if (burned.length === 0) {
      // Disambiguate. Three reasons the UPDATE hit nothing:
      //   - row exists, used_at is set     → replay (410)
      //   - row exists, expires_at past    → expired (410) [rare — JWT exp
      //                                      would usually catch this first]
      //   - no row                         → forged jti against a valid sig
      //                                      (impossible unless secret leaked;
      //                                      treat as signature_invalid 401)
      const existing = await db('terminal_handoff_tokens').where({ jti: claims.jti }).first();
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
    if (!claimInvoiceMatches || !claimAmountMatches || !claimTechMatches) {
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
    if (!invoice || ['paid', 'prepaid', 'processing', 'void', 'refunded'].includes(invoice.status)) {
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
    if (!tech || tech.active === false) {
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
      { technicianId: tech.id, role: tech.role, name: tech.name, scope: 'terminal' },
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
    });
  } catch (err) {
    logger.error(`[stripe-terminal] validate-handoff failed: ${err.message}`);
    return res.status(500).json({ error: 'Validation failed' });
  }
});

// POST /api/stripe/terminal/connection-token
// Issues a short-lived connection token to the iOS Terminal SDK.
// Auth: admin OR tech JWT (both roles can collect in person).
router.post('/connection-token', terminalAuthenticate, async (req, res) => {
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
    const currentAmountCents = Math.round(invoiceAmountDue(invoice) * 100);
    if (currentAmountCents !== Number(handoff.amount_cents)) {
      return res.status(409).json({
        error: 'Invoice amount changed since handoff',
        code: 'invoice_amount_changed',
      });
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
    const bound = await db.transaction(async (trx) => {
      const locked = await trx('invoices').where({ id: invoice.id }).forUpdate().first();
      if (!locked || ['paid', 'prepaid', 'processing', 'void', 'refunded'].includes(locked.status)) {
        return { ok: false, status: locked ? locked.status : null };
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

    if (!bound.ok) {
      // PI was minted but the invoice changed under the lock (went terminal, or
      // account credit reduced the amount due) — cancel it so the card can't be
      // charged at the stale amount, then report the changed state.
      await stripe.paymentIntents
        .cancel(pi.id, { cancellation_reason: 'abandoned' })
        .catch((e) => logger.warn(`[stripe-terminal] failed to cancel orphaned PI ${pi.id}: ${e.message}`));
      if (bound.amountChanged) {
        return res.status(409).json({
          error: 'Invoice amount changed since handoff',
          code: 'invoice_amount_changed',
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

    // Feature off → no-op. The PI stays at base and the device confirms it as-is.
    if (!isEnabled('terminalSurcharge')) {
      return res.json({ applied: false, reason: 'disabled' });
    }

    const handoff = await db('terminal_handoff_tokens').where({ jti }).first();
    if (!handoff) {
      return res.status(404).json({ error: 'Handoff not found', code: 'handoff_unknown' });
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
    const invoice = await db('invoices').where({ id: handoff.invoice_id }).first();
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
  } catch (err) {
    logger.error(`[stripe-terminal] apply-surcharge failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stripe/terminal/capture
// Manual capture path (if we ever switch capture_method to 'manual').
// Body: { paymentIntentId }
router.post('/capture', adminAuthenticate, async (req, res) => {
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
