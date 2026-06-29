const db = require('../models/db');
const logger = require('./logger');
const { MANATEE_ZIPS, SARASOTA_ZIPS, CHARLOTTE_ZIPS, LEE_ZIPS, COLLIER_ZIPS } = require('../config/county-zips');

// Waves operates in ET. Use ET calendar date regardless of server TZ (Railway=UTC).
function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

const TaxCalculator = {

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

    // 1. Check tax exemption
    const exemption = await conn('tax_exemptions')
      .where({ customer_id: customerId, active: true, verified: true })
      .where(function () {
        this.whereNull('expiry_date').orWhere('expiry_date', '>=', todayET());
      })
      .first();

    if (exemption) {
      return { rate: 0, amount: 0, taxable: false, county: null, reason: `Tax exempt — ${exemption.exemption_type} (${exemption.certificate_number})` };
    }

    // 2. Check service taxability
    const isCommercial = customer.property_type === 'commercial' || customer.property_type === 'business';

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

    const taxRate = await conn('tax_rates')
      .where({ county, active: true })
      .whereNull('expiry_date')
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
