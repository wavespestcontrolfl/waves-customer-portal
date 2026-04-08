const db = require('../models/db');
const logger = require('./logger');

const ComplianceService = {

  /**
   * After service completion, create property_application_history records
   * from service_products — enriched with products_catalog data.
   */
  async createComplianceRecords(serviceRecordId) {
    const sr = await db('service_records')
      .where({ id: serviceRecordId })
      .first();
    if (!sr) throw new Error('Service record not found');

    const products = await db('service_products')
      .where({ service_record_id: serviceRecordId });
    if (!products.length) return [];

    const tech = sr.technician_id
      ? await db('technicians').where({ id: sr.technician_id }).first()
      : null;

    const records = [];
    for (const sp of products) {
      // Look up product catalog for EPA / active ingredient / MOA
      let catalog = null;
      if (sp.product_id) {
        catalog = await db('products_catalog').where({ id: sp.product_id }).first();
      } else if (sp.product_name) {
        catalog = await db('products_catalog')
          .where('name', 'ilike', `%${sp.product_name}%`)
          .first();
      }

      const record = {
        customer_id: sr.customer_id,
        service_record_id: serviceRecordId,
        product_id: catalog?.id || sp.product_id || null,
        technician_id: sr.technician_id,
        application_date: sr.service_date || new Date().toISOString().split('T')[0],
        quantity_applied: sp.quantity_applied || sp.application_rate || null,
        quantity_unit: sp.rate_unit || null,
        application_rate: sp.application_rate || null,
        rate_unit: sp.rate_unit || null,
        active_ingredient: catalog?.active_ingredient || sp.active_ingredient || null,
        moa_group: catalog?.moa_group || null,
        category: sp.product_category || catalog?.category || null,
        epa_registration_number: catalog?.epa_registration_number || catalog?.epa_reg_number || null,
        application_method: sp.application_method || null,
        restricted_use: catalog?.restricted_use || false,
        applicator_license: tech?.fl_applicator_license || null,
        notes: sp.notes || null,
      };

      const [inserted] = await db('property_application_history')
        .insert(record)
        .returning('*');
      records.push(inserted);
    }

    logger.info(`[compliance] Created ${records.length} application records for service ${serviceRecordId}`);
    return records;
  },

  /**
   * Paginated application history with filters.
   */
  async getApplications({ startDate, endDate, technicianId, customerId, productName, limit = 50, offset = 0 } = {}) {
    let query = db('property_application_history as pah')
      .leftJoin('products_catalog as pc', 'pah.product_id', 'pc.id')
      .leftJoin('customers as c', 'pah.customer_id', 'c.id')
      .leftJoin('technicians as t', 'pah.technician_id', 't.id')
      .select(
        'pah.*',
        'pc.name as product_name',
        'c.first_name', 'c.last_name', 'c.address_line1', 'c.city', 'c.zip',
        't.name as tech_name'
      );

    if (startDate) query = query.where('pah.application_date', '>=', startDate);
    if (endDate) query = query.where('pah.application_date', '<=', endDate);
    if (technicianId) query = query.where('pah.technician_id', technicianId);
    if (customerId) query = query.where('pah.customer_id', customerId);
    if (productName) query = query.where('pc.name', 'ilike', `%${productName}%`);

    // Count
    const countQuery = query.clone().clearSelect().clearOrder().count('* as count').first();
    const { count } = await countQuery;

    const rows = await query.orderBy('pah.application_date', 'desc').limit(limit).offset(offset);

    return {
      applications: rows.map(r => ({
        id: r.id,
        applicationDate: r.application_date,
        productName: r.product_name || 'Unknown',
        activeIngredient: r.active_ingredient,
        moaGroup: r.moa_group,
        epaRegNumber: r.epa_registration_number,
        applicationMethod: r.application_method,
        applicationRate: r.application_rate,
        rateUnit: r.rate_unit,
        quantityApplied: r.quantity_applied,
        quantityUnit: r.quantity_unit,
        areaTreated: r.area_treated_sqft,
        restrictedUse: r.restricted_use,
        applicatorLicense: r.applicator_license,
        customerName: r.first_name ? `${r.first_name} ${r.last_name}` : null,
        customerId: r.customer_id,
        address: r.address_line1,
        city: r.city,
        zip: r.zip,
        techName: r.tech_name,
        notes: r.notes,
      })),
      total: parseInt(count),
      limit,
      offset,
    };
  },

  /**
   * FL DACS structured compliance report.
   */
  async getDacsReport(startDate, endDate) {
    const start = startDate || new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0];
    const end = endDate || new Date().toISOString().split('T')[0];

    const rows = await db('property_application_history as pah')
      .leftJoin('products_catalog as pc', 'pah.product_id', 'pc.id')
      .leftJoin('customers as c', 'pah.customer_id', 'c.id')
      .leftJoin('technicians as t', 'pah.technician_id', 't.id')
      .where('pah.application_date', '>=', start)
      .where('pah.application_date', '<=', end)
      .select(
        'pah.*',
        'pc.name as product_name',
        'c.first_name', 'c.last_name', 'c.address_line1', 'c.city', 'c.state', 'c.zip',
        't.name as tech_name', 't.fl_applicator_license as tech_license'
      )
      .orderBy('pah.application_date', 'asc');

    const totalApplications = rows.length;
    const uniqueProducts = [...new Set(rows.map(r => r.product_name).filter(Boolean))];
    const restrictedUseCount = rows.filter(r => r.restricted_use).length;

    return {
      dateRange: { start, end },
      summary: { totalApplications, uniqueProducts: uniqueProducts.length, restrictedUseCount },
      applications: rows.map(r => ({
        date: r.application_date,
        applicatorName: r.tech_name,
        applicatorLicense: r.applicator_license || r.tech_license,
        customerName: r.first_name ? `${r.first_name} ${r.last_name}` : '',
        siteAddress: [r.address_line1, r.city, r.state, r.zip].filter(Boolean).join(', '),
        productName: r.product_name,
        epaRegNumber: r.epa_registration_number,
        activeIngredient: r.active_ingredient,
        applicationRate: r.application_rate,
        rateUnit: r.rate_unit,
        quantityApplied: r.quantity_applied,
        quantityUnit: r.quantity_unit,
        areaTreated: r.area_treated_sqft,
        applicationMethod: r.application_method,
        targetPest: r.target_pest,
        restrictedUse: r.restricted_use ? 'Yes' : 'No',
      })),
    };
  },

  /**
   * Export DACS-required CSV string.
   */
  async exportDacsCSV(startDate, endDate) {
    const report = await this.getDacsReport(startDate, endDate);
    const headers = [
      'Application Date', 'Applicator Name', 'Applicator License', 'Customer Name',
      'Site Address', 'Product Name', 'EPA Reg Number', 'Active Ingredient',
      'Application Rate', 'Rate Unit', 'Quantity Applied', 'Quantity Unit',
      'Area Treated (sqft)', 'Application Method', 'Target Pest', 'Restricted Use',
    ];

    const escape = (val) => {
      if (val == null) return '';
      const s = String(val);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    };

    const lines = [headers.join(',')];
    for (const a of report.applications) {
      lines.push([
        a.date, a.applicatorName, a.applicatorLicense, a.customerName,
        a.siteAddress, a.productName, a.epaRegNumber, a.activeIngredient,
        a.applicationRate, a.rateUnit, a.quantityApplied, a.quantityUnit,
        a.areaTreated, a.applicationMethod, a.targetPest, a.restrictedUse,
      ].map(escape).join(','));
    }

    return lines.join('\n');
  },

  /**
   * Check product limits for a customer (Celsius 3-app cap, nitrogen blackout, etc.)
   */
  async getProductLimits(customerId) {
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) throw new Error('Customer not found');

    const yearStart = `${new Date().getFullYear()}-01-01`;
    const today = new Date().toISOString().split('T')[0];

    // Get all applications this year for the customer
    const apps = await db('property_application_history')
      .where({ customer_id: customerId })
      .where('application_date', '>=', yearStart)
      .leftJoin('products_catalog', 'property_application_history.product_id', 'products_catalog.id')
      .select('property_application_history.*', 'products_catalog.name as product_name');

    // Get all product limits
    const limits = await db('product_limits');

    const results = [];
    for (const limit of limits) {
      let matchingApps = [];
      if (limit.match_type === 'product' && limit.product_id) {
        matchingApps = apps.filter(a => a.product_id === limit.product_id);
      } else if (limit.match_type === 'moa_group') {
        matchingApps = apps.filter(a => a.moa_group === limit.match_value);
      } else if (limit.match_type === 'nitrogen') {
        matchingApps = apps.filter(a =>
          a.category === 'fertilizer' || a.category === 'lawn' || a.active_ingredient?.toLowerCase().includes('nitrogen')
        );
      }

      let status = 'ok';
      let current = matchingApps.length;

      if (limit.limit_type === 'annual_max_apps') {
        if (current >= limit.limit_value) status = 'exceeded';
        else if (current >= limit.limit_value - 1) status = 'warning';
      } else if (limit.limit_type === 'seasonal_blackout') {
        const now = new Date(today);
        const seasonStart = new Date(limit.season_start);
        const seasonEnd = new Date(limit.season_end);
        // Normalize year for comparison
        seasonStart.setFullYear(now.getFullYear());
        seasonEnd.setFullYear(now.getFullYear());
        if (now >= seasonStart && now <= seasonEnd) status = 'blackout_active';
      }

      results.push({
        limitId: limit.id,
        productId: limit.product_id,
        matchType: limit.match_type,
        limitType: limit.limit_type,
        limitValue: limit.limit_value,
        currentUsage: current,
        status,
        severity: limit.severity,
        description: limit.description,
        jurisdiction: limit.jurisdiction,
      });
    }

    return {
      customerId,
      customerName: `${customer.first_name} ${customer.last_name}`,
      limits: results,
    };
  },

  /**
   * Nitrogen blackout status for all active lawn customers.
   */
  async getNitrogenStatus() {
    const today = new Date().toISOString().split('T')[0];
    const now = new Date();

    // Get nitrogen blackout limits
    const blackouts = await db('product_limits')
      .where({ match_type: 'nitrogen', limit_type: 'seasonal_blackout' });

    const activeBlackouts = blackouts.filter(b => {
      const start = new Date(b.season_start);
      const end = new Date(b.season_end);
      start.setFullYear(now.getFullYear());
      end.setFullYear(now.getFullYear());
      return now >= start && now <= end;
    });

    const lawnCustomers = await db('customers')
      .where({ active: true })
      .whereNotNull('lawn_type')
      .select('id', 'first_name', 'last_name', 'city', 'zip', 'lawn_type');

    const yearStart = `${now.getFullYear()}-01-01`;
    const statuses = [];

    for (const c of lawnCustomers) {
      const county = inferCountyFromZipInternal(c.zip);
      const isBlackout = activeBlackouts.some(b => b.jurisdiction === county);

      const nApps = await db('property_application_history')
        .where({ customer_id: c.id })
        .where('application_date', '>=', yearStart)
        .where(function () {
          this.where('category', 'fertilizer')
            .orWhere('category', 'lawn')
            .orWhere('active_ingredient', 'ilike', '%nitrogen%');
        })
        .count('* as count')
        .first();

      statuses.push({
        customerId: c.id,
        customerName: `${c.first_name} ${c.last_name}`,
        city: c.city,
        zip: c.zip,
        county: county || 'unknown',
        lawnType: c.lawn_type,
        blackoutActive: isBlackout,
        nitrogenAppsYTD: parseInt(nApps.count),
      });
    }

    return {
      blackoutPeriods: blackouts.map(b => ({
        jurisdiction: b.jurisdiction,
        start: b.season_start,
        end: b.season_end,
        description: b.description,
      })),
      customers: statuses,
      activeBlackoutCount: activeBlackouts.length,
    };
  },

  /**
   * Dashboard overview stats.
   */
  async getDashboard() {
    const yearStart = `${new Date().getFullYear()}-01-01`;
    const today = new Date().toISOString().split('T')[0];

    const [appCount] = await db('property_application_history')
      .where('application_date', '>=', yearStart)
      .count('* as count');

    const [productCount] = await db('property_application_history')
      .where('application_date', '>=', yearStart)
      .countDistinct('product_id as count');

    const [restrictedCount] = await db('property_application_history')
      .where('application_date', '>=', yearStart)
      .where({ restricted_use: true })
      .count('* as count');

    // Warnings: check product limits that are approaching or exceeded
    const limits = await db('product_limits')
      .where({ severity: 'hard_block' });
    let warningCount = 0;
    for (const limit of limits) {
      if (limit.limit_type === 'annual_max_apps' && limit.product_id) {
        const [usage] = await db('property_application_history')
          .where({ product_id: limit.product_id })
          .where('application_date', '>=', yearStart)
          .count('* as count');
        if (parseInt(usage.count) >= limit.limit_value - 1) warningCount++;
      }
    }

    // Tech license status
    const techs = await db('technicians')
      .whereNotNull('fl_applicator_license')
      .select('id', 'name', 'fl_applicator_license', 'license_expiry');
    const expiringLicenses = techs.filter(t => {
      if (!t.license_expiry) return false;
      const exp = new Date(t.license_expiry);
      const daysLeft = (exp - new Date()) / 86400000;
      return daysLeft <= 90 && daysLeft > 0;
    });

    // Recent applications
    const recentApps = await db('property_application_history as pah')
      .leftJoin('products_catalog as pc', 'pah.product_id', 'pc.id')
      .leftJoin('customers as c', 'pah.customer_id', 'c.id')
      .leftJoin('technicians as t', 'pah.technician_id', 't.id')
      .select('pah.id', 'pah.application_date', 'pc.name as product_name',
        'c.first_name', 'c.last_name', 't.name as tech_name')
      .orderBy('pah.application_date', 'desc')
      .limit(10);

    return {
      ytdApplications: parseInt(appCount.count),
      uniqueProducts: parseInt(productCount.count),
      warningCount,
      restrictedUseApps: parseInt(restrictedCount.count),
      licensedTechs: techs.length,
      expiringLicenses: expiringLicenses.length,
      recentApplications: recentApps.map(r => ({
        id: r.id,
        date: r.application_date,
        product: r.product_name,
        customer: r.first_name ? `${r.first_name} ${r.last_name}` : null,
        tech: r.tech_name,
      })),
    };
  },
};

// Internal helper for ZIP-to-county mapping
function inferCountyFromZipInternal(zip) {
  if (!zip) return null;
  const z = String(zip).substring(0, 5);
  const manatee = ['34201', '34202', '34203', '34204', '34205', '34206', '34207', '34208', '34209', '34210',
    '34211', '34212', '34219', '34221', '34222', '34243', '34250', '34251', '34280', '34281', '34282'];
  const sarasota = ['34228', '34229', '34230', '34231', '34232', '34233', '34234', '34235', '34236', '34237',
    '34238', '34239', '34240', '34241', '34242', '34260', '34275', '34276', '34277', '34278', '34286', '34287', '34288', '34289', '34292', '34293'];
  const charlotte = ['33947', '33948', '33949', '33950', '33952', '33953', '33954', '33955', '33980', '33981', '33982', '33983'];

  if (manatee.includes(z)) return 'manatee_county';
  if (sarasota.includes(z)) return 'sarasota_county';
  if (charlotte.includes(z)) return 'charlotte_county';
  return null;
}

module.exports = ComplianceService;
