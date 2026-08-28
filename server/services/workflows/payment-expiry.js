const db = require('../../models/db');
const logger = require('../logger');
const { etDateString } = require('../../utils/datetime-et');
const { sendCustomerMessage } = require('../messaging/send-customer-message');
const { renderSmsTemplate } = require('../sms-template-renderer');
const PaymentLifecycleEmail = require('../payment-lifecycle-email');

class PaymentExpiry {
  /**
   * Check for credit cards expiring this month or next month.
   * Notify customers via SMS and create dashboard alerts.
   */
  async checkExpiringCards() {
    const now = new Date();
    // ET calendar month, not the server's UTC (hook P1): getMonth() on
    // Railway rolls at 8/7pm ET, so a final-evening run would scan the
    // NEXT two months and skip the current ET month entirely.
    const [thisYear, thisMonth] = etDateString(now).split('-').map(Number);

    // Next month (handle December → January rollover)
    const nextMonth = thisMonth === 12 ? 1 : thisMonth + 1;
    const nextYear = thisMonth === 12 ? thisYear + 1 : thisYear;

    // Query payment methods expiring this month or next.
    // Scope: live Stripe rows for customers we still serve — the unfiltered
    // version texted churned/deleted customers about dead cards (and legacy
    // Square rows). Former stages are excluded even when the active flag is
    // stale; a NULL pipeline_stage (legacy rows) stays included. exp_* are
    // varchar and legacy rows hold 2-digit years — compare via guarded
    // casts (CASE evaluates THEN only after the WHEN regexes pass, so a
    // non-numeric value never reaches ::integer), normalizing years < 100
    // by +2000 like the charge path does.
    const { FORMER_CUSTOMER_STAGES } = require('../customer-stages');
    const expiringCards = await db('payment_methods as pm')
      .join('customers as c', 'pm.customer_id', 'c.id')
      .where('pm.processor', 'stripe')
      // CARD rows only (hook P1): a bank/ACH row with populated legacy
      // expiry fields must never receive a "card expiring" notice. NULL
      // method_type = legacy card rows, kept.
      .whereRaw(`(pm.method_type IS NULL OR pm.method_type NOT IN ('ach', 'us_bank_account', 'bank', 'bank_account'))`)
      .where('c.active', true)
      .whereNull('c.deleted_at')
      .where(function () {
        this.whereNull('c.pipeline_stage')
          .orWhereNotIn('c.pipeline_stage', [...FORMER_CUSTOMER_STAGES, 'lost']);
      })
      // Lead-stage rows (customers.active defaults TRUE for CRM leads) only
      // get expiry notices when a real payment relationship exists — the
      // stuck-at-new_lead PAYER gap is documented in customer-stages.js,
      // but a pure lead with a saved card must not be texted about billing
      // (hook r5 P1).
      .where(function () {
        this.whereIn('c.pipeline_stage', ['active_customer', 'won', 'at_risk'])
          .orWhereExists(function () {
            this.select(db.raw('1')).from('payments as p')
              .whereRaw('p.customer_id = c.id')
              .where('p.status', 'paid');
          })
          // Booked-but-stuck-at-new_lead (the documented lead-booking reuse
          // gap in customer-stages.js): an upcoming visit is a real payment
          // relationship even before the first paid ledger row — their card
          // expiring matters (codex P2).
          .orWhereExists(function () {
            this.select(db.raw('1')).from('scheduled_services as ss')
              .whereRaw('ss.customer_id = c.id')
              .whereIn('ss.status', ['pending', 'confirmed'])
              // ET date, not the session's UTC CURRENT_DATE (hook P1):
              // Railway runs UTC, so CURRENT_DATE rolls at 8/7pm ET and
              // would drop an ET-today visit from the relationship guard.
              .whereRaw('ss.scheduled_date >= ?', [etDateString(now)]);
          });
      })
      // Only the customer's ONE current method, charge-path semantics: the
      // enrollment pointer when set; otherwise the single newest default
      // row (legacy data permits multiple defaults — without the NOT EXISTS
      // dedupe a customer gets one notice per stale default). Replaced
      // cards linger with is_default=false and never match (hook P1 ×2).
      .whereRaw(`(
        (pm.id = c.autopay_payment_method_id AND pm.autopay_enabled = true
          AND pm.stripe_payment_method_id IS NOT NULL)
        OR (
          pm.is_default = true
          AND pm.autopay_enabled = true
          AND pm.stripe_payment_method_id IS NOT NULL
          -- fallback fires when the pointer is absent OR ineligible
          -- (disabled, or a bank row) — mirroring the charge path's
          -- pointer-then-default walk; a stale pointer must not suppress
          -- the real card's warning (hook P1).
          AND NOT EXISTS (
            SELECT 1 FROM payment_methods pp
             WHERE pp.id = c.autopay_payment_method_id
               AND pp.customer_id = c.id
               AND pp.processor = 'stripe' AND pp.autopay_enabled = true
               AND pp.stripe_payment_method_id IS NOT NULL
               -- the pointer only suppresses the fallback when charge()
               -- would actually accept it (hook P1 ×2): a healthy BANK
               -- pointer counts (the customer is charged via ACH, so no
               -- card notice should fire at all); a CARD pointer counts
               -- only unexpired (guarded casts + 2-digit rule); an
               -- expired/shell/blocked pointer falls back to the default
               -- card, whose warning must fire.
               AND (
                 (
                   pp.method_type IN ('ach', 'us_bank_account', 'bank', 'bank_account')
                   AND (c.ach_status IS NULL OR c.ach_status = '' OR c.ach_status = 'active')
                   AND (pp.ach_status IS NULL
                        OR pp.ach_status NOT IN ('pending_verification', 'verification_failed'))
                 )
                 OR (
                 (pp.method_type IS NULL
                    OR pp.method_type NOT IN ('ach', 'us_bank_account', 'bank', 'bank_account'))
               AND CASE
                     WHEN NULLIF(BTRIM(pp.exp_month), '') ~ '^[0-9]{1,2}$'
                       AND NULLIF(BTRIM(pp.exp_year), '') ~ '^([0-9]{2}|[0-9]{4})$'
                     THEN (
                       -- month 1-12 guard mirrors autopayActivePredicate /
                       -- isExpiredCardMethod (codex r5 P1): exp_month='99'
                       -- passes the regex and the >= comparison, but
                       -- charge() rejects it and falls back
                       NULLIF(BTRIM(pp.exp_month), '')::integer BETWEEN 1 AND 12
                       AND (
                       (CASE WHEN NULLIF(BTRIM(pp.exp_year), '')::integer < 100
                             THEN NULLIF(BTRIM(pp.exp_year), '')::integer + 2000
                             ELSE NULLIF(BTRIM(pp.exp_year), '')::integer END) > ?
                       OR ((CASE WHEN NULLIF(BTRIM(pp.exp_year), '')::integer < 100
                                 THEN NULLIF(BTRIM(pp.exp_year), '')::integer + 2000
                                 ELSE NULLIF(BTRIM(pp.exp_year), '')::integer END) = ?
                           AND NULLIF(BTRIM(pp.exp_month), '')::integer >= ?)
                       )
                     )
                     ELSE FALSE
                   END
                 )
               )
          )
          AND NOT EXISTS (
            SELECT 1 FROM payment_methods pm2
             WHERE pm2.customer_id = pm.customer_id
               AND pm2.processor = 'stripe' AND pm2.is_default = true
               AND pm2.autopay_enabled = true
               AND pm2.stripe_payment_method_id IS NOT NULL
               -- only another CHARGEABLE default can outrank this one —
               -- "chargeable" means the FULL charge-time predicate (codex
               -- r4+r5 P1s), because charge() walks the same defaults in
               -- this same order and picks the first eligible row: a newer
               -- HEALTHY BANK default outranks (the customer is charged via
               -- ACH — the card notice is noise, same rule as the pointer
               -- branch), while a disabled/shell/blocked-bank/expired/
               -- malformed-expiry default does NOT (charge() skips it, so
               -- the older valid card's warning must fire)
               AND (
                 (
                   pm2.method_type IN ('ach', 'us_bank_account', 'bank', 'bank_account')
                   AND (c.ach_status IS NULL OR c.ach_status = '' OR c.ach_status = 'active')
                   AND (pm2.ach_status IS NULL
                        OR pm2.ach_status NOT IN ('pending_verification', 'verification_failed'))
                 )
                 OR (
                   (pm2.method_type IS NULL
                    OR pm2.method_type NOT IN ('ach', 'us_bank_account', 'bank', 'bank_account'))
                   AND CASE
                     WHEN NULLIF(BTRIM(pm2.exp_month), '') ~ '^[0-9]{1,2}$'
                       AND NULLIF(BTRIM(pm2.exp_year), '') ~ '^([0-9]{2}|[0-9]{4})$'
                     THEN (
                       NULLIF(BTRIM(pm2.exp_month), '')::integer BETWEEN 1 AND 12
                       AND (
                       (CASE WHEN NULLIF(BTRIM(pm2.exp_year), '')::integer < 100
                             THEN NULLIF(BTRIM(pm2.exp_year), '')::integer + 2000
                             ELSE NULLIF(BTRIM(pm2.exp_year), '')::integer END) > ?
                       OR ((CASE WHEN NULLIF(BTRIM(pm2.exp_year), '')::integer < 100
                                 THEN NULLIF(BTRIM(pm2.exp_year), '')::integer + 2000
                                 ELSE NULLIF(BTRIM(pm2.exp_year), '')::integer END) = ?
                           AND NULLIF(BTRIM(pm2.exp_month), '')::integer >= ?)
                       )
                     )
                     ELSE FALSE
                   END
                 )
               )
               AND (pm2.updated_at > pm.updated_at
                    OR (pm2.updated_at = pm.updated_at AND pm2.id < pm.id))
          )
        )
      )`, [thisYear, thisYear, thisMonth, thisYear, thisYear, thisMonth])
      .whereRaw(
        `CASE
           WHEN NULLIF(BTRIM(pm.exp_month), '') ~ '^[0-9]{1,2}$'
             AND NULLIF(BTRIM(pm.exp_year), '') ~ '^([0-9]{2}|[0-9]{4})$'
           THEN (
             (CASE WHEN NULLIF(BTRIM(pm.exp_year), '')::integer < 100
                   THEN NULLIF(BTRIM(pm.exp_year), '')::integer + 2000
                   ELSE NULLIF(BTRIM(pm.exp_year), '')::integer END,
              NULLIF(BTRIM(pm.exp_month), '')::integer) IN ((?, ?), (?, ?))
           )
           ELSE FALSE
         END`,
        [thisYear, thisMonth, nextYear, nextMonth],
      )
      .select('pm.id', 'pm.customer_id', 'pm.last_four', 'pm.exp_month', 'pm.exp_year', 'pm.card_brand');

    // Prepay-covered customers are exempt (same helper as the dashboard alert
    // and the Monday warning job): this window is "this month or next", so
    // the horizon is the last day of next month — coverage still active then
    // means no card charge inside the window. Covered customers with a
    // still-collectible pre-term retry stay in (the retry charges the card).
    // PER CARD (#3533 follow-up): a covered customer whose only forthcoming
    // charge rides an estimate hold's frozen card is exempt for the OTHER
    // cards — isCardExpiryExemptMethod judges each expiring row.
    const { emptyCardExpiryExemptions, isCardExpiryExemptMethod, cardExpiryAlertResolvableCustomerIds } = require('../card-expiry-exemptions');
    let exemptions = emptyCardExpiryExemptions();
    try {
      const { getCardExpiryExemptions } = require('../annual-prepay-renewals');
      const lastOfNextMonth = new Date(Date.UTC(nextYear, nextMonth, 0)).toISOString().slice(0, 10);
      exemptions = await getCardExpiryExemptions(lastOfNextMonth);
    } catch (exemptErr) {
      logger.warn(`Payment expiry: prepay exemption lookup failed, exempting nobody: ${exemptErr.message}`);
    }
    // Stale-alert reconciliation: a customer with no charge coming on any
    // card, or (hook P1) a covered customer whose forthcoming charge rides
    // only cards valid BEYOND this window (judged from those cards' own
    // rows — an already-expired charged card is absent from this run's
    // expiring query and must keep its alert). Alerts carry no method
    // identity, so any charged card still inside the window keeps every
    // alert; a failed row read keeps every partially covered customer's.
    let chargedMethodRows = [];
    const chargedMethodIds = [...exemptions.chargeMethodIdsByCustomer.values()]
      .flatMap((ids) => (ids instanceof Set ? [...ids] : []));
    if (chargedMethodIds.length) {
      try {
        chargedMethodRows = await db('payment_methods')
          .whereIn('id', chargedMethodIds)
          .select('id', 'method_type', 'exp_month', 'exp_year');
      } catch (rowErr) {
        logger.warn(`Payment expiry: charged-method read failed, keeping partially covered customers' alerts: ${rowErr.message}`);
        chargedMethodRows = [];
      }
    }
    const exemptIds = cardExpiryAlertResolvableCustomerIds(exemptions, chargedMethodRows, { year: nextYear, month: nextMonth });
    let prepayExempt = 0;

    // The skip below only prevents FUTURE alerts — an alert created before
    // the customer became exempt (e.g. pre-prepay) would otherwise sit in
    // front of the operator forever: the active-alert reader
    // (admin-compliance /alerts/active) returns every resolved=false row
    // and nothing else resolves payment_expiry alerts. Reconciled against
    // the FULL exemption set, not the expiring-card rows — a customer who
    // also replaced or disabled the old card is absent from expiringCards
    // but their stale alert still needs resolving.
    await this.resolveAlertsForExemptCustomers(exemptIds);

    let notified = 0;

    for (const rawCard of expiringCards) {
      if (isCardExpiryExemptMethod(exemptions, rawCard.customer_id, rawCard.id)) { prepayExempt += 1; continue; }
      // Normalize legacy 2-digit years for EVERY downstream consumer — the
      // email path's expiry-stage math runs new Date(year, ...), where a raw
      // '26' reads as 1926 and the card emails as already expired.
      const rawYear = parseInt(rawCard.exp_year, 10);
      const card = Number.isFinite(rawYear) && rawYear > 0 && rawYear < 100
        ? { ...rawCard, exp_year: rawYear + 2000 }
        : rawCard;
      try {
        const customer = await db('customers').where({ id: card.customer_id }).first();
        if (!customer) continue;

        const emailPromise = PaymentLifecycleEmail.sendPaymentMethodExpiring({
          customerId: card.customer_id,
          paymentMethodId: card.id,
          now,
        }).catch((emailErr) => {
          logger.warn(`Payment expiry email failed for card ${card.id}: ${emailErr.message}`);
        });

        if (!customer.phone) { await emailPromise; continue; }

        // 30-day cooldown per customer
        const recentNotice = await db('sms_log')
          .where({ customer_id: card.customer_id, message_type: 'payment_expiry' })
          .where('created_at', '>', db.raw("NOW() - INTERVAL '30 days'"))
          .first();

        if (recentNotice) { await emailPromise; continue; }

        const expLabel = `${String(card.exp_month).padStart(2, '0')}/${card.exp_year}`;
        const brandLabel = card.card_brand ? `${card.card_brand} ` : '';
        const cardLabel = card.card_brand ? `${card.card_brand} card` : 'card';

        const body = await renderSmsTemplate(
          'payment_method_expiry',
          {
            first_name: customer.first_name || 'there',
            card_brand: (card.card_brand || 'payment').trim(),
            last_four: card.last_four,
            exp_date: expLabel,
          },
          { workflow: 'payment_method_expiry', entity_type: 'payment_method', entity_id: card.id || card.payment_method_id }
        );

        const sendResult = await sendCustomerMessage({
          to: customer.phone,
          body,
          channel: 'sms',
          audience: 'customer',
          purpose: 'autopay',
          customerId: card.customer_id,
          entryPoint: 'payment_expiry_workflow',
          metadata: {
            original_message_type: 'payment_expiry',
            customerLocationId: customer.location_id,
          },
        });
        if (sendResult.blocked || sendResult.sent === false) {
          throw new Error(`payment expiry SMS blocked: ${sendResult.code || sendResult.reason || 'unknown'}`);
        }

        // Create inventory_alerts entry for dashboard visibility
        await db('inventory_alerts').insert({
          alert_type: 'payment_expiry',
          severity: card.exp_month === thisMonth && card.exp_year === thisYear ? 'high' : 'medium',
          title: `Card expiring: ${customer.first_name} ${customer.last_name}`,
          description: `${brandLabel}****${card.last_four} expires ${expLabel}`,
          reference_id: card.customer_id,
          reference_type: 'customer',
          status: 'active',
        });

        await db('customer_interactions').insert({
          customer_id: card.customer_id,
          interaction_type: 'sms_outbound',
          channel: 'sms',
          subject: 'Payment method expiry notice',
          body: `Card ****${card.last_four} expires ${expLabel}`,
        });

        await emailPromise;
        notified++;
      } catch (err) {
        logger.error(`Payment expiry check failed for card ${card.id}: ${err.message}`);
      }
    }

    logger.info(`Payment expiry: ${notified} customers notified, ${expiringCards.length} cards found, ${prepayExempt} prepay-covered exempt`);
    return { notified, totalExpiring: expiringCards.length };
  }

  /**
   * Resolve any still-open payment_expiry alerts for customers the prepay
   * exemption now covers — a stale "card expiring" alert from before the
   * coverage began is exactly the false signal this exemption suppresses.
   * Reads the open alerts and matches them against the exemption set, so a
   * customer whose expiring card has since been replaced or disabled (and
   * who therefore no longer appears in the expiring-cards query) is still
   * reconciled. Best-effort: alert bookkeeping must never fail the scan.
   * The insert above keys the customer via reference_id; the base
   * migration only defines customer_id — match whichever columns this
   * environment has.
   */
  async resolveAlertsForExemptCustomers(exemptIds) {
    if (!exemptIds || !exemptIds.size) return;
    try {
      const hasReferenceId = await db.schema.hasColumn('inventory_alerts', 'reference_id');
      const openAlerts = await db('inventory_alerts')
        .where({ alert_type: 'payment_expiry', resolved: false })
        .select(hasReferenceId ? ['id', 'customer_id', 'reference_id'] : ['id', 'customer_id']);
      const toResolve = (openAlerts || [])
        .filter((a) => (a.customer_id != null && exemptIds.has(String(a.customer_id)))
          || (hasReferenceId && a.reference_id != null && exemptIds.has(String(a.reference_id))))
        .map((a) => a.id);
      if (!toResolve.length) return;
      await db('inventory_alerts')
        .whereIn('id', toResolve)
        .update({ resolved: true, resolved_at: db.fn.now() });
      logger.info(`Payment expiry: resolved ${toResolve.length} stale expiry alert(s) for prepay-exempt customers`);
    } catch (alertErr) {
      logger.warn(`Payment expiry: stale-alert resolution failed: ${alertErr.message}`);
    }
  }
}

module.exports = new PaymentExpiry();
