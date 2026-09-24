const db = require('../models/db');
const logger = require('./logger');
const { MANATEE_ZIPS, SARASOTA_ZIPS, CHARLOTTE_ZIPS, LEE_ZIPS, COLLIER_ZIPS } = require('../config/county-zips');

// Waves operates in ET. Use ET calendar date regardless of server TZ (Railway=UTC).
function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

const CANONICAL_COUNTY_KEYS = new Map(
  ['Manatee', 'Sarasota', 'Charlotte', 'Lee', 'Collier', 'DeSoto'].map((county) => [county.toLowerCase(), county]),
);

const TaxCalculator = {

  /**
   * The customer's verified, active, unexpired tax exemption row (or null).
   * ONE implementation — calculateTax's step 1 and InvoiceService.create's
   * explicit-taxRate guard both read this, so a caller-supplied rate can
   * never re-tax a customer whose verified certificate the calculator
   * would honor.
   */
  async findVerifiedExemption(customerId, opts = {}) {
    const conn = opts.database || db;
    return conn('tax_exemptions')
      .where({ customer_id: customerId, active: true, verified: true })
      .where(function () {
        this.whereNull('expiry_date').orWhere('expiry_date', '>=', todayET());
      })
      .first();
  },

  /**
   * Calculate tax for a customer + service type + subtotal.
   * Checks service_taxability, tax_exemptions, and tax_rates by county.
   *
   * Returns { rate, amount, taxable, county, reason }
   */
  async calculateTax(customerId, serviceType, subtotal, opts = {}) {
    // Optional transaction connection: when an invoice is created INSIDE the
    // accept transaction, the customer's just-written property_type='commercial'
    // (and any in-flight rows) are only visible on that connection — the global
    // db would still read the pre-commit (residential) row and zero the tax.
    const conn = opts.database || db;
    const customer = await conn('customers').where({ id: customerId }).first();
    if (!customer) return { rate: 0, amount: 0, taxable: false, county: null, reason: 'Customer not found' };

    // 1. Check tax exemption. opts.skipCustomerExemption bypasses it for a
    // payer-billed invoice: the snapshotted Bill-To entity owes the tax and
    // its OWN tax_exempt flag governs — the service customer's certificate
    // must not zero a non-exempt payer's rate.
    if (opts.skipCustomerExemption !== true) {
      const exemption = await this.findVerifiedExemption(customerId, { database: conn });

      if (exemption) {
        return { rate: 0, amount: 0, taxable: false, county: null, reason: `Tax exempt — ${exemption.exemption_type} (${exemption.certificate_number})` };
      }
    }

    // 2. Check service taxability. opts.isCommercial forces commercial treatment
    // for a customer who will be marked commercial at accept but whose row isn't
    // updated yet (e.g. pre-accept prepay DISPLAY) — so the quoted rate matches
    // the invoice the converter creates once the row is commercial.
    const isCommercial = opts.isCommercial === true
      || customer.property_type === 'commercial' || customer.property_type === 'business';

    if (serviceType) {
      // Normalize service type to key format
      const serviceKey = serviceType.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_');
      const taxability = await conn('service_taxability')
        .where(function () {
          this.where('service_key', serviceKey)
            .orWhere('service_key', 'ilike', `%${serviceKey}%`)
            .orWhere('service_label', 'ilike', `%${serviceType}%`);
        })
        .first();

      if (taxability) {
        // Check residential_taxable override
        if (!isCommercial && taxability.residential_taxable === false) {
          return { rate: 0, amount: 0, taxable: false, county: null, reason: `${taxability.service_label} — not taxable for residential (FL)` };
        }
        if (!taxability.is_taxable) {
          return { rate: 0, amount: 0, taxable: false, county: null, reason: `${taxability.service_label} — not taxable (${taxability.fl_statute_ref || 'FL law'})` };
        }
      }
    }

    // 3. Look up county tax rate
    const county = this.inferCountyFromZip(customer.zip);
    if (!county) {
      // Default: FL residential pest control is NOT taxable; commercial gets 6% state + 1% surtax
      const defaultRate = isCommercial ? 0.07 : 0;
      const amount = Math.round(subtotal * defaultRate * 100) / 100;
      if (!isCommercial) return { rate: 0, amount: 0, taxable: false, county: 'unknown', reason: 'Residential pest control — FL sales tax exempt' };
      return { rate: defaultRate, amount, taxable: true, county: 'unknown', reason: 'Default FL rate (county could not be inferred from ZIP)' };
    }

    // Bound by effective_date so a staged future-dated rate (posted ahead of
    // its start date) never applies before it takes effect, and by
    // expiry_date so a retired rate never resurfaces (audit r1-billing-1).
    // Deliberately NOT filtered by `active`: a backfilled correction posted
    // after a later rate is already in force inserts its own active:true
    // row, and a rate staged by the OLD (pre-fix) route can leave a
    // still-genuinely-current predecessor marked active:false — in both
    // cases `active` no longer tracks which row actually covers today. The
    // single ordering rule below (newest effective_date whose window covers
    // today, active or not) picks the same row calculateTax's own
    // date-bounded selection should for every one of those shapes,
    // instead of an `active`-gated primary query only falling back to a
    // legacy row when NO active row exists at all — that precedence let a
    // backfilled active row win over a later, still-effective legacy
    // predecessor (codex round-5 P0).
    // The one `active` shape that IS honored: a row switched off with NO
    // expiry at all (hand-edited or seeded that way) has no window to
    // reason about and was deliberately disabled — it must never be
    // charged again just because it carries the newest effective_date
    // (fallback-auditor P1 on 9bc52bc07c). Every legacy shape above
    // carries an expiry, so this excludes nothing those rulings protect.
    const nowET = todayET();
    const taxRate = await conn('tax_rates')
      .where({ county })
      .andWhere('effective_date', '<=', nowET)
      .andWhere(function () {
        this.whereNull('expiry_date').orWhere('expiry_date', '>', nowET);
      })
      .andWhere(function () {
        this.where('active', true).orWhereNotNull('expiry_date');
      })
      .orderBy('effective_date', 'desc')
      .first();

    const rate = taxRate ? parseFloat(taxRate.combined_rate) : 0.07;
    const amount = Math.round(subtotal * rate * 100) / 100;

    return {
      rate,
      amount,
      taxable: true,
      county,
      reason: `${county} County — ${(rate * 100).toFixed(1)}% (state ${taxRate ? (parseFloat(taxRate.state_rate) * 100).toFixed(0) : '6'}% + county ${taxRate ? (parseFloat(taxRate.county_surtax) * 100).toFixed(0) : '1'}% surtax)`,
    };
  },

  /**
   * Map SWFL ZIP codes to county names.
   */
  /**
   * The spelling every reader matches EXACTLY: inferCountyFromZip's return
   * values, plus DeSoto (service-area county with interior caps). A rate
   * stored under any other casing of these names is invisible to
   * calculateTax and getCurrentTaxRates, so the write path must key on
   * this and never on whatever a legacy row happened to carry (codex
   * round-4 P1). Returns null for a county no reader knows.
   */
  canonicalCountyKey(name) {
    const key = String(name || '').trim().toLowerCase();
    return CANONICAL_COUNTY_KEYS.get(key) || null;
  },

  inferCountyFromZip(zip) {
    if (!zip) return null;
    const z = String(zip).substring(0, 5);

    if (MANATEE_ZIPS.includes(z)) return 'Manatee';
    if (SARASOTA_ZIPS.includes(z)) return 'Sarasota';
    if (CHARLOTTE_ZIPS.includes(z)) return 'Charlotte';
    if (LEE_ZIPS.includes(z)) return 'Lee';
    if (COLLIER_ZIPS.includes(z)) return 'Collier';
    return null;
  },
};

module.exports = TaxCalculator;
