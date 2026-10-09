const db = require('../models/db');
const { etParts, etCalendarDayOf } = require('../utils/datetime-et');
const { convertInventoryQuantity } = require('./inventory-units');
const { applyV13CountCaps, v13CapEntryFor, v13CountCapFor, V13_COUNT_CAPS, V13_AMOUNT } = require('../config/lawn-v13-count-caps');
const V13_VERSION = '2026.10-v13';
const { worstPropertyCount, worstPropertyTotal } = require('../utils/property-counts');
const { resolveAddressCounty, SHARED_SERVICE_AREA_ZIPS } = require('../config/address-county');
const { SERVICE_AREA_COUNTY_ZIPS } = require('../config/county-zips');

// annual_max_rate rows with match_type 'active_ingredient' are one yearly cap on an
// active ingredient shared by every product that carries it (prodiamine: 65 WDG,
// Stonewall 4FL, the Stonewall granulars). Each product has its own row, whose
// limit_value is the label cap written in THAT product's rate unit per 1,000 sq ft
// (limit_unit 'lb/1000sf/year', 'fl oz/1000sf/year'), so the products add up as
// shares of one cap with no unit conversion between formulations.
const AI_CAP = 'active_ingredient';
const AI_CAP_APPROACHING = 0.75;

// A v13 cap entry (config/lawn-v13-count-caps.js) with `yearWindow: 'rolling365'` counts its yearly COUNT over the 365 days
// ending on the day judged (that day included: the day 364 days before it is the first), not over the calendar year. Count only:
// an entry that also declares a yearly AMOUNT would be judged by calendar year, so the module refuses it at load (see below).
// Celsius WG: the label says "per year (365 days)". Certainty: the label says "per year"; Waves counts 365 days too, the
// stricter reading. An entry without the key keeps the calendar year, byte for byte. The stored product_limits rows (a legacy
// Celsius annual_max_rate, the shared active-ingredient caps) are a separate mechanism and keep the calendar year.
const ROLLING_365 = 'rolling365';
const ROLLING_DAYS = 365;
const WINDOW_WORDS = {
  calendar: { when: 'this year' },
  rolling: { when: 'in the last 365 days' },
};
const dayNumber = (day) => Math.floor(Date.parse(`${day}T12:00:00Z`) / 86400000);
const shiftDay = (day, days) => new Date((dayNumber(day) + days) * 86400000 + 43200000).toISOString().slice(0, 10);

// Every distinct set of rows a 365-day window holds, over the windows that contain `day` (the ones starting from 364 days before it
// up to the day itself). `items` carry `day` (YYYY-MM-DD). A recorded application is judged against the fullest of these sets.
function windowsAround(items, day) {
  const sets = new Map();
  const last = dayNumber(day);
  for (let start = last - ROLLING_DAYS + 1; start <= last; start += 1) {
    const inside = items.filter((item) => item.no >= start && item.no < start + ROLLING_DAYS);
    sets.set(inside.map((item) => item.index).join(','), inside);
  }
  return [...sets.values()];
}
const dated = (rows) => rows.map((row, index) => ({ row, index, no: dayNumber(etCalendarDayOf(row.application_date)) }));

// The counties of each ZIP the service-area map lists under more than one (34228 and 34243: Manatee and Sarasota; 34223 and 34224:
// Sarasota and Charlotte), as product_limits jurisdictions, read from the map itself and never assumed. Sarasota first.
const COUNTY_ORDER = ['Sarasota', 'Manatee', 'Charlotte'];
const SHARED_ZIP_COUNTIES = new Map([...SHARED_SERVICE_AREA_ZIPS].map((zip) => [zip, COUNTY_ORDER
  .filter((county) => SERVICE_AREA_COUNTY_ZIPS[county]?.includes(zip)).map((county) => `${county.toLowerCase()}_county`)]));

// A rolling entry is count-only. Nothing judges a rolling yearly AMOUNT (the amount reader counts the calendar year), so an entry that
// declares both would be silently held to the wrong window: refuse it when the module loads.
function assertRollingIsCountOnly(entries) {
  for (const entry of entries) {
    if (entry.yearWindow && entry.annualAmount) {
      throw new Error(`lawn-v13-count-caps: "${entry.name}" declares yearWindow "${entry.yearWindow}" and annualAmount; a rolling window is supported for the yearly count only. Remove one, or build the rolling amount reader first.`);
    }
  }
}
assertRollingIsCountOnly(V13_COUNT_CAPS);

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

// One earlier application as a share of a v13 yearly amount cap (the synthetic row of lawn-v13-count-caps):
// the ledger's own reading only (the recorded rate, else the quantity over the treated area), and when the
// ledger cannot size it the row's FIXED fallback rate (Arena: the old 0.29 oz, the whole year) - never the
// catalog default, which an admin can change (to the new 0.147) and so halve what an unreadable full-rate pass counts.
function v13AmountShare(row, limit) {
  const sized = capShare({ ...row, default_rate_per_1000: null, limit_value: limit.limit_value, limit_unit: limit.limit_unit });
  if (sized) return sized;
  return { share: Number(limit.fallback_rate) / Number(limit.limit_value), estimated: true };
}

// What could not be counted exactly, for the end of a cap message.
function sizingNote(unsized, estimated) {
  const notes = [
    unsized ? `${unsized} earlier application${unsized === 1 ? '' : 's'} could not be sized and ${unsized === 1 ? 'was' : 'were'} not counted` : null,
    estimated ? `${estimated} sized at the product's standard rate` : null,
  ].filter(Boolean);
  return notes.length ? ` (${notes.join('; ')})` : '';
}

// Narrows a property_application_history query to the treated property and leaves one
// visit's own ledger rows out. `table` is the history table or its alias in the query.
// A row whose property is unknown (no visit, or a visit with no property) cannot be proven
// elsewhere, so it still counts. No option, no change.
// GATE_LAWN_TROUBLE_AREAS: `place` narrows the history to one place of the lawn. A row with no place on
// record (every row before the gate, and every whole-lawn row) counts at EVERY place, so it stays in.
// Ignored unless the gate is live, so a caller cannot change a gate-off read by passing one.
function scopeHistoryToTreatment(query, database, { propertyId, excludeScheduledServiceId, place } = {}, table) {
  if (place && require('../config/feature-gates').lawnTroubleAreasLive()) {
    query.where(function placedHereOrUnplacedInLawn() {
      this.whereNull(`${table}.treated_place`).orWhere(`${table}.treated_place`, place);
    });
  }
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
  // opts.proposedRow (GATE_LAWN_TROUBLE_AREAS, with opts.proposal) is the row being completed, as a ledger row would hold it:
  // { application_rate, rate_unit, quantity_applied, quantity_unit, area_treated_sqft }. A v13 yearly amount cap then counts that
  // row exactly as the closeout audit will count it once recorded (see evaluateV13AmountCap).
  // opts.place (GATE_LAWN_TROUBLE_AREAS; a place id of lawn-trouble-areas.js) judges the product's own history, its yearly
  // count and its minimum interval (and the v13 yearly amount) at that PLACE of the lawn: the rows placed elsewhere on the
  // lawn are left out, a row with no place on record still counts. The shared active-ingredient cap, the MOA rotation and
  // every limit that is not about this product's own applications stay lawn-wide.
  async checkLimits(customerId, productId, proposedDate = new Date(), database = db, opts = {}) {
    const product = await database('products_catalog').where({ id: productId }).first();
    if (!product) return { allowed: true, warnings: [], blocks: [] };

    const results = { allowed: true, warnings: [], blocks: [] };
    const customer = await database('customers').where({ id: customerId }).first();
    const counties = this.getCounties(customer);
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
    // The window the product's own yearly count and v13 yearly amount cover (the calendar year, or a rolling 365 days).
    const window = await this.countWindow(database, product, proposedDate);
    const countHistory = window.rolling ? await priorApplications().where('application_date', '>=', window.start) : history;

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
          this.whereNull('jurisdiction').orWhereIn('jurisdiction', [...counties, 'all']);
        }) : [];

    const allLimits = [...productLimits, ...moaLimits, ...nitrogenLimits];
    // A minimum interval spans the new year (a December application and a February one are 50
    // days apart): it reads the latest earlier application whatever its calendar year. This
    // year's newest row is that application when there is one; only an empty year looks back.
    const needsInterval = allLimits.some((limit) => limit.limit_type === 'min_interval_days');
    const lastApplication = history[0] || (needsInterval ? await priorApplications().first() : null);

    // A yearly count is per lawn. With a treated property the history is already that property's; a
    // caller with none (the compliance page, the legacy check-limits route) is judged on the busiest
    // property of the customer, never on the sum across properties.
    const needsAnnual = allLimits.some((limit) => limit.limit_type === 'annual_max_apps');
    const annualCount = needsAnnual ? await this.annualCountFor(database, countHistory, opts) : history.length;

    for (const limit of allLimits) {
      const check = await this.evaluateLimit(limit, history, moaHistory, proposedDate, product, database, { customerId, yearStart, window, lastApplication, annualCount, ...opts });

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

  async evaluateLimit(limit, history, moaHistory, proposedDate, product, database = db, ctx = {}) {
    // product_limits.limit_value is a pg decimal — node-pg returns it as a
    // STRING ('14.0000'); coerce once so `< minDays + 7` etc. stay numeric.
    const limitValue = limit.limit_value == null ? null : Number(limit.limit_value);
    switch (limit.limit_type) {
      case 'annual_max_apps': return this.evaluateAnnualCount(limitValue, history, product, ctx);

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
        const daysSince = Math.floor((proposedDay - lastApp) / 86400000);
        const minDays = limitValue;
        if (daysSince < minDays) return { violated: true, message: `${product.name}: only ${daysSince} days since last app (min ${minDays}). Next allowed: ${new Date(lastApp.getTime() + minDays * 86400000).toLocaleDateString('en-US', { timeZone: 'America/New_York' })}.`, current: daysSince, max: minDays };
        if (daysSince < minDays + 7) return { approaching: true, message: `${product.name}: ${daysSince} days since last app (min ${minDays}). Just cleared.`, current: daysSince, max: minDays };
        return { violated: false, current: daysSince, max: minDays };
      }

      case 'annual_max_rate': {
        if (limit.match_type === AI_CAP) return this.evaluateActiveIngredientCap(limit, product, { ...ctx, proposedDate }, database);
        if (limit.match_type === V13_AMOUNT) return this.evaluateV13AmountCap(limit, product, { ...ctx, proposedDate }, database);
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

  // The yearly count of a product's own applications (calendar year, or the rolling 365 days of its v13 cap entry; see windowOf).
  evaluateAnnualCount(max, history, product, ctx) {
    const count = ctx.annualCount ?? history.length;
    const { when } = this.windowOf(ctx);
    if (count >= max) return { violated: true, message: `${product.name}: ${count}/${max} applications ${when} — LIMIT REACHED.`, current: count, max };
    if (count >= max - 1) return { approaching: true, message: `${product.name}: ${count}/${max} ${when} — this would be the LAST allowed.`, current: count, max };
    return { violated: false, current: count, max };
  }

  // The window a product's yearly count and amount cover, for a judged day: { start, rolling, when, of }. The calendar year of the day,
  // unless the product's v13 cap entry says `yearWindow: 'rolling365'` (see ROLLING_365). Gate off: the calendar year.
  async countWindow(database, product, day) {
    const entry = await v13CapEntryFor(database, product.id, product.name);
    return this.windowFor(etCalendarDayOf(day), entry && entry.yearWindow);
  }

  // The same window for a reader that has a product NAME and no product row (the portal's Celsius count): the cap entry of that name
  // while GATE_LAWN_V13 is live, else the calendar year.
  windowForName(name, day) {
    const entry = require('../config/feature-gates').lawnV13Live?.() === true ? v13CountCapFor(name) : null;
    return this.windowFor(day, entry && entry.yearWindow);
  }

  windowFor(day, yearWindow) {
    const rolling = yearWindow === ROLLING_365;
    return { rolling, start: rolling ? shiftDay(day, 1 - ROLLING_DAYS) : `${day.slice(0, 4)}-01-01`, ...WINDOW_WORDS[rolling ? 'rolling' : 'calendar'] };
  }

  // A caller's window (ctx.window), else the calendar year.
  windowOf(ctx) {
    return ctx.window || WINDOW_WORDS.calendar;
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
    scopeHistoryToTreatment(query, database, { propertyId: ctx.propertyId, excludeScheduledServiceId: ctx.excludeScheduledServiceId, place: ctx.place }, 'pah');
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
    // GATE_LAWN_TROUBLE_AREAS: the /complete preflight names the row it is about to record (`proposedRow`: the rate, the typed quantity
    // and the row's own spot area, as the ledger will hold them). It is sized by v13AmountShare, the very function that sizes a recorded
    // ledger row for the closeout audit (the recorded rate when readable, else the quantity over the treated area, else the cap row's
    // FIXED fallback rate), so the preflight and the audit can never disagree on a row: a quantity with no spot area counts the same
    // fallback in both. A proposal with no row (the plan's selected products, the sheet's reads, the compliance route) has no dose
    // entered yet, so it counts the program's dose, then the same fixed fallback.
    const rowShare = ctx.proposedRow ? v13AmountShare(ctx.proposedRow, limit) : null;
    let dose = readable(ctx.proposed);
    if (dose == null && ctx.proposal && !rowShare) dose = readable(await this.programDose(database, product.id));
    const adds = rowShare ? rowShare.share : (dose != null ? dose / cap : ((ctx.proposed || ctx.proposal) ? Number(limit.fallback_rate) / cap : 0));
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
    const today = etCalendarDayOf(new Date());

    // Read from the EARLIER of January 1 and the rolling window's start (the rolling start is before January 1 for most of the year, but
    // on 30 and 31 December of a leap year it is 1 or 2 January), then judge each product over its own window: the calendar year, or
    // the 365 days of a rolling product (countWindow). The totals and the nitrogen budget below stay on the calendar year.
    const rollingStart = this.windowFor(today, ROLLING_365).start;
    const loaded = await db('property_application_history')
      .where({ customer_id: customerId }).where('application_date', '>=', rollingStart < yearStart ? rollingStart : yearStart)
      .whereNull('property_application_history.retracted_at')
      .leftJoin('products_catalog', 'property_application_history.product_id', 'products_catalog.id')
      .select('property_application_history.*', 'products_catalog.name as product_name')
      .orderBy('application_date', 'desc');
    const applications = loaded.filter((app) => etCalendarDayOf(app.application_date) >= yearStart);

    const byProduct = {};
    for (const app of loaded) {
      if (!byProduct[app.product_id]) byProduct[app.product_id] = { name: app.product_name, apps: [] };
      byProduct[app.product_id].apps.push(app);
    }

    const status = { products: [], warnings: 0, blocks: 0, county, totalApplications: applications.length };
    for (const [productId, data] of Object.entries(byProduct)) {
      const { start } = await this.countWindow(db, { id: productId, name: data.name }, today);
      const inWindow = data.apps.filter((app) => etCalendarDayOf(app.application_date) >= start);
      if (!inWindow.length) continue;
      const check = await this.checkLimits(customerId, productId);
      status.products.push({ productId, productName: data.name, applicationsThisYear: inWindow.length, lastApplied: inWindow[0]?.application_date, limits: check });
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

  // The county a customer's nitrogen rules come from, as the product_limits jurisdiction string; 'all' when none can be told.
  getCounty(customer) {
    return this.getCounties(customer)[0] || 'all';
  }

  // Every county whose nitrogen rules apply to a customer (a straddling place lists both, so the stricter of the two applies). The ZIP
  // decides whenever it is one the repo knows, because it is the more precise datum; the city name is the fallback when it is not:
  //  1. a ZIP the service-area map lists under two counties: exactly those two, read from the map (34228 and 34243: Sarasota and
  //     Manatee; 34223 and 34224: Sarasota and Charlotte);
  //  2. a ZIP in one county (config/address-county.js, the table the watering rules use): that county, whatever the city says;
  //  3. no usable ZIP: the eleven cities this function always mapped, Longboat Key (Manatee and Sarasota), then the whole-county
  //     cities of the repo table (Punta Gorda and Port Charlotte: Charlotte; Anna Maria, Holmes Beach, Bradenton Beach, Myakka City:
  //     Manatee; Siesta Key: Sarasota);
  //  4. nothing found: [] (getCounty answers 'all', no county rule applies).
  getCounties(customer) {
    if (!customer) return [];
    const zip = String(customer.zip || '').trim().slice(0, 5);
    const byZip = SHARED_ZIP_COUNTIES.get(zip) || [resolveAddressCounty({ zip })].filter(Boolean).map((county) => `${county.toLowerCase()}_county`);
    return byZip.length ? byZip : this.countiesOfCity(String(customer.city || '').trim().toLowerCase());
  }

  countiesOfCity(city) {
    if (['bradenton', 'lakewood ranch', 'parrish', 'palmetto', 'ellenton'].includes(city)) return ['manatee_county'];
    if (['sarasota', 'venice', 'nokomis', 'osprey', 'north port', 'englewood'].includes(city)) return ['sarasota_county'];
    if (city === 'longboat key') return ['sarasota_county', 'manatee_county'];
    const county = resolveAddressCounty({ city });
    return county ? [`${county.toLowerCase()}_county`] : [];
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
      .filter((limit) => limit.severity === 'hard_block');
    if (!limits.length) return [];
    const day = etCalendarDayOf(serviceDate);
    const others = () => scopeHistoryToTreatment(database('property_application_history')
      .where({ customer_id: customerId, product_id: productId }).whereNull('retracted_at'), database, opts, 'property_application_history');
    const window = await this.countWindow(database, product, day);
    const violations = [];
    for (const limit of limits) {
      const max = Number(limit.limit_value);
      let violation;
      if (limit.limit_type === 'annual_max_apps') violation = await this.auditAnnualCount(others, product, day, max, window, await this.ownApplicationsBeyondFirst(database, customerId, productId, opts));
      else if (limit.match_type === V13_AMOUNT) violation = await this.auditAmount(database, customerId, product, day, limit, opts);
      else violation = await this.auditInterval(others, product, day, max);
      if (violation) violations.push({ ...violation, limitId: limit.id, description: limit.description });
    }
    return violations;
  }

  // The other applications of the product on the visit being audited, beyond the first: a visit that recorded the product twice
  // (a Tree & Shrub host row and an area add-on row of the same product) made two applications, and the audit judges the
  // visit's FIRST as the one the others are compared with. 0 for a visit with one row, and when no visit is named.
  // Keyed on the DATA, never on the area add-on sale gate: a visit booked while the gate was on is completed and audited
  // after it is turned off, and its second application must still count. A caller that already knows the visit has no add-on
  // row says so (`addOnRows: false`) and the audit reads nothing extra.
  async ownApplicationsBeyondFirst(database, customerId, productId, opts = {}) {
    if (!opts.excludeScheduledServiceId || opts.addOnRows === false) return 0;
    const row = await database('property_application_history')
      .where({ customer_id: customerId, product_id: productId }).whereNull('retracted_at')
      .whereIn('service_record_id', database('service_records').where({ scheduled_service_id: opts.excludeScheduledServiceId }).select('id'))
      .count('* as n').first();
    return Math.max(0, Number(row && row.n) - 1) || 0;
  }

  // A rolling-365 product (see ROLLING_365): the recorded application is flagged when ANY 365-day window that contains its day already
  // holds `max` other applications (so this one would be the max + 1th inside that window). Windows reach 364 days either side.
  // `ownBeyondFirst`: this visit's own applications of the product beyond its first (see ownApplicationsBeyondFirst).
  async auditRollingCount(others, product, day, max, ownBeyondFirst = 0) {
    const rows = await others().where('application_date', '>=', shiftDay(day, 1 - ROLLING_DAYS)).where('application_date', '<=', shiftDay(day, ROLLING_DAYS - 1)).select('id', 'application_date');
    const fullest = Math.max(0, ...windowsAround(dated(rows), day).map((set) => set.length)) + ownBeyondFirst;
    if (fullest < max) return null;
    return { type: 'annual_max_apps', message: `${product.name}: ${fullest}/${max} other applications within 365 days of ${day} — LIMIT REACHED.`, current: fullest, max };
  }

  async auditAnnualCount(others, product, day, max, window = this.windowFor(day, null), ownBeyondFirst = 0) {
    if (window.rolling) return this.auditRollingCount(others, product, day, max, ownBeyondFirst);
    const year = day.slice(0, 4);
    const rows = await others().where('application_date', '>=', `${year}-01-01`).where('application_date', '<=', `${year}-12-31`).select('id');
    const used = rows.length + ownBeyondFirst;
    if (used < max) return null;
    return { type: 'annual_max_apps', message: `${product.name}: ${used}/${max} other applications in ${year} — LIMIT REACHED.`, current: used, max };
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
      ? await scopeHistoryToTreatment(yearRows(base()), database, { propertyId: opts.propertyId, place: opts.place }, 'pah')
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

  // The treated-property scope of a history query, for readers outside this class (the area add-on yearly limits
  // count the same rows the closeout audit counts). See scopeHistoryToTreatment.
  scopeHistoryToTreatment(query, database, opts, table) { return scopeHistoryToTreatment(query, database, opts, table); }

  getYearStart(date) { return `${etCalendarDayOf(date).slice(0, 4)}-01-01`; }
}

module.exports = new ApplicationLimitChecker();
module.exports.assertRollingIsCountOnly = assertRollingIsCountOnly;
