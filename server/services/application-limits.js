const db = require('../models/db');
const { etParts, etCalendarDayOf } = require('../utils/datetime-et');
const { convertInventoryQuantity } = require('./inventory-units');
const { applyV13CountCaps, V13_AMOUNT } = require('../config/lawn-v13-count-caps');
const V13_VERSION = '2026.10-v13';
const { worstPropertyCount, worstPropertyTotal } = require('../utils/property-counts');

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

const WEIGHT_UNITS = new Set(['oz', 'ounce', 'ounces', 'lb', 'lbs', 'pound', 'pounds', 'g', 'gram', 'grams', 'kg', 'mg']);
const VOLUME_UNITS = new Set(['fl oz', 'floz', 'fl_oz', 'gal', 'gallon', 'gallons', 'qt', 'pt', 'ml', 'l', 'liter', 'liters', 'tsp', 'tbsp']);
function unitFamily(unit) {
  const key = String(unit || '').trim().toLowerCase().replace(/\./g, '');
  if (WEIGHT_UNITS.has(key)) return 'weight';
  return VOLUME_UNITS.has(key) ? 'volume' : null;
}

// A bermuda removal history row's rate per 1,000 sq ft in the cap's own unit: its recorded
// rate converted from the unit it was recorded in (0.01 lb counts as 0.16 oz); when that
// cannot convert, its quantity over the treated area. A rate or quantity that does not
// convert (another basis, another dimension, no unit, no area) is not counted as it stands:
// it counts for nothing.
// Other rows keep counting only a recorded rate, as recorded.
function bermudaRowRate(row, limit) {
  const capUnit = capUnitOf(limit.limit_unit);
  const recorded = parseFloat(row.application_rate);
  // An explicit rate that converts is used; one that cannot (oz/acre, an unknown unit) falls
  // back to the quantity over the treated area, with the same unit-family checks.
  const converted = recorded > 0 ? familyConvert(recorded, row.rate_unit, capUnit) : 0;
  if (converted > 0) return converted;
  const area = Number(row.area_treated_sqft);
  if (!(area > 0)) return 0;
  return familyConvert(Number(row.quantity_applied) / (area / 1000), row.quantity_unit, capUnit);
}

// Convert within a unit family only: a weight against a weight cap, a volume against a
// volume cap (a gallon amount never reads as ounces of dry product).
function familyConvert(amount, unit, capUnit) {
  // A recorded rate may carry its basis ('oz/1000sf'): the family is the unit before it.
  const family = unitFamily(String(unit || '').replace(/\s*\/\s*1000\s*(sf|sq\.?\s*ft)?$/i, ''));
  if (family == null || family !== unitFamily(capUnit)) return 0;
  return rateInUnit(amount, unit, capUnit) || 0;
}

// One earlier application as a share of a v13 yearly amount cap (the synthetic row of lawn-v13-count-caps):
// the ledger's own reading only (the recorded rate, else the quantity over the treated area), and when the
// ledger cannot size it the row's FIXED fallback rate (Arena: the old 0.29 oz, the whole year) - never the
// catalog default, which an admin can change (to the new 0.147) and so halve what an unreadable full-rate pass counts.
function v13AmountShare(row, limit) {
  const sized = capShare({ ...row, default_rate_per_1000: null, limit_value: limit.limit_value, limit_unit: limit.limit_unit });
  if (sized) return sized;
  return { share: Number(limit.fallback_rate) / Number(limit.limit_value), estimated: true };
}

// The year's total against an annual_max_rate row, and the note its message carries.
// An ordinary row judges recorded history only, each row's rate as recorded. The bermuda removal
// row counts each row in the cap's own unit (bermudaRowRate) and warns on the PROJECTED year, as
// the active-ingredient cap does: earlier sprays plus the one being planned (the staged rate) or
// recorded (the submitted rate).
function yearRateTotal(limit, history, ctx) {
  if (!isBermudaProgramRow(limit)) {
    return { totalApplied: history.reduce((sum, h) => sum + (parseFloat(h.application_rate) || 0), 0), note: '' };
  }
  const applied = history.reduce((sum, h) => sum + bermudaRowRate(h, limit), 0);
  const proposed = ctx.proposed ? rateInUnit(ctx.proposed.ratePer1000, ctx.proposed.unit, capUnitOf(limit.limit_unit)) : null;
  const adds = Number.isFinite(proposed) && proposed > 0 ? proposed : 0;
  return { totalApplied: applied + adds, note: adds ? ` (${applied.toFixed(3)} recorded plus ${adds.toFixed(3)} for this application)` : '' };
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
// The counted product is Recognition, found by its catalog ID, never its display name:
// the id of the product on the program's tagged annual_max_rate row (the label rate
// belongs to Recognition alone), read once per call. A program with no such row counts
// the product being judged itself.
const isBermudaProgramRow = (limit) => limit.match_value === BERMUDA_PROGRAM;

// Narrows a property_application_history query to the treated property and leaves one
// visit's own ledger rows out. `table` is the history table or its alias in the query.
// A row whose property is unknown (no visit, or a visit with no property) cannot be proven
// elsewhere, so it still counts. No option, no change.
function scopeHistoryToTreatment(query, database, { propertyId, excludeScheduledServiceId } = {}, table) {
  if (propertyId) {
    // The row's treated property is the one frozen on the ledger when it was written (an address
    // correction on the visit later must not move it). A row placed elsewhere is out; a legacy row
    // with no frozen property falls back to its visit's property, and one with no property at all
    // cannot be proven elsewhere, so it still counts.
    query.where(function placedHereOrUnplaced() {
      this.whereNull(`${table}.property_id`).orWhere(`${table}.property_id`, propertyId);
    });
    query.whereNotExists(function elsewhere() {
      this.select(database.raw('1')).from('service_records as sr_scope')
        .join('scheduled_services as ss_scope', 'sr_scope.scheduled_service_id', 'ss_scope.id')
        .whereRaw('sr_scope.id = ??.service_record_id', [table])
        .whereRaw('??.property_id is null', [table])
        .whereNotNull('ss_scope.property_id')
        .whereNot('ss_scope.property_id', propertyId);
    });
  }
  if (excludeScheduledServiceId) {
    query.where(function notThisVisit() {
      this.whereNull(`${table}.service_record_id`)
        .orWhereNotIn(`${table}.service_record_id`, database('service_records').where({ scheduled_service_id: excludeScheduledServiceId }).select('id'));
    });
  }
  return query;
}

class ApplicationLimitChecker {
  // opts.proposed ({ ratePer1000, unit }) is the application being planned: a yearly
  // cap shared across formulations counts it with the season's earlier ones. A
  // caller that reads AFTER the application was ledgered (completion, the compliance
  // page) passes none, so the application is never counted twice.
  // opts.proposal (true) marks a PROPOSAL check that names no dose (POST /api/admin/compliance/check-limits): a v13 yearly
  // amount cap then counts the program's dose for the product with the season's earlier applications. A status-only read
  // (the compliance page, a read after the ledger write) passes neither and adds nothing.
  // opts.excludeScheduledServiceId leaves that visit's own ledger rows out of the product
  // history and the shared cap, for a plan rebuilt after the visit completed. opts.propertyId
  // limits both to the treated property (no property: every property of the customer).
  // Both read applications up to the proposed ET day only.
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
    // Applications on or before the day judged, as the shared cap reads them: a backdated
    // completion is not held against an application that had not happened yet. The treated
    // property and the visit being planned scope this history exactly as they scope the shared
    // cap below; a caller that passes neither reads the customer's whole history.
    const priorApplications = () => scopeHistoryToTreatment(database('property_application_history')
      .where({ customer_id: customerId, product_id: productId })
      .where('application_date', '<=', etCalendarDayOf(proposedDate))
      .whereNull('retracted_at'), database, opts, 'property_application_history')
      .orderBy('application_date', 'desc');
    const history = await priorApplications().where('application_date', '>=', yearStart);

    // MOA group history
    const moaHistory = product.moa_group ? await database('property_application_history')
      .where({ customer_id: customerId, moa_group: product.moa_group })
      .whereNull('retracted_at')
      .orderBy('application_date', 'desc').limit(10) : [];

    // Get applicable limits
    // The v13 program's own count cap (Celsius: 2) while GATE_LAWN_V13 is on; the stored row is the legacy value.
    const productLimits = await applyV13CountCaps(database, product, await database('product_limits').where({ product_id: productId }), productId);
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
    // The rows judged on the product's own history (every row but a bermuda removal row).
    const ownLimits = allLimits.filter((limit) => !isBermudaProgramRow(limit));
    // A minimum interval spans the new year (a December application and a February one are 50
    // days apart): it reads the latest earlier application whatever its calendar year. This
    // year's newest row is that application when there is one; only an empty year looks back.
    const needsInterval = ownLimits.some((limit) => limit.limit_type === 'min_interval_days');
    const lastApplication = history[0] || (needsInterval ? await priorApplications().first() : null);

    // A yearly count is per lawn. With a treated property the history is already that property's; a
    // caller with none (the compliance page, the legacy check-limits route) is judged on the busiest
    // property of the customer, never on the sum across properties.
    const needsAnnual = ownLimits.some((limit) => limit.limit_type === 'annual_max_apps');
    const annualCount = needsAnnual ? await this.annualCountFor(database, history, opts) : history.length;

    const own = { limitHistory: history, counted: { lastApplication, annualCount } };
    const bermudaCtx = { customerId, productId, yearStart, proposedDate, ...opts };
    for (const limit of allLimits) {
      // A bermuda removal row is judged on the step's own history, never the product's own rows.
      const { limitHistory, counted } = isBermudaProgramRow(limit) ? await this.bermudaLimitInputs(database, limit, bermudaCtx) : own;
      const check = await this.evaluateLimit(limit, limitHistory, moaHistory, proposedDate, product, database, { customerId, yearStart, ...counted, ...opts });

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
  // What one bermuda removal limit row is judged on: the step's own history this year (read once
  // per check, kept on `ctx`), its length as the yearly count, and its newest row as the last
  // application. The interval spans the new year like every other interval: with no spray yet
  // this year it reads the latest earlier one (a late-December spray still holds an early-January one).
  async bermudaLimitInputs(database, limit, ctx) {
    if (!ctx.history) ctx.history = await this.propertyHistory(database, ctx);
    // A WRITE (ctx.wholeYear: a completion about to record the spray) is judged against the
    // nearest spray on either side, so a backdated completion cannot land inside 42 days of a
    // later recorded spray. A plan reads only what came before its date.
    if (ctx.wholeYear && limit.limit_type === 'min_interval_days') {
      return { limitHistory: ctx.history, counted: { annualCount: ctx.history.length, lastApplication: await this.propertyNearestApplication(database, ctx) } };
    }
    const needsPrior = !ctx.history.length && limit.limit_type === 'min_interval_days';
    const lastApplication = needsPrior ? await this.propertyLastApplication(database, ctx) : (ctx.history[0] || null);
    return { limitHistory: ctx.history, counted: { annualCount: ctx.history.length, lastApplication } };
  }

  // The bermuda removal spray nearest to the date judged, before or after it, or null.
  async propertyNearestApplication(database, ctx) {
    const query = (await this.bermudaHistoryQuery(database, ctx))();
    return (await query.select('pah.*')
      .orderByRaw('abs(pah.application_date - ?::date) asc', [etCalendarDayOf(ctx.proposedDate)]).first()) || null;
  }

  async propertyHistory(database, ctx) {
    return (await this.bermudaHistoryQuery(database, ctx))().where('pah.application_date', '>=', ctx.yearStart)
      .where('pah.application_date', '<=', `${String(ctx.yearStart).slice(0, 4)}-12-31`)
      .select('pah.*').orderBy('pah.application_date', 'desc');
  }

  // The latest bermuda removal spray on or before the date judged, whatever its calendar year (the
  // minimum interval spans the new year), or null.
  async propertyLastApplication(database, ctx) {
    return (await (await this.bermudaHistoryQuery(database, ctx))().select('pah.*').orderBy('pah.application_date', 'desc').first()) || null;
  }

  // A builder of the query for Recognition applications (the step's marker, for both products) of
  // the treated property. It resolves to a FUNCTION: a query builder returned from an async method
  // would run when awaited.
  async bermudaHistoryQuery(database, { customerId, productId, proposedDate, propertyId, excludeScheduledServiceId, wholeYear = false }) {
    const rateRow = await database('product_limits').where({ match_value: BERMUDA_PROGRAM, limit_type: 'annual_max_rate' }).first('product_id');
    return () => {
      const query = database('property_application_history as pah')
        .where({ 'pah.customer_id': customerId, 'pah.product_id': rateRow?.product_id || productId })
        .whereNull('pah.retracted_at');
      // A plan reads sprays on or before the date judged, as the active-ingredient cap does: a
      // plan rebuilt for April is not withheld by a June spray that had not happened yet. A
      // write (wholeYear) reads both sides of its date.
      if (!wholeYear) query.where('pah.application_date', '<=', etCalendarDayOf(proposedDate));
      scopeHistoryToTreatment(query, database, { propertyId, excludeScheduledServiceId }, 'pah');
      return query;
    };
  }

  async evaluateLimit(limit, history, moaHistory, proposedDate, product, database = db, ctx = {}) {
    // product_limits.limit_value is a pg decimal — node-pg returns it as a
    // STRING ('14.0000'); coerce once so `< minDays + 7` etc. stay numeric.
    const limitValue = limit.limit_value == null ? null : Number(limit.limit_value);
    switch (limit.limit_type) {
      case 'annual_max_apps': {
        const count = ctx.annualCount ?? history.length;
        const max = limitValue;
        if (count >= max) return { violated: true, message: `${product.name}: ${count}/${max} applications this year — LIMIT REACHED.`, current: count, max };
        if (count >= max - 1) return { approaching: true, message: `${product.name}: ${count}/${max} this year — this would be the LAST allowed.`, current: count, max };
        return { violated: false, current: count, max };
      }

      case 'min_interval_days': {
        const last = ctx.lastApplication || history[0];
        if (!last) return { violated: false };
        // pg `date` columns arrive as JS Date objects (no type parser is
        // configured) — normalize to YYYY-MM-DD before building the anchor.
        // Both operands are ET calendar days anchored at noon UTC so the
        // interval is whole days regardless of the proposed instant's clock.
        const lastApp = new Date(etCalendarDayOf(last.application_date) + 'T12:00:00Z');
        // proposedDate may itself be a hydrated pg DATE (admin-dispatch passes
        // svc.scheduled_date) — etCalendarDayOf keeps its literal calendar day.
        const proposedDay = new Date(etCalendarDayOf(proposedDate) + 'T12:00:00Z');
        // Whole days between the two, whichever came first (a write-time bermuda check may read a LATER spray).
        const daysSince = Math.floor(Math.abs(proposedDay - lastApp) / 86400000);
        const minDays = limitValue;
        if (daysSince < minDays) return { violated: true, message: `${product.name}: only ${daysSince} days since last app (min ${minDays}). Next allowed: ${new Date(lastApp.getTime() + minDays * 86400000).toLocaleDateString('en-US', { timeZone: 'America/New_York' })}.`, current: daysSince, max: minDays };
        if (daysSince < minDays + 7) return { approaching: true, message: `${product.name}: ${daysSince} days since last app (min ${minDays}). Just cleared.`, current: daysSince, max: minDays };
        return { violated: false, current: daysSince, max: minDays };
      }

      case 'annual_max_rate': {
        if (limit.match_type === AI_CAP) return this.evaluateActiveIngredientCap(limit, product, { ...ctx, proposedDate }, database);
        if (limit.match_type === V13_AMOUNT) return this.evaluateV13AmountCap(limit, product, { ...ctx, proposedDate }, database);
        const { totalApplied, note } = yearRateTotal(limit, history, ctx);
        const maxRate = limitValue;
        if (totalApplied >= maxRate * 0.95) {
          return { violated: true, message: `${product.name}: cumulative ${totalApplied.toFixed(3)} ${limit.limit_unit}${note} approaching/exceeding max ${maxRate}.`, current: totalApplied, max: maxRate };
        }
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
    // The treated property (the one frozen on the ledger row, a legacy row's visit property as the
    // fallback) and the visit being planned: the same scope every other per-lawn reader uses.
    scopeHistoryToTreatment(query, database, { propertyId: ctx.propertyId, excludeScheduledServiceId: ctx.excludeScheduledServiceId }, 'pah');
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

  // The program's dose of a product, by product id: the highest rate any staged v13 protocol row states for it (the plan's
  // own rows; Arena 0.147 oz). { ratePer1000: null } when no row states one: the caller counts the cap's fallback rate.
  async programDose(database, productId) {
    const row = await database('lawn_protocol_products as p')
      .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
      .join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
      .where({ 'p.product_id': productId, 'l.version': V13_VERSION })
      .where('p.rate_per_1000', '>', 0)
      .orderBy('p.rate_per_1000', 'desc')
      .first('p.rate_per_1000', 'p.rate_unit');
    return row ? { ratePer1000: Number(row.rate_per_1000), unit: row.rate_unit } : { ratePer1000: null, unit: null };
  }

  // The v13 yearly AMOUNT cap on one product (Arena: 0.294 oz per 1,000 sq ft, GATE_LAWN_V13): the lawn's
  // recorded applications of this product this year, each as a share of the cap (an unreadable one counts
  // at the cap row's fallback rate), plus the application being planned. Per 1,000 sq ft of the treated
  // area, as the shared active-ingredient cap reads it: a spot is its recorded rate, not scaled to its area.
  async evaluateV13AmountCap(limit, product, ctx, database = db) {
    const query = database('property_application_history as pah')
      .leftJoin('products_catalog as pc', 'pah.product_id', 'pc.id')
      .where('pah.customer_id', ctx.customerId)
      .where('pah.product_id', product.id)
      .where('pah.application_date', '>=', ctx.yearStart)
      .where('pah.application_date', '<=', etCalendarDayOf(ctx.proposedDate))
      .whereNull('pah.retracted_at')
      .select('pah.application_rate', 'pah.rate_unit', 'pah.quantity_applied', 'pah.quantity_unit', 'pah.area_treated_sqft',
        'pah.property_id', 'pah.service_record_id', 'pc.default_rate_per_1000', 'pc.rate_unit as catalog_rate_unit');
    scopeHistoryToTreatment(query, database, { propertyId: ctx.propertyId, excludeScheduledServiceId: ctx.excludeScheduledServiceId }, 'pah');
    const { share: used, estimated } = await this.lawnAmountShare(database, await query, limit, { propertyId: ctx.propertyId });
    const cap = Number(limit.limit_value);
    const amountUsed = Math.round(used * cap * 10000) / 10000;
    // The application being planned. A named dose is read in the cap's unit (`unit`, or `rateUnit` as the plan rows spell it). A
    // proposal (opts.proposal: the compliance route, the plan's selected products) whose dose is missing or unreadable counts the
    // program's own dose for the product, by product id, from ANY staged v13 window (Arena 0.147 oz even in October, a month
    // that has no Arena row), and failing that the fixed fallback rate: a proposal never reads as fitting when it does not.
    // A status read (the compliance page, a read after the ledger write) names no dose, is no proposal, and adds nothing.
    const capUnit = capUnitOf(limit.limit_unit);
    const readable = (dose) => {
      const size = dose ? rateInUnit(dose.ratePer1000, dose.unit ?? dose.rateUnit, capUnit) : null;
      return size > 0 ? size : null;
    };
    let dose = readable(ctx.proposed);
    if (dose == null && ctx.proposal) dose = readable(await this.programDose(database, product.id));
    const adds = dose != null ? dose / cap : ((ctx.proposed || ctx.proposal) ? Number(limit.fallback_rate) / cap : 0);
    const total = used + adds;
    const detail = estimated ? ` (${estimated} earlier application${estimated === 1 ? '' : 's'} sized at the standard rate)` : '';
    const label = `${product.name}: this year's applications on the lawn total ${pct(used)}% of the yearly label amount (${limit.limit_value} ${capUnitOf(limit.limit_unit)} per 1,000 sq ft)`;
    const withThis = adds ? `; this application brings it to ${pct(total)}%` : '';
    if (used >= 1 - 1e-9 || total > 1 + 1e-9) {
      return { violated: true, message: `${label}${withThis} — ${used >= 1 - 1e-9 ? 'LIMIT REACHED' : 'THIS APPLICATION WOULD EXCEED IT'}${detail}.`, current: pct(used), max: 100, amountUsed };
    }
    if (total >= AI_CAP_APPROACHING) return { approaching: true, message: `${label}${withThis}${detail}.`, current: pct(used), max: 100, amountUsed };
    return { violated: false, current: pct(used), max: 100, amountUsed };
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
  // The per-lawn yearly count of already-loaded history rows (see checkLimits).
  async annualCountFor(database, history, opts = {}) {
    if (opts.propertyId || history.length < 2) return history.length;
    return worstPropertyCount(await this.placeOnProperty(database, history));
  }

  // The rows with `treated_property_id`: the property frozen on the ledger row; a legacy row without one
  // falls back to its visit's property; null = it cannot be placed (counted at every property).
  async placeOnProperty(database, history) {
    const legacyRecordIds = [...new Set(history.filter((row) => !row.property_id).map((row) => row.service_record_id).filter(Boolean))];
    const placed = legacyRecordIds.length
      ? await database('service_records as sr_prop')
        .leftJoin('scheduled_services as ss_prop', 'sr_prop.scheduled_service_id', 'ss_prop.id')
        .whereIn('sr_prop.id', legacyRecordIds).select('sr_prop.id as record_id', 'ss_prop.property_id')
      : [];
    const propertyOf = new Map((placed || []).map((row) => [String(row.record_id), row.property_id]));
    return history.map((row) => ({
      ...row,
      treated_property_id: row.property_id || (row.service_record_id ? propertyOf.get(String(row.service_record_id)) || null : null),
    }));
  }

  // The v13 yearly amount of already-loaded history rows, as a share of the cap, per lawn: with a treated
  // property the rows are already that property's (summed); a caller with none (the compliance page, the
  // legacy check-limits route) is judged on the busiest property of the customer, never the sum across
  // properties. Rows that cannot be sized count at the cap row's fallback rate.
  async lawnAmountShare(database, rows, limit, { propertyId } = {}) {
    const sized = rows.map((row) => v13AmountShare(row, limit));
    const estimated = sized.filter((entry) => entry.estimated).length;
    if (propertyId || rows.length < 2) return { share: sized.reduce((sum, entry) => sum + entry.share, 0), estimated };
    const placed = await this.placeOnProperty(database, rows);
    return { share: worstPropertyTotal(placed.map((row, index) => ({ treated_property_id: row.treated_property_id, share: sized[index].share })), (entry) => entry.share), estimated };
  }

  // The closeout audit of one recorded application, whatever order the visits were recorded in
  // (a backdated closeout included). It judges the product-level hard_block count limits on the
  // service date and returns EVERY violated one:
  //   annual_max_apps  the other applications of the product in the whole calendar year of the date
  //                    (before AND after it) already fill the cap;
  //   min_interval_days the nearest application on EACH side of the date, in any calendar year, is
  //                    closer than the minimum.
  // Scoped to the treated property, the visit's own ledger rows left out, retracted rows ignored.
  async auditHardCountLimits(customerId, productId, serviceDate, database = db, opts = {}) {
    const product = await database('products_catalog').where({ id: productId }).first();
    if (!product) return [];
    const limits = (await applyV13CountCaps(database, product, await database('product_limits')
      .where({ product_id: productId, match_type: 'product' })
      .whereIn('limit_type', ['annual_max_apps', 'min_interval_days']), productId))
      // A bermuda removal row is the step's own limit (judged by the step's check, on the step's
      // history): the generic closeout audit never reads it, so Fusilade II used alone for bed or
      // border work is not reported against the step's 2 a year or 42 days.
      .filter((limit) => limit.severity === 'hard_block' && !isBermudaProgramRow(limit));
    if (!limits.length) return [];
    const day = etCalendarDayOf(serviceDate);
    const others = () => scopeHistoryToTreatment(database('property_application_history')
      .where({ customer_id: customerId, product_id: productId }).whereNull('retracted_at'), database, opts, 'property_application_history');
    const violations = [];
    for (const limit of limits) {
      const max = Number(limit.limit_value);
      let violation;
      if (limit.limit_type === 'annual_max_apps') violation = await this.auditAnnualCount(others, product, day, max);
      else if (limit.match_type === V13_AMOUNT) violation = await this.auditAmount(database, customerId, product, day, limit, opts);
      else violation = await this.auditInterval(others, product, day, max);
      if (violation) violations.push({ ...violation, limitId: limit.id, description: limit.description });
    }
    return violations;
  }

  async auditAnnualCount(others, product, day, max) {
    const year = day.slice(0, 4);
    const rows = await others().where('application_date', '>=', `${year}-01-01`).where('application_date', '<=', `${year}-12-31`).select('id');
    if (rows.length < max) return null;
    return { type: 'annual_max_apps', message: `${product.name}: ${rows.length}/${max} other applications in ${year} — LIMIT REACHED.`, current: rows.length, max };
  }

  // The yearly amount: every other application of the product in the calendar year of the date (before and
  // after it) plus this visit's own recorded ones must fit the cap. A visit with no ledger rows of its own
  // adds nothing (only the others filling the cap is flagged), as the count audit does.
  async auditAmount(database, customerId, product, day, limit, opts = {}) {
    const year = day.slice(0, 4);
    const yearRows = (query) => query.where({ 'pah.customer_id': customerId, 'pah.product_id': product.id }).whereNull('pah.retracted_at')
      .where('pah.application_date', '>=', `${year}-01-01`).where('pah.application_date', '<=', `${year}-12-31`)
      .select('pah.application_rate', 'pah.rate_unit', 'pah.quantity_applied', 'pah.quantity_unit', 'pah.area_treated_sqft', 'pah.property_id', 'pah.service_record_id',
        'pc.default_rate_per_1000', 'pc.rate_unit as catalog_rate_unit');
    const base = () => database('property_application_history as pah').leftJoin('products_catalog as pc', 'pah.product_id', 'pc.id');
    const others = await scopeHistoryToTreatment(yearRows(base()), database, opts, 'pah');
    const own = opts.excludeScheduledServiceId
      ? await scopeHistoryToTreatment(yearRows(base()), database, { propertyId: opts.propertyId }, 'pah')
        .whereIn('pah.service_record_id', database('service_records').where({ scheduled_service_id: opts.excludeScheduledServiceId }).select('id'))
      : [];
    // Per lawn: with no treated property the busiest property of the customer is judged (this visit's rows count where it was done).
    const { share: used } = await this.lawnAmountShare(database, others, limit, { propertyId: opts.propertyId });
    const { share: total } = await this.lawnAmountShare(database, [...others, ...own], limit, { propertyId: opts.propertyId });
    if (total <= 1 + 1e-9 && used < 1 - 1e-9) return null;
    return { type: 'annual_max_rate', message: `${product.name}: ${pct(total)}% of the yearly label amount in ${year} — LIMIT EXCEEDED.`, current: pct(total), max: 100 };
  }

  async auditInterval(others, product, day, min) {
    const before = await others().where('application_date', '<=', day).orderBy('application_date', 'desc').first('application_date');
    const after = await others().where('application_date', '>', day).orderBy('application_date', 'asc').first('application_date');
    const anchor = new Date(`${day}T12:00:00Z`);
    const gaps = [before, after].filter(Boolean)
      .map((row) => Math.abs(Math.round((anchor - new Date(`${etCalendarDayOf(row.application_date)}T12:00:00Z`)) / 86400000)));
    if (!gaps.length || Math.min(...gaps) >= min) return null;
    const nearest = Math.min(...gaps);
    return { type: 'min_interval_days', message: `${product.name}: only ${nearest} days from another application (min ${min}).`, current: nearest, max: min };
  }

  getYearStart(date) { return `${etCalendarDayOf(date).slice(0, 4)}-01-01`; }
}

module.exports = new ApplicationLimitChecker();
// What one bermuda removal row counts toward the label-rate cap (0 = nothing): the completion
// check asks it before the row is written (lawn-bermuda-removal.js bermudaAreaViolation).
module.exports.bermudaRowRate = bermudaRowRate;
