const db = require('../models/db');
const { etParts, etCalendarDayOf } = require('../utils/datetime-et');
const { convertInventoryQuantity } = require('./inventory-units');

// annual_max_rate rows with match_type 'active_ingredient' are one yearly cap on an
// active ingredient shared by every product that carries it (prodiamine: 65 WDG,
// Stonewall 4FL, the Stonewall granulars). Each product has its own row, whose
// limit_value is the label cap written in THAT product's rate unit per 1,000 sq ft
// (limit_unit 'lb/1000sf/year', 'fl oz/1000sf/year'), so the products add up as
// shares of one cap with no unit conversion between formulations.
const AI_CAP = 'active_ingredient';
const AI_CAP_APPROACHING = 0.75;

const pct = (share) => Math.round(share * 1000) / 10;
const capUnitOf = (limitUnit) => String(limitUnit || '').split('/')[0].trim();
// A recorded rate is per 1,000 sq ft in its own unit; ONLY that basis converts here
// ('fl oz/gal' and 'per acre' units are other bases and read as unsized).
function rateInUnit(amount, unit, toUnit) {
  const n = Number(amount);
  const raw = String(unit || '').trim();
  if (!(n > 0) || !raw || !toUnit) return null;
  const stripped = raw.replace(/\s*\/\s*1000\s*(sf|sq\.?\s*ft)?$/i, '');
  if (stripped.includes('/')) return null;
  return convertInventoryQuantity(n, stripped, toUnit);
}

// One ledger row as a share of its own product's cap (see AI_CAP): its recorded
// rate, else its quantity over the treated area, else the product's standard rate
// (flagged estimated). null when the row has no cap row or cannot be sized at all.
function capShare(row) {
  const cap = Number(row.limit_value);
  const unit = capUnitOf(row.limit_unit);
  if (!(cap > 0) || !unit) return null;
  const area = Number(row.area_treated_sqft);
  let rate = rateInUnit(row.application_rate, row.rate_unit, unit);
  if (rate == null && area > 0) rate = rateInUnit(Number(row.quantity_applied) / (area / 1000), row.quantity_unit, unit);
  if (rate != null) return { share: rate / cap, estimated: false };
  rate = rateInUnit(row.default_rate_per_1000, row.catalog_rate_unit, unit);
  return rate == null ? null : { share: rate / cap, estimated: true };
}

// What could not be counted exactly, for the end of a cap message.
function sizingNote(unsized, estimated) {
  const notes = [
    unsized ? `${unsized} earlier application${unsized === 1 ? '' : 's'} could not be sized and ${unsized === 1 ? 'was' : 'were'} not counted` : null,
    estimated ? `${estimated} sized at the product's standard rate` : null,
  ].filter(Boolean);
  return notes.length ? ` (${notes.join('; ')})` : '';
}

// product_limits rows written for the lawn bermuda removal step (migration
// 20261006190300) carry this program tag in match_value (unused on product rows). They
// apply ONLY to a caller that passes opts.program === 'bermuda_removal' (the plan's and
// the tank sheet's bermuda step check) while GATE_LAWN_BERMUDA_REMOVAL is on; every
// other caller (compliance, previsit, other plan lines, Fusilade II used elsewhere)
// ignores them. They count the treated property's history, and only the applications
// recorded as part of the step: the history ledger carries no group, and Recognition is
// always in the mix and never used elsewhere in v13, so BOTH products' annual and
// interval limits count Recognition applications.
const BERMUDA_PROGRAM = 'bermuda_removal';
const BERMUDA_COUNTED_PRODUCT = 'Recognition Post Emergent Herbicide';
const isBermudaProgramRow = (limit) => limit.match_value === BERMUDA_PROGRAM;

// The treated property only: a ledger row at another of the customer's properties does
// not count. A row whose property is unknown (no visit, or a visit with no property)
// cannot be proven elsewhere, so it still counts. `query` selects from
// property_application_history as pah.
function scopeToProperty(query, propertyId) {
  return query.leftJoin('service_records as sr', 'pah.service_record_id', 'sr.id')
    .leftJoin('scheduled_services as ss', 'sr.scheduled_service_id', 'ss.id')
    .where(function sameProperty() { this.whereNull('ss.property_id').orWhere('ss.property_id', propertyId); });
}

class ApplicationLimitChecker {
  // opts.proposed ({ ratePer1000, unit }) is the application being planned: a yearly
  // cap shared across formulations counts it with the season's earlier ones. A
  // caller that reads AFTER the application was ledgered (completion, the compliance
  // page) passes none, so the application is never counted twice.
  // opts.excludeScheduledServiceId leaves that visit's own ledger rows out of the
  // shared cap, for a plan rebuilt after the visit completed. opts.propertyId limits the
  // shared cap to the treated property (no property: every property of the customer).
  async checkLimits(customerId, productId, proposedDate = new Date(), database = db, opts = {}) {
    const product = await database('products_catalog').where({ id: productId }).first();
    if (!product) return { allowed: true, warnings: [], blocks: [] };

    const results = { allowed: true, warnings: [], blocks: [] };
    const customer = await database('customers').where({ id: customerId }).first();
    const county = this.getCounty(customer);
    const yearStart = this.getYearStart(proposedDate);

    // Product-specific history
    // Retracted rows (recap deselection corrections) never count toward
    // application limits.
    const history = await database('property_application_history')
      .where({ customer_id: customerId, product_id: productId })
      .where('application_date', '>=', yearStart)
      .whereNull('retracted_at')
      .orderBy('application_date', 'desc');

    // MOA group history
    const moaHistory = product.moa_group ? await database('property_application_history')
      .where({ customer_id: customerId, moa_group: product.moa_group })
      .whereNull('retracted_at')
      .orderBy('application_date', 'desc').limit(10) : [];

    // Get applicable limits
    const productLimits = await database('product_limits').where({ product_id: productId });
    const moaLimits = product.moa_group ? await database('product_limits')
      .where({ match_type: 'moa_group', match_value: product.moa_group }) : [];
    const nitrogenLimits = this.isNitrogenFertilizer(product)
      ? await database('product_limits').where({ match_type: 'nitrogen' }).where(function () {
          this.whereNull('jurisdiction').orWhere('jurisdiction', county).orWhere('jurisdiction', 'all');
        }) : [];

    // Bermuda removal rows: inert unless the gate is on (gate off, every result is the
    // one before the rows existed); when on, their history is the treated property's.
    const bermudaLive = require('../config/feature-gates').lawnBermudaRemovalLive?.() === true;
    const allLimits = [...productLimits, ...moaLimits, ...nitrogenLimits]
      .filter((limit) => !isBermudaProgramRow(limit) || (bermudaLive && opts.program === BERMUDA_PROGRAM));
    let bermudaHistory = null;

    for (const limit of allLimits) {
      let limitHistory = history;
      if (isBermudaProgramRow(limit)) {
        if (!bermudaHistory) bermudaHistory = await this.propertyHistory(database, { customerId, yearStart, proposedDate, ...opts });
        limitHistory = bermudaHistory;
      }
      const check = await this.evaluateLimit(limit, limitHistory, moaHistory, proposedDate, product, database, { customerId, yearStart, ...opts });

      if (check.violated) {
        const entry = { type: limit.limit_type, matchType: limit.match_type || null, matchValue: limit.match_value || null, message: check.message, description: limit.description, current: check.current, max: check.max };
        if (limit.severity === 'hard_block') {
          results.blocks.push(entry);
          results.allowed = false;
        } else {
          results.warnings.push({ ...entry, severity: limit.severity });
        }
      } else if (check.approaching) {
        results.warnings.push({ type: limit.limit_type, severity: 'info', message: check.message, current: check.current, max: check.max });
      }
    }

    return results;
  }

  // The season history for a bermuda removal limit: Recognition applications (the step's
  // marker, for both products), the treated property's rows plus rows with an unknown
  // property (no property: the whole customer), leaving out the visit being planned or
  // rebuilt.
  async propertyHistory(database, { customerId, yearStart, proposedDate, propertyId, excludeScheduledServiceId }) {
    const query = database('property_application_history as pah')
      .join('products_catalog as counted', 'counted.id', 'pah.product_id')
      .where({ 'pah.customer_id': customerId })
      .where('counted.name', BERMUDA_COUNTED_PRODUCT)
      .where('pah.application_date', '>=', yearStart)
      // On or before the date judged, as the active-ingredient cap does: a plan rebuilt for
      // April is not withheld by a June spray that had not happened yet.
      .where('pah.application_date', '<=', etCalendarDayOf(proposedDate))
      .whereNull('pah.retracted_at');
    if (propertyId) scopeToProperty(query, propertyId);
    if (excludeScheduledServiceId) {
      query.where(function notThisVisit() {
        this.whereNull('pah.service_record_id')
          .orWhereNotIn('pah.service_record_id', database('service_records').where({ scheduled_service_id: excludeScheduledServiceId }).select('id'));
      });
    }
    return query.select('pah.*').orderBy('pah.application_date', 'desc');
  }

  async evaluateLimit(limit, history, moaHistory, proposedDate, product, database = db, ctx = {}) {
    // product_limits.limit_value is a pg decimal — node-pg returns it as a
    // STRING ('14.0000'); coerce once so `< minDays + 7` etc. stay numeric.
    const limitValue = limit.limit_value == null ? null : Number(limit.limit_value);
    switch (limit.limit_type) {
      case 'annual_max_apps': {
        const count = history.length;
        const max = limitValue;
        if (count >= max) return { violated: true, message: `${product.name}: ${count}/${max} applications this year — LIMIT REACHED.`, current: count, max };
        if (count >= max - 1) return { approaching: true, message: `${product.name}: ${count}/${max} this year — this would be the LAST allowed.`, current: count, max };
        return { violated: false, current: count, max };
      }

      case 'min_interval_days': {
        if (!history.length) return { violated: false };
        // pg `date` columns arrive as JS Date objects (no type parser is
        // configured) — normalize to YYYY-MM-DD before building the anchor.
        // Both operands are ET calendar days anchored at noon UTC so the
        // interval is whole days regardless of the proposed instant's clock.
        const lastApp = new Date(etCalendarDayOf(history[0].application_date) + 'T12:00:00Z');
        // proposedDate may itself be a hydrated pg DATE (admin-dispatch passes
        // svc.scheduled_date) — etCalendarDayOf keeps its literal calendar day.
        const proposedDay = new Date(etCalendarDayOf(proposedDate) + 'T12:00:00Z');
        const daysSince = Math.floor((proposedDay - lastApp) / 86400000);
        const minDays = limitValue;
        if (daysSince < minDays) return { violated: true, message: `${product.name}: only ${daysSince} days since last app (min ${minDays}). Next allowed: ${new Date(lastApp.getTime() + minDays * 86400000).toLocaleDateString('en-US', { timeZone: 'America/New_York' })}.`, current: daysSince, max: minDays };
        if (daysSince < minDays + 7) return { approaching: true, message: `${product.name}: ${daysSince} days since last app (min ${minDays}). Just cleared.`, current: daysSince, max: minDays };
        return { violated: false, current: daysSince, max: minDays };
      }

      case 'annual_max_rate': {
        if (limit.match_type === AI_CAP) return this.evaluateActiveIngredientCap(limit, product, { ...ctx, proposedDate }, database);
        const totalApplied = history.reduce((sum, h) => sum + (parseFloat(h.application_rate) || 0), 0);
        const maxRate = limitValue;
        if (totalApplied >= maxRate * 0.95) return { violated: true, message: `${product.name}: cumulative ${totalApplied.toFixed(3)} ${limit.limit_unit} approaching/exceeding max ${maxRate}.`, current: totalApplied, max: maxRate };
        return { violated: false, current: totalApplied, max: maxRate };
      }

      case 'seasonal_blackout': {
        if (!limit.season_start || !limit.season_end) return { violated: false };
        // Compare ET calendar days (YYYY-MM-DD), not Date objects — blackout
        // windows are legal calendar dates, not absolute timestamps.
        // proposedDate may be a hydrated pg DATE (UTC midnight) — keep its
        // literal calendar day rather than shifting to the prior ET day.
        const proposedYMD = etCalendarDayOf(proposedDate);
        // season_start/season_end are pg `date` columns → JS Date objects;
        // String(date).slice(5, 10) yields "Jun 0", never a MM-DD.
        const startMMDD = etCalendarDayOf(limit.season_start).slice(5, 10);
        const endMMDD = etCalendarDayOf(limit.season_end).slice(5, 10);
        const proposedMMDD = proposedYMD.slice(5, 10);
        const wraps = startMMDD > endMMDD;
        const inRange = wraps
          ? (proposedMMDD >= startMMDD || proposedMMDD <= endMMDD)
          : (proposedMMDD >= startMMDD && proposedMMDD <= endMMDD);
        if (inRange) {
          const startLabel = `${startMMDD.slice(0, 2)}/${startMMDD.slice(3)}`;
          const endLabel = `${endMMDD.slice(0, 2)}/${endMMDD.slice(3)}`;
          return { violated: true, message: `BLACKOUT: ${(limit.jurisdiction || '').replace(/_/g, ' ')} restricts nitrogen ${startLabel} — ${endLabel}. Use iron/potassium only.`, current: 'in_blackout', max: 'none' };
        }
        // Approaching-window check: compute days-until using ET calendar math.
        const proposedYear = Number(proposedYMD.slice(0, 4));
        const startYear = proposedMMDD <= startMMDD ? proposedYear : proposedYear + 1;
        const startDate = new Date(`${startYear}-${startMMDD}T12:00:00Z`);
        const proposedAnchor = new Date(`${proposedYMD}T12:00:00Z`);
        const daysUntil = Math.floor((startDate - proposedAnchor) / 86400000);
        if (daysUntil > 0 && daysUntil <= 14) return { approaching: true, message: `Nitrogen blackout starts in ${daysUntil} days. May be last nitrogen window.`, current: daysUntil, max: 0 };
        return { violated: false };
      }

      case 'consecutive_use_max':
      case 'moa_rotation_max': {
        let consecutive = 0;
        for (const app of moaHistory) {
          if (app.moa_group === product.moa_group) consecutive++;
          else break;
        }
        const max = limitValue;
        if (consecutive >= max) {
          const alternatives = await database('products_catalog')
            .where('category', product.category).whereNot('moa_group', product.moa_group)
            .where({ active: true }).select('name', 'moa_group').limit(3);
          const altNames = alternatives.map(a => `${a.name} (${a.moa_group})`).join(', ');
          return { violated: true, message: `MOA rotation due: ${consecutive} consecutive ${product.moa_group}. Rotate to: ${altNames || 'check catalog'}.`, current: consecutive, max };
        }
        if (consecutive >= max - 1) return { approaching: true, message: `${product.moa_group}: ${consecutive}/${max} consecutive. Rotate after next use.`, current: consecutive, max };
        return { violated: false, current: consecutive, max };
      }

      default: return { violated: false };
    }
  }

  // The season's applications of every product that shares this limit's active
  // ingredient, each as a share of its own product's cap, plus the application
  // being planned. An application that cannot be sized from its recorded rate or
  // quantity counts at its product's standard rate; one with no cap row for its
  // product is named, never counted as nothing.
  async evaluateActiveIngredientCap(limit, product, ctx, database = db) {
    const key = String(limit.match_value || '').trim();
    const like = `${key.replace(/[\\%_]/g, '\\$&')}%`;
    const query = database('property_application_history as pah')
      .leftJoin('products_catalog as pc', 'pah.product_id', 'pc.id')
      .leftJoin('product_limits as pl', function joinCapRow() {
        this.on('pl.product_id', 'pah.product_id')
          .andOnVal('pl.match_type', AI_CAP).andOnVal('pl.match_value', key).andOnVal('pl.limit_type', 'annual_max_rate');
      })
      .where('pah.customer_id', ctx.customerId)
      .where('pah.application_date', '>=', ctx.yearStart)
      // Applications on or before the date judged: a backdated January completion is not
      // counted against October's application, which had not happened yet.
      .where('pah.application_date', '<=', etCalendarDayOf(ctx.proposedDate))
      .whereNull('pah.retracted_at')
      .where(function sharesIngredient() {
        this.whereRaw('pc.active_ingredient ILIKE ?', [like]).orWhereRaw('pah.active_ingredient ILIKE ?', [like]);
      })
      .select('pah.application_rate', 'pah.rate_unit', 'pah.quantity_applied', 'pah.quantity_unit', 'pah.area_treated_sqft',
        'pl.limit_value', 'pl.limit_unit', 'pc.default_rate_per_1000', 'pc.rate_unit as catalog_rate_unit');
    if (ctx.propertyId) scopeToProperty(query, ctx.propertyId);
    if (ctx.excludeScheduledServiceId) {
      query.where(function notThisVisit() {
        this.whereNull('pah.service_record_id')
          .orWhereNotIn('pah.service_record_id', database('service_records').where({ scheduled_service_id: ctx.excludeScheduledServiceId }).select('id'));
      });
    }
    const history = await query;

    let used = 0;
    let unsized = 0;
    let estimated = 0;
    for (const row of history) {
      const sized = capShare(row);
      if (!sized) { unsized += 1; continue; }
      used += sized.share;
      if (sized.estimated) estimated += 1;
    }

    const proposed = ctx.proposed
      ? rateInUnit(ctx.proposed.ratePer1000, ctx.proposed.unit, capUnitOf(limit.limit_unit)) / Number(limit.limit_value)
      : 0;
    const adds = Number.isFinite(proposed) && proposed > 0 ? proposed : 0;
    const total = used + adds;
    const detail = sizingNote(unsized, estimated);
    const label = `${product.name}: ${key} across all products this year is ${pct(used)}% of the yearly label cap`;
    const withThis = adds ? `; this application brings it to ${pct(total)}%` : '';
    if (used >= 1 || total > 1 + 1e-9) {
      return { violated: true, message: `${label}${withThis} — ${used >= 1 ? 'LIMIT REACHED' : 'THIS APPLICATION WOULD EXCEED IT'}${detail}.`, current: pct(used), max: 100 };
    }
    // Approaching is the projected season (earlier applications plus the one being planned).
    if (total >= AI_CAP_APPROACHING || unsized) {
      return { approaching: true, message: `${label}${withThis}${detail}.`, current: pct(used), max: 100 };
    }
    return { violated: false, current: pct(used), max: 100 };
  }

  async getPropertyComplianceStatus(customerId) {
    const customer = await db('customers').where({ id: customerId }).first();
    const county = this.getCounty(customer);
    const yearStart = this.getYearStart(new Date());

    const applications = await db('property_application_history')
      .where({ customer_id: customerId }).where('application_date', '>=', yearStart)
      .whereNull('property_application_history.retracted_at')
      .leftJoin('products_catalog', 'property_application_history.product_id', 'products_catalog.id')
      .select('property_application_history.*', 'products_catalog.name as product_name')
      .orderBy('application_date', 'desc');

    const byProduct = {};
    for (const app of applications) {
      if (!byProduct[app.product_id]) byProduct[app.product_id] = { name: app.product_name, apps: [] };
      byProduct[app.product_id].apps.push(app);
    }

    const status = { products: [], warnings: 0, blocks: 0, county, totalApplications: applications.length };
    for (const [productId, data] of Object.entries(byProduct)) {
      const check = await this.checkLimits(customerId, productId);
      status.products.push({ productId, productName: data.name, applicationsThisYear: data.apps.length, lastApplied: data.apps[0]?.application_date, limits: check });
      status.warnings += check.warnings.length;
      status.blocks += check.blocks.length;
    }

    // Nitrogen budget
    const nitrogenApps = applications.filter(a => this.isNitrogenFertilizer(a));
    const totalN = nitrogenApps.reduce((sum, a) => {
      const npk = (a.product_name || '').match(/(\d+)-(\d+)-(\d+)/);
      const nPct = npk ? parseInt(npk[1]) / 100 : 0;
      return sum + ((parseFloat(a.quantity_applied) || 0) * nPct);
    }, 0);

    status.nitrogenBudget = {
      applied: Math.round(totalN * 100) / 100,
      limit: 4.0, remaining: Math.round((4.0 - totalN) * 100) / 100,
      unit: 'lb N/1000sf', county,
      inBlackout: this.isInBlackout(new Date(), county),
    };

    return status;
  }

  getCounty(customer) {
    if (!customer) return 'all';
    const city = (customer.city || '').toLowerCase();
    if (['bradenton', 'lakewood ranch', 'parrish', 'palmetto', 'ellenton'].includes(city)) return 'manatee_county';
    if (['sarasota', 'venice', 'nokomis', 'osprey', 'north port', 'englewood'].includes(city)) return 'sarasota_county';
    return 'all';
  }

  isNitrogenFertilizer(product) {
    const cat = (product.category || '').toLowerCase();
    if (cat !== 'fertilizer') return false;
    const name = (product.name || product.product_name || '').toLowerCase();
    const npk = name.match(/(\d+)-(\d+)-(\d+)/);
    if (npk && parseInt(npk[1]) > 0) return true;
    if (name.includes('urea') || name.includes('ammonium') || name.includes('nitrogen')) return true;
    return false;
  }

  isInBlackout(date, county) {
    if (county !== 'sarasota_county' && county !== 'manatee_county') return false;
    const month = etParts(date).month; // 1-12 (ET calendar month)
    return month >= 6 && month <= 9;   // June-Sept inclusive — was UTC month 5-8
  }

  // Accepts a true instant or a hydrated pg DATE — etCalendarDayOf keeps a
  // UTC-midnight Jan 1 as Jan 1 (etParts would read it as Dec 31 ET).
  getYearStart(date) { return `${etCalendarDayOf(date).slice(0, 4)}-01-01`; }
}

module.exports = new ApplicationLimitChecker();
