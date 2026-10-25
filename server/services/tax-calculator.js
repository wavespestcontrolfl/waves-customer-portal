const db = require('../models/db');
const logger = require('./logger');
const { MANATEE_ZIPS, SARASOTA_ZIPS, CHARLOTTE_ZIPS, LEE_ZIPS, COLLIER_ZIPS } = require('../config/county-zips');
const { slabHomeNoTaxLive, lawnSprayNoTaxLive } = require('../config/feature-gates');

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

    const notTaxable = await this.serviceNotTaxable(conn, serviceType, isCommercial);
    if (notTaxable) return notTaxable;

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
   * Step 2 of calculateTax: the no-tax answer this service earns, or null when
   * the county rate applies (a taxable or unknown service).
   */
  async serviceNotTaxable(conn, serviceType, isCommercial) {
    if (!serviceType) return null;
    // Pre-construction termite treatment (slab pre-treat): Florida taxes it
    // only for a nonresidential building (Rule 12A-1.009); for a home it is
    // residential pest control, even when the customer is a builder whose
    // account is commercial. No record stores the building's use, so the
    // service name carries it (GATE_SLAB_HOME_NO_TAX).
    if (slabHomeNoTaxLive() && this.isHomeSlabPretreat(serviceType)) {
      return { rate: 0, amount: 0, taxable: false, county: null, reason: 'Pre-construction termite treatment for a home — not taxable (FL Rule 12A-1.009)' };
    }
    // Lawn and landscape treatments: Florida does not tax lawn spraying,
    // residential or nonresidential (Rule 12A-1.009(6)), and taxes pest control
    // only for an infestation of a nonresidential building, so tree and shrub
    // and palm care is not taxed either (GATE_LAWN_SPRAY_NO_TAX).
    if (lawnSprayNoTaxLive() && this.isGroundsTreatment(serviceType)) {
      return { rate: 0, amount: 0, taxable: false, county: null, reason: 'Lawn and landscape treatment — not taxable (FL Rule 12A-1.009)' };
    }

    // Normalize service type to key format
    const serviceKey = serviceType.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_');
    const taxability = await conn('service_taxability')
      .where(function () {
        this.where('service_key', serviceKey)
          .orWhere('service_key', 'ilike', `%${serviceKey}%`)
          .orWhere('service_label', 'ilike', `%${serviceType}%`);
      })
      .first();
    if (!taxability) return null;

    // Check residential_taxable override
    if (!isCommercial && taxability.residential_taxable === false) {
      return { rate: 0, amount: 0, taxable: false, county: null, reason: `${taxability.service_label} — not taxable for residential (FL)` };
    }
    if (!taxability.is_taxable) {
      return { rate: 0, amount: 0, taxable: false, county: null, reason: `${taxability.service_label} — not taxable (${taxability.fl_statute_ref || 'FL law'})` };
    }
    return null;
  },

  /**
   * A pre-construction termite treatment for a home: the name says pre-slab,
   * pre-treat, pretreatment or pre-construction and names termites, Termidor,
   * a slab or a borate. A name that says Commercial or nonresidential is the
   * office's mark for a nonresidential building, which stays taxable.
   */
  isHomeSlabPretreat(serviceType) {
    const name = String(serviceType || '');
    return /\bpre[-\s]?(?:slab|treat(?:ment)?|construction)\b/i.test(name)
      && /termit|termidor|slab|\bbora/i.test(name)
      && !/\b(?:commercial|non-?residential)\b/i.test(name);
  },

  /**
   * A lawn or landscape treatment: the name names a lawn, turf, sod, trees,
   * shrubs, palms, weeds, fertilizer, pre-emergent or fire ants, or
   * dethatching, topdressing, plugging or aeration. A name that also names
   * building pest work (pests, termites, rodents, roaches, bed bugs, fleas,
   * bees, wasps, a WDO inspection) or mosquitoes is left to the normal rules,
   * so a combined visit keeps its tax. Underscores count as spaces, so a
   * service key reads like its name.
   */
  isGroundsTreatment(serviceType) {
    const name = String(serviceType || '').replace(/_/g, ' ');
    return /\b(?:lawns?|turf|sod|trees?|shrubs?|palms?|weeds?|fertili[sz]\w*|pre-?emergent|fire\s?ants?|dethatch\w*|top-?dress\w*|plugging|aerat\w*)\b/i.test(name)
      && !/\b(?:pests?|termites?|rodents?|(?:cock)?roach(?:es)?|bed\s?bugs?|fleas?|bees?|wasps?|wdo|mosquito(?:es)?|misting)\b/i.test(name);
  },

  /**
   * Map SWFL ZIP codes to county names.
   */
  /**
   * The spelling every reader matches EXACTLY: inferCountyFromZip's return
   * values, plus DeSoto (a tax-rate county with interior caps; NOT a service-area county). A rate
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
