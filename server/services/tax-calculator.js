const db = require('../models/db');
const logger = require('./logger');
const { MANATEE_ZIPS, SARASOTA_ZIPS, CHARLOTTE_ZIPS, LEE_ZIPS, COLLIER_ZIPS, DESOTO_ZIPS } = require('../config/county-zips');
const { slabHomeNoTaxLive, lawnSprayNoTaxLive, buildingUseTaxLive, taxServiceCountyLive } = require('../config/feature-gates');

// Waves operates in ET. Use ET calendar date regardless of server TZ (Railway=UTC).
function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

const CANONICAL_COUNTY_KEYS = new Map(
  ['Manatee', 'Sarasota', 'Charlotte', 'Lee', 'Collier', 'DeSoto'].map((county) => [county.toLowerCase(), county]),
);

// isGroundsTreatment's vocabulary: lawn and landscape work, and the building
// pest work (or mosquito work) that keeps a service taxable.
const GROUNDS_TERMS = /\b(?:lawns?|turf|sod|trees?|shrubs?|palms?|weeds?|fertili[sz]\w*|pre-?emergent|fire\s?ants?|dethatch\w*|top-?dress\w*|plugging|aerat\w*)\b/i;
const BUILDING_PEST_TERMS = /\b(?:pests?|termites?|rodents?|rats?|mice|mouse|(?:cock)?roach(?:es)?|palmetto|bed\s?bugs?|fleas?|ticks?|bees?|wasps?|hornets?|ants?|spiders?|silverfish|scorpions?|crickets?|wdo|mosquito(?:es)?|misting)\b/i;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 2026 rates of the neighbor counties that have no seeded tax_rates row
// (Florida DOR form DR-15DSS, 2026 discretionary sales surtax rates). Used
// only with GATE_TAX_SERVICE_COUNTY on, and only when no tax_rates row covers
// the county: a row added on the admin tax page always wins. Without them
// these counties get the flat 7% fallback.
const NEIGHBOR_COUNTY_RATES_2026 = Object.freeze({
  Lee: Object.freeze({ state: 0.06, surtax: 0.005, combined: 0.065 }),
  Collier: Object.freeze({ state: 0.06, surtax: 0, combined: 0.06 }),
  DeSoto: Object.freeze({ state: 0.06, surtax: 0.015, combined: 0.075 }),
});

// A rate as a percent for the reason text: 0.005 -> "0.5", 0.01 -> "1".
const pct = (value) => String(Math.round(parseFloat(value) * 1000) / 10);

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

    // 1b. Building use (GATE_BUILDING_USE_TAX): Florida taxes pest control
    // only at a nonresidential building (Rule 12A-1.009), whoever pays. An
    // account whose won proposal says its site is residential (homes,
    // apartments, condos and their common areas) is taxed like any
    // residential customer: not at all (owner 2026-10-08, "any residential
    // service is non taxable"). The use belongs to the site, so a payer-billed
    // invoice (skipCustomerExemption) follows it too.
    if (customer.building_use === 'residential' && buildingUseTaxLive()) {
      return { rate: 0, amount: 0, taxable: false, county: null, reason: 'Residential building use — pest control at homes and their common areas is not taxable (FL Rule 12A-1.009)' };
    }

    // 2. Check service taxability. opts.isCommercial forces commercial treatment
    // for a customer who will be marked commercial at accept but whose row isn't
    // updated yet (e.g. pre-accept prepay DISPLAY) — so the quoted rate matches
    // the invoice the converter creates once the row is commercial.
    const isCommercial = opts.isCommercial === true
      || customer.property_type === 'commercial' || customer.property_type === 'business';

    const notTaxable = await this.serviceNotTaxable(conn, serviceType, isCommercial);
    if (notTaxable) return notTaxable;

    // 3. Look up county tax rate. The surtax is due in the county where the
    // service is delivered (s. 212.054(3)(a)): with GATE_TAX_SERVICE_COUNTY on,
    // the serviced property's ZIP names it (taxZipFor), else the customer's ZIP.
    const { zip: taxZip, fromProperty } = await this.taxZipFor(conn, customer, opts);
    const sourceField = fromProperty ? { countySource: 'property' } : {};
    const county = this.inferCountyFromZip(taxZip);
    if (!county) {
      // Default: FL residential pest control is NOT taxable; commercial gets 6% state + 1% surtax
      const defaultRate = isCommercial ? 0.07 : 0;
      const amount = Math.round(subtotal * defaultRate * 100) / 100;
      if (!isCommercial) return { rate: 0, amount: 0, taxable: false, county: 'unknown', reason: 'Residential pest control — FL sales tax exempt' };
      return { rate: defaultRate, amount, taxable: true, county: 'unknown', reason: `Default FL rate (county could not be inferred from ${fromProperty ? "the property's " : ''}ZIP)`, ...sourceField };
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

    // No row for the county: a neighbor county's 2026 rate (gate on), else the
    // flat 7% fallback, as before.
    const neighbor = !taxRate && NEIGHBOR_COUNTY_RATES_2026[county] && taxServiceCountyLive()
      ? NEIGHBOR_COUNTY_RATES_2026[county] : null;
    const rate = taxRate ? parseFloat(taxRate.combined_rate) : (neighbor ? neighbor.combined : 0.07);
    const amount = Math.round(subtotal * rate * 100) / 100;
    const stateRate = taxRate ? taxRate.state_rate : (neighbor ? neighbor.state : 0.06);
    const surtax = taxRate ? taxRate.county_surtax : (neighbor ? neighbor.surtax : 0.01);

    return {
      rate,
      amount,
      taxable: true,
      county,
      reason: `${county} County${fromProperty ? ' (property ZIP)' : ''} — ${(rate * 100).toFixed(1)}% (state ${pct(stateRate)}% + county ${pct(surtax)}% surtax)`,
      ...sourceField,
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
    // account is commercial. A builder's account holds homes and its own
    // offices alike, so the service name carries the building's use here
    // (GATE_SLAB_HOME_NO_TAX); the account-level use in step 1b covers a
    // whole residential site.
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
   * dethatching, topdressing, plugging or aeration. A combined visit ("A + B")
   * qualifies only when every part does, and a part that also names building
   * pest work or mosquitoes is left to the normal rules, so a combined visit
   * keeps its tax. "Lawn pest" (turf insects, as in Lawn Pest Knockdown) and
   * fire ants are lawn work. Underscores count as spaces, so a service key
   * reads like its name.
   */
  isGroundsTreatment(serviceType) {
    const name = String(serviceType || '').replace(/_/g, ' ');
    return name.split('+').every((part) => {
      const rest = part.replace(/\b(?:lawn|turf)\s+pests?\b/gi, 'lawn').replace(/\bfire\s?ants?\b/gi, 'fireant');
      return GROUNDS_TERMS.test(part) && !BUILDING_PEST_TERMS.test(rest);
    });
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

  /**
   * The ZIP that names the tax county, and whether it came from the serviced
   * property. With GATE_TAX_SERVICE_COUNTY on, a caller that knows where the
   * service is delivered passes opts.propertyId (a saved property of this
   * customer) or opts.scheduledServiceId (a visit of this customer, whose saved
   * property is read); that property's ZIP wins. No id, an id that is not this
   * customer's, a property without a ZIP, or the gate off = the customer's own
   * ZIP, as before (and no query).
   */
  async taxZipFor(conn, customer, { propertyId, scheduledServiceId } = {}) {
    const [pid, visitId] = [propertyId, scheduledServiceId].map((id) => String(id ?? '').trim());
    if ((UUID_RE.test(pid) || UUID_RE.test(visitId)) && taxServiceCountyLive()) {
      let row = null;
      if (UUID_RE.test(pid)) {
        row = await conn('customer_properties').where({ id: pid, customer_id: customer.id }).first('zip');
      }
      if (!String(row?.zip ?? '').trim() && UUID_RE.test(visitId)) {
        row = await conn('scheduled_services as s')
          .join('customer_properties as p', 'p.id', 's.property_id')
          .where({ 's.id': visitId, 's.customer_id': customer.id, 'p.customer_id': customer.id })
          .first('p.zip as zip');
      }
      const zip = String(row?.zip ?? '').trim();
      if (zip) return { zip, fromProperty: true };
    }
    return { zip: customer.zip, fromProperty: false };
  },

  inferCountyFromZip(zip) {
    if (!zip) return null;
    const z = String(zip).substring(0, 5);

    if (MANATEE_ZIPS.includes(z)) return 'Manatee';
    if (SARASOTA_ZIPS.includes(z)) return 'Sarasota';
    if (CHARLOTTE_ZIPS.includes(z)) return 'Charlotte';
    if (LEE_ZIPS.includes(z)) return 'Lee';
    if (COLLIER_ZIPS.includes(z)) return 'Collier';
    if (DESOTO_ZIPS.includes(z) && taxServiceCountyLive()) return 'DeSoto';
    return null;
  },
};

module.exports = TaxCalculator;
