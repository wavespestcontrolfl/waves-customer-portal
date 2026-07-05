const db = require('../models/db');
const logger = require('./logger');
const { etDateString, etParts } = require('../utils/datetime-et');
const { MANATEE_ZIPS, SARASOTA_ZIPS, CHARLOTTE_ZIPS } = require('../config/county-zips');

// service_records.conditions is jsonb (object via pg) but tolerate a raw
// JSON string — the writer must never throw on a malformed capture.
function parseConditionsObject(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return Array.isArray(raw) ? null : raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// "Partly cloudy 84F 71% RH" — fits the varchar(30) column. NULL when the
// capture has nothing useful; never a guessed value.
function weatherSummaryLabel(conditions) {
  if (!conditions) return null;
  const parts = [];
  if (conditions.sky) parts.push(String(conditions.sky));
  const temp = finiteOrNull(conditions.temp_f);
  if (temp != null) parts.push(`${Math.round(temp)}F`);
  const humidity = finiteOrNull(conditions.humidity_pct);
  if (humidity != null) parts.push(`${Math.round(humidity)}% RH`);
  return parts.length ? parts.join(' ').slice(0, 30) : null;
}

// service_products.targets is text[] of tech-selected pest keys. Join them
// verbatim (underscores humanized to spaces — presentational only, never a
// mapping guess); empty/missing → NULL. A blank target_pest beats a wrong
// one in a state-auditable ledger.
function targetPestFromTargets(targets) {
  const list = Array.isArray(targets) ? targets : [];
  const cleaned = list
    .map((t) => String(t || '').trim().replace(/_/g, ' '))
    .filter(Boolean);
  return cleaned.length ? cleaned.join(', ').slice(0, 200) : null;
}

// Only trust an explicit sqft measurement — never convert linear_ft or
// other units into square feet.
function areaTreatedSqft(sp) {
  if (String(sp.area_unit || '').toLowerCase() !== 'sqft') return null;
  const n = finiteOrNull(sp.area_value);
  return n != null && n > 0 ? Math.round(n) : null;
}

const ComplianceService = {

  /**
   * After service completion, create property_application_history records
   * from service_products — enriched with products_catalog data.
   *
   * Single source of truth for the FDACS application-record ledger: the
   * live V2 completion (admin-dispatch :serviceId/complete) calls it INSIDE
   * the completion transaction (pass { trx }), the legacy admin-schedule
   * status flip calls it fire-and-forget with no trx.
   *
   * Idempotent: each ledger row carries service_product_id (unique index,
   * migration 20260705000401) and the insert is ON CONFLICT DO NOTHING, so
   * retries / double-completions / backfill re-runs never duplicate rows.
   * Rows written before that column existed have NULL there — for those,
   * dedupe falls back to the resolved catalog product per record.
   */
  async createComplianceRecords(serviceRecordId, { trx } = {}) {
    const k = trx || db;

    const sr = await k('service_records')
      .where({ id: serviceRecordId })
      .first();
    if (!sr) throw new Error('Service record not found');

    const products = await k('service_products')
      .where({ service_record_id: serviceRecordId });
    if (!products.length) return [];

    const tech = sr.technician_id
      ? await k('technicians').where({ id: sr.technician_id }).first()
      : null;

    // Rows already ledgered for this record. New-style rows are identified
    // by service_product_id; legacy rows (NULL there) by catalog product.
    const existingRows = await k('property_application_history')
      .where({ service_record_id: serviceRecordId })
      .select('service_product_id', 'product_id');
    const ledgeredServiceProductIds = new Set(
      existingRows.map((r) => r.service_product_id).filter(Boolean)
    );
    const legacyLedgeredProductIds = new Set(
      existingRows.filter((r) => !r.service_product_id).map((r) => r.product_id).filter(Boolean)
    );
    // A legacy row with NO catalog product can't be tied to a specific
    // service_products row. When one exists, skip products that also resolve
    // to no catalog product — a duplicate in a state-auditable ledger
    // (inflating limit counts) is worse than leaving the legacy row as the
    // record of that application.
    const hasUnidentifiedLegacyRow = existingRows.some(
      (r) => !r.service_product_id && !r.product_id
    );

    // Weather at application time — captured on the service_record by the
    // completion route (fetchApplicationConditions → FAWN / Open-Meteo).
    const conditions = parseConditionsObject(sr.conditions);

    const records = [];
    for (const sp of products) {
      if (ledgeredServiceProductIds.has(sp.id)) continue;

      // Look up product catalog for EPA / active ingredient / MOA
      let catalog = null;
      if (sp.product_id) {
        catalog = await k('products_catalog').where({ id: sp.product_id }).first();
      } else if (sp.product_name) {
        catalog = await k('products_catalog')
          .where('name', 'ilike', `%${sp.product_name}%`)
          .first();
      }

      const productId = catalog?.id || sp.product_id || null;
      if (productId && legacyLedgeredProductIds.has(productId)) continue;
      if (!productId && hasUnidentifiedLegacyRow) continue;

      const record = {
        customer_id: sr.customer_id,
        service_record_id: serviceRecordId,
        service_product_id: sp.id,
        product_id: productId,
        technician_id: sr.technician_id,
        application_date: sr.service_date || etDateString(),
        // Quantity actually applied lives in total_amount/amount_unit on
        // service_products. The old writer read the nonexistent
        // sp.quantity_applied and fell back to the application RATE —
        // conflating rate with quantity in the DACS export, which reports
        // both fields separately. No rate fallback: an absent quantity
        // stays NULL rather than misreporting the rate as a total.
        quantity_applied: finiteOrNull(sp.total_amount),
        quantity_unit: sp.total_amount != null ? (sp.amount_unit || sp.rate_unit || null) : null,
        application_rate: sp.application_rate || null,
        rate_unit: sp.rate_unit || null,
        active_ingredient: catalog?.active_ingredient || sp.active_ingredient || null,
        moa_group: catalog?.moa_group || sp.moa_group || null,
        category: sp.product_category || catalog?.category || null,
        epa_registration_number: catalog?.epa_registration_number || catalog?.epa_reg_number
          || sp.epa_reg_number || null,
        application_method: sp.application_method || null,
        target_pest: targetPestFromTargets(sp.targets),
        area_treated_sqft: areaTreatedSqft(sp),
        application_site: sp.application_area || null,
        weather_conditions: weatherSummaryLabel(conditions),
        wind_speed_mph: finiteOrNull(conditions?.wind_mph) != null
          ? Math.round(finiteOrNull(conditions?.wind_mph))
          : null,
        soil_temp_f: finiteOrNull(conditions?.soil_temp_f) ?? finiteOrNull(sr.soil_temp),
        restricted_use: catalog?.restricted_use || false,
        applicator_license: tech?.fl_applicator_license || null,
        notes: sp.notes || null,
      };

      const inserted = await k('property_application_history')
        .insert(record)
        .onConflict('service_product_id')
        .ignore()
        .returning('*');
      if (inserted.length) records.push(inserted[0]);
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
    const start = startDate || `${etParts().year}-01-01`;
    const end = endDate || etDateString();

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

    const yearStart = `${etParts().year}-01-01`;
    const today = etDateString();

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
        // Compare ET calendar MM-DD, not UTC Date objects — blackout windows
        // are legal dates, not absolute timestamps.
        const mmdd = (s) => String(s).slice(5, 10);
        const startMMDD = mmdd(limit.season_start);
        const endMMDD = mmdd(limit.season_end);
        const todayMMDD = today.slice(5, 10);
        const inRange = startMMDD <= endMMDD
          ? todayMMDD >= startMMDD && todayMMDD <= endMMDD
          : todayMMDD >= startMMDD || todayMMDD <= endMMDD; // window wraps year boundary
        if (inRange) status = 'blackout_active';
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
    const today = etDateString();
    const { year } = etParts();

    // Get nitrogen blackout limits
    const blackouts = await db('product_limits')
      .where({ match_type: 'nitrogen', limit_type: 'seasonal_blackout' });

    const mmdd = (s) => String(s).slice(5, 10);
    const todayMMDD = today.slice(5, 10);
    const activeBlackouts = blackouts.filter(b => {
      const startMMDD = mmdd(b.season_start);
      const endMMDD = mmdd(b.season_end);
      return startMMDD <= endMMDD
        ? todayMMDD >= startMMDD && todayMMDD <= endMMDD
        : todayMMDD >= startMMDD || todayMMDD <= endMMDD;
    });

    const lawnCustomers = await db('customers')
      .where({ active: true })
      .whereNotNull('lawn_type')
      .select('id', 'first_name', 'last_name', 'city', 'zip', 'lawn_type');

    const yearStart = `${year}-01-01`;
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
    const yearStart = `${etParts().year}-01-01`;
    const today = etDateString();

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

// Internal helper for ZIP-to-county mapping. Compliance covers only the three
// counties Waves operates in and returns the '<county>_county' form; it shares
// the ZIP sets with tax-calculator via config/county-zips.js (LEE/COLLIER there
// are tax-only and intentionally not referenced here).
function inferCountyFromZipInternal(zip) {
  if (!zip) return null;
  const z = String(zip).substring(0, 5);

  if (MANATEE_ZIPS.includes(z)) return 'manatee_county';
  if (SARASOTA_ZIPS.includes(z)) return 'sarasota_county';
  if (CHARLOTTE_ZIPS.includes(z)) return 'charlotte_county';
  return null;
}

module.exports = ComplianceService;
// Exported for testing — verifies ZIP→county inference is unchanged after the
// shared-array extraction.
module.exports.inferCountyFromZipInternal = inferCountyFromZipInternal;
