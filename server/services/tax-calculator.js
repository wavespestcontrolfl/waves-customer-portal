const db = require('../models/db');
const logger = require('./logger');

const TaxCalculator = {

  /**
   * Calculate tax for a customer + service type + subtotal.
   * Checks service_taxability, tax_exemptions, and tax_rates by county.
   *
   * Returns { rate, amount, taxable, county, reason }
   */
  async calculateTax(customerId, serviceType, subtotal) {
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) return { rate: 0, amount: 0, taxable: false, county: null, reason: 'Customer not found' };

    // 1. Check tax exemption
    const exemption = await db('tax_exemptions')
      .where({ customer_id: customerId, active: true, verified: true })
      .where(function () {
        this.whereNull('expiry_date').orWhere('expiry_date', '>=', new Date().toISOString().split('T')[0]);
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
      const taxability = await db('service_taxability')
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

    const taxRate = await db('tax_rates')
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

    const manatee = ['34201', '34202', '34203', '34204', '34205', '34206', '34207', '34208', '34209', '34210',
      '34211', '34212', '34219', '34221', '34222', '34243', '34250', '34251', '34280', '34281', '34282'];
    const sarasota = ['34228', '34229', '34230', '34231', '34232', '34233', '34234', '34235', '34236', '34237',
      '34238', '34239', '34240', '34241', '34242', '34260', '34275', '34276', '34277', '34278', '34286', '34287', '34288', '34289', '34292', '34293'];
    const charlotte = ['33947', '33948', '33949', '33950', '33952', '33953', '33954', '33955', '33980', '33981', '33982', '33983'];
    const lee = ['33901', '33903', '33904', '33905', '33907', '33908', '33909', '33912', '33913', '33914',
      '33916', '33917', '33919', '33920', '33921', '33922', '33924', '33928', '33931', '33936',
      '33956', '33957', '33965', '33966', '33967', '33971', '33972', '33973', '33974', '33976',
      '33990', '33991', '33993', '34134', '34135'];
    const collier = ['34102', '34103', '34104', '34105', '34108', '34109', '34110', '34112', '34113', '34114',
      '34116', '34117', '34119', '34120', '34140', '34141', '34142', '34145'];

    if (manatee.includes(z)) return 'Manatee';
    if (sarasota.includes(z)) return 'Sarasota';
    if (charlotte.includes(z)) return 'Charlotte';
    if (lee.includes(z)) return 'Lee';
    if (collier.includes(z)) return 'Collier';
    return null;
  },
};

module.exports = TaxCalculator;
