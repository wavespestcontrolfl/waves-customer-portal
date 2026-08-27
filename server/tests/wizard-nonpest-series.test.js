// Non-pest wizard series seeding (owner GO 2026-08-26): the QUOTE is the
// cadence authority. resolveWizardSeriesPlan is pure — real unit coverage —
// plus source contracts pinning the booking route's all-or-nothing wiring.
const fs = require('fs');
const path = require('path');
const { resolveWizardSeriesPlan, derivePerApplicationAmount, wizardPlanServiceKey } = require('../services/booking-pay-at-visit');

const booking = fs.readFileSync(path.join(__dirname, '..', 'routes', 'booking.js'), 'utf8');

// Minimal estimate shape the converter's extractor understands: engineResult
// lineItems with a priced recurring mosquito line.
function mosquitoEstimate({ visits = 12, frequency, monthly = 60, annual = 720, perVisit = 60 } = {}) {
  return {
    id: 'est-1',
    annual_total: annual,
    monthly_total: monthly,
    estimate_data: {
      engineResult: {
        lineItems: [{
          service: 'mosquito',
          name: 'WaveGuard Mosquito',
          monthly,
          annual,
          perVisit,
          visits,
          ...(frequency !== undefined ? { frequency } : {}),
        }],
      },
    },
  };
}

describe('resolveWizardSeriesPlan', () => {
  test('monthly-12 mosquito quote resolves to a monthly 12-visit plan', () => {
    const plan = resolveWizardSeriesPlan(mosquitoEstimate({ visits: 12 }), 'mosquito');
    expect(plan).toEqual({ pattern: 'monthly', visits: 12 });
  });

  test('the booked service family must match the quoted line', () => {
    expect(resolveWizardSeriesPlan(mosquitoEstimate(), 'lawn_care')).toBeNull();
    expect(resolveWizardSeriesPlan(mosquitoEstimate(), null)).toBeNull();
  });

  test('a 9-visit mosquito line maps to the seasonal program by the engine tier table', () => {
    expect(resolveWizardSeriesPlan(mosquitoEstimate({ visits: 9 }), 'mosquito'))
      .toEqual({ pattern: 'seasonal_feb_oct', visits: 9 });
  });

  test('an off-tier mosquito visit count fails closed', () => {
    expect(resolveWizardSeriesPlan(mosquitoEstimate({ visits: 10 }), 'mosquito')).toBeNull();
  });

  test('an explicit seasonal cadence resolves at 9 visits', () => {
    const plan = resolveWizardSeriesPlan(
      mosquitoEstimate({ visits: 9, frequency: 'seasonal_feb_oct' }),
      'mosquito',
    );
    expect(plan).toEqual({ pattern: 'seasonal_feb_oct', visits: 9 });
  });

  test('the engine tier table outranks the persisted label for mosquito (seasonal9 rows carry every_6_weeks)', () => {
    expect(resolveWizardSeriesPlan(
      mosquitoEstimate({ visits: 9, frequency: 'every_6_weeks' }),
      'mosquito',
    )).toEqual({ pattern: 'seasonal_feb_oct', visits: 9 });
    expect(resolveWizardSeriesPlan(
      mosquitoEstimate({ visits: 12, frequency: 'quarterly' }),
      'mosquito',
    )).toEqual({ pattern: 'monthly', visits: 12 });
  });

  test('pricing divides the quoted annual across the plan visits (monthly-12)', () => {
    expect(derivePerApplicationAmount(mosquitoEstimate({ annual: 720 }), 12)).toBe(60);
  });
});

// Palm-only quotes ride the tree_shrub funnel service for availability while
// quoting Palm Injections (public-quote's bookingServiceId mapping) — the
// plan family must follow the trusted estimate's own line (codex #3504 r2).
// Production palm shape (codex #3504 r3): the palm pricer emits cadence ONLY
// as appsPerYear (+ perVisit, no name/visits/frequency) — the fixture must
// not invent `visits` or it masks exactly the alias gap the resolver had.
function palmEstimate({ appsPerYear = 2, monthly = 50, annual = 600 } = {}) {
  return {
    id: 'est-palm-1',
    annual_total: annual,
    monthly_total: monthly,
    estimate_data: {
      engineResult: {
        lineItems: [{
          service: 'palm_injection',
          monthly,
          annual,
          perVisit: annual / appsPerYear,
          appsPerYear,
        }],
      },
    },
  };
}

describe('wizardPlanServiceKey (palm identity through the tree_shrub funnel)', () => {
  test('a palm-only quote signed as tree_shrub binds the plan to palm_injection', () => {
    expect(wizardPlanServiceKey(palmEstimate(), 'tree_shrub')).toBe('palm_injection');
  });

  test('a real tree/shrub quote keeps the signed tree_shrub key', () => {
    const treeEstimate = {
      id: 'est-ts-1',
      annual_total: 900,
      monthly_total: 75,
      estimate_data: {
        engineResult: {
          lineItems: [{ service: 'tree_shrub', name: 'Tree & Shrub', monthly: 75, annual: 900, perVisit: 100, visits: 9 }],
        },
      },
    };
    expect(wizardPlanServiceKey(treeEstimate, 'tree_shrub')).toBe('tree_shrub');
  });

  test('non-tree funnel keys pass through untouched', () => {
    expect(wizardPlanServiceKey(palmEstimate(), 'mosquito')).toBe('mosquito');
  });

  test('the palm plan then resolves at the quoted semiannual cadence', () => {
    expect(resolveWizardSeriesPlan(palmEstimate(), wizardPlanServiceKey(palmEstimate(), 'tree_shrub')))
      .toEqual({ pattern: 'semiannual', visits: 2 });
    // The signed key alone still refuses — the identity preservation is
    // what makes palm reachable at all.
    expect(resolveWizardSeriesPlan(palmEstimate(), 'tree_shrub')).toBeNull();
  });

  test('a fractional palm cadence (fungal 0.5/yr) fails closed', () => {
    expect(resolveWizardSeriesPlan(
      palmEstimate({ appsPerYear: 0.5, annual: 100, monthly: 100 / 12 }),
      wizardPlanServiceKey(palmEstimate({ appsPerYear: 0.5 }), 'tree_shrub'),
    )).toBeNull();
  });

  test('ONLY the two-visit semiannual palm program activates — annual (1/yr) stays one-time lane', () => {
    // codex #3504 r5: conversion deliberately keeps 1-application palm
    // work out of the recurring lane; activating it would stamp the
    // semiannual catalog identity onto a program that is not it.
    const annualPalm = palmEstimate({ appsPerYear: 1, annual: 300, monthly: 25 });
    expect(resolveWizardSeriesPlan(annualPalm, wizardPlanServiceKey(annualPalm, 'tree_shrub'))).toBeNull();
  });

  test('a populated-but-invalid count alias fails the whole row closed (shared converter validation)', () => {
    // codex #3504 r5: { visitsPerYear: 6, visits: 0 } is malformed data,
    // not an absent count — the converter's visitCountFieldsInvalid gate
    // rejects it, and this resolver must match that contract.
    const est = {
      id: 'est-bad-1',
      annual_total: 720,
      monthly_total: 60,
      estimate_data: {
        engineResult: {
          lineItems: [{ service: 'mosquito', name: 'WaveGuard Mosquito', monthly: 60, annual: 720, perVisit: 60, visitsPerYear: 12, visits: 0 }],
        },
      },
    };
    expect(resolveWizardSeriesPlan(est, 'mosquito')).toBeNull();
  });

  test('the wizard mirror persists appsPerYear (the palm line’s only cadence field)', () => {
    const publicQuote = fs.readFileSync(path.join(__dirname, '..', 'routes', 'public-quote.js'), 'utf8');
    expect(publicQuote).toMatch(/appsPerYear: item\.appsPerYear \?\? null,/);
  });
});

// Termite/rodent bait are deliberately OUTSIDE the wizard-seedable families
// (codex #3504 r5): activating them needs converter accept machinery this
// route must not re-implement (termite program agreement, station
// install/rental riders, catalog 180-min durations). They fail closed to
// today's single-visit office-converted behavior.
describe('seedable-family allowlist (termite/rodent excluded)', () => {
  const termiteEstimate = () => ({
    id: 'est-tb-1',
    annual_total: 420,
    monthly_total: 35,
    estimate_data: {
      engineResult: {
        lineItems: [{
          service: 'termite_bait',
          monthly: 35,
          annual: 420,
          perApp: 105,
          visitsPerYear: 4,
        }],
      },
    },
  });

  test('a termite-bait quote resolves NO wizard plan — office converts through the accept path', () => {
    expect(resolveWizardSeriesPlan(termiteEstimate(), 'termite_bait')).toBeNull();
  });

  test('rodent_bait is not seedable either', () => {
    const rodent = {
      id: 'est-rb-1',
      annual_total: 360,
      monthly_total: 30,
      estimate_data: {
        engineResult: {
          lineItems: [{ service: 'rodent_bait', monthly: 30, annual: 360, perApp: 60, visitsPerYear: 6 }],
        },
      },
    };
    expect(resolveWizardSeriesPlan(rodent, 'rodent_bait')).toBeNull();
  });

  test('the allowlist is exactly the four converter-independent families', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'booking-pay-at-visit.js'), 'utf8');
    expect(src).toMatch(/WIZARD_SEEDABLE_FAMILIES = new Set\(\['mosquito', 'lawn_care', 'tree_shrub', 'palm_injection'\]\)/);
  });
});

describe('booking route wiring (source contracts)', () => {
  test('the pricing divisor comes from the plan only under the trusted-handoff bind', () => {
    expect(booking).toMatch(/if \(!bookingVisits && pricingTrusted[\s\S]{0,1500}resolveWizardSeriesPlan\(pricingEstimate, wizardPlanKey\)/);
    expect(booking).toMatch(/bookedServiceKey !== 'pest_control'/);
  });

  test('palm identity is preserved from the trusted estimate and persisted on the parent', () => {
    expect(booking).toMatch(/wizardPlanServiceKey\(pricingEstimate, bookedServiceKey\)/);
    expect(booking).toMatch(/wizardPlanKey === 'palm_injection'[\s\S]{0,600}resolvedServiceType = 'Palm Injections';/);
  });

  test('a duplicate confirmation reads a completed activation as success, never as drift', () => {
    // The under-lock is_recurring re-check must run BEFORE the locked-draft
    // drift comparison, or the loser strips the winner's activated parent.
    expect(booking).toMatch(/lockedParent && lockedParent\.is_recurring[\s\S]{0,80}alreadyActivated: true/);
    const recheckAt = booking.indexOf('alreadyActivated: true');
    const driftAt = booking.indexOf('freshPlan.pattern !== wizardSeriesPlan.pattern');
    expect(recheckAt).toBeGreaterThan(0);
    expect(driftAt).toBeGreaterThan(recheckAt);
  });

  test('series, price, and fee are all-or-nothing: seeding requires the priced plan', () => {
    expect(booking).toMatch(/wizardSeriesPlan && paymentPref === 'pay_at_visit'/);
    // The seeding transaction guards duplicates and stamps atomically.
    expect(booking).toMatch(/pattern: wizardSeriesPlan\.pattern,\s*\n\s*plannedCount: wizardSeriesPlan\.visits,/);
    expect(booking).toMatch(/wizard-series seeding failed/);
  });

  test('unplanned bookings keep the waiver-only disposition (stamp stays off)', () => {
    expect(booking).toMatch(/\} else if \(!shouldSeedQuarterlyPestFollowUps && setupFeeHandoffEligible && !isOneTimeEstimateBooking\) \{/);
  });

  test('seasonal plans refuse winter (Nov-Jan) parent starts', () => {
    expect(booking).toMatch(/startMonth >= 2 && startMonth <= 10/);
  });

  test('the plan and price re-resolve against the LOCKED draft before seeding', () => {
    expect(booking).toMatch(/freshPlan\.pattern !== wizardSeriesPlan\.pattern/);
    expect(booking).toMatch(/freshPriced\.followUpAmount !== followUpVisitPrice/);
    expect(booking).toMatch(/return \{ stale: true \};/);
  });

  test('replay activation keys on the live-draft marker (annual plans seed no children; insert-time correlation is not activation)', () => {
    expect(booking).toMatch(/draftStillLive\s*\n\s*&& !hasChildren/);
    expect(booking).toMatch(/whereNull\('archived_at'\)/);
  });

  test('replay activation binds to THIS quote’s parent (estimate id + service family), never a rival quote’s row', () => {
    // codex #3504 r3: the replay lookup matches customer+date+start only —
    // a second live quote at the same slot must not activate its plan on
    // the other quote's parent.
    expect(booking).toMatch(/String\(replayParent\.source_estimate_id\) === String\(pricing_estimate_id\)/);
    expect(booking).toMatch(/serviceKeyFor\(\{ service_type: replayParent\.service_type \}\)\s*\n\s*=== RecurringAppointmentSeeder\.serviceKeyFor\(\{ service_type: resolvedServiceType \}\)/);
    expect(booking).toMatch(/replayParentIsOwn\s*\n\s*&& replayParent\.payment_method_preference === 'pay_at_visit'/);
  });

  test('a drifted plan strips the parent pricing atomically with the skip', () => {
    expect(booking).toMatch(/estimated_price: null,\s*\n\s*payment_method_preference: null,\s*\n\s*create_invoice_on_complete: false,/);
  });

  test('seeded occurrences run the SHARED tech-blind occupancy guard', () => {
    // codex #3504 r2 P1: a custom tech-scoped predicate missed conflicts
    // with a different technician's visit — the repository backstop is
    // findConflictingVisits (services/scheduling/occupancy.js).
    expect(booking).toMatch(/require\('\.\.\/services\/scheduling\/occupancy'\)/);
    expect(booking).toMatch(/findConflictingVisits\(\{\s*\n\s*db: trx,/);
    expect(booking).toMatch(/office to place/);
  });

  test('activation takes rung-1 occupancy locks BEFORE the comms/row locks, from the pre-computed plan', () => {
    // codex #3504 r3 hook P1: date locks after comms/row locks violate the
    // scheduling/occupancy.js ordering contract and can deadlock with
    // normal scheduling writers.
    expect(booking).toMatch(/planFollowUpSeedDates\(trx, seriesParentRow, \{\s*\n\s*pattern: wizardSeriesPlan\.pattern,/);
    expect(booking).toMatch(/acquireOccupancyLocks\(trx, lockedSeedDates\)/);
    const activationAt = booking.indexOf('const activateWizardSeries = async');
    const rung1At = booking.indexOf('await acquireOccupancyLocks(trx, lockedSeedDates)');
    const commsAt = booking.indexOf('await lockCustomerComms(trx, custId);', activationAt);
    expect(activationAt).toBeGreaterThan(0);
    expect(rung1At).toBeGreaterThan(activationAt);
    expect(commsAt).toBeGreaterThan(rung1At);
    // A seeded date outside the pre-locked plan aborts rather than locking
    // out of order.
    expect(booking).toMatch(/!lockedSeedDateSet\.has\(d\)/);
    expect(booking).toMatch(/fell outside the pre-locked plan/);
    expect(typeof require('../services/recurring-appointment-seeder').planFollowUpSeedDates).toBe('function');
  });

  test('the failure-cleanup strip re-checks is_recurring under the comms lock (never strips a rival activation)', () => {
    // codex #3504 r3 hook P0: after this attempt rolls back, a waiting
    // replay can activate the same parent — an unconditional strip would
    // race it and underbill the series.
    expect(booking).toMatch(/wizard-series seeding failed[\s\S]{0,1800}lockCustomerComms\(trx, custId\);[\s\S]{0,600}first\('id', 'is_recurring'\)[\s\S]{0,300}if \(!freshParent \|\| freshParent\.is_recurring\) return;/);
  });

  test('the seeding sweep takes the occupancy lock from its EXPORTING module', () => {
    // codex #3504 r3 P1: availability.js imports acquireOccupancyLock but
    // does not re-export it — destructuring it from there is undefined and
    // the first lock call throws, stripping every plan's pricing. Assert
    // the real export exists and no booking require pulls it from
    // availability.
    expect(booking).toMatch(/\{ acquireOccupancyLock, findConflictingVisits \} = require\('\.\.\/services\/scheduling\/occupancy'\)/);
    expect(booking).not.toMatch(/acquireOccupancyLock[^\n]*require\('\.\.\/services\/availability'\)/);
    expect(typeof require('../services/scheduling/occupancy').acquireOccupancyLock).toBe('function');
  });

  test('the duplicate-series guard is scoped to the quoted property via the shared scope builder', () => {
    // codex #3504 r4: customer+family alone reads a property-A series as a
    // duplicate of the property-B plan and strips the new parent's pricing.
    expect(booking).toMatch(/buildSeriesAddressScope\(trx, lockedDraft, custId\)/);
    expect(booking).toMatch(/excludeParentId: seriesParentRow\.id,\s*\n\s*serviceAddressScope: seriesAddressScope,/);
    const converter = require('../services/estimate-converter');
    expect(typeof converter.buildSeriesAddressScope).toBe('function');
  });

  test('buildSeriesAddressScope: no address and no property link → null (legacy guard)', async () => {
    const { buildSeriesAddressScope } = require('../services/estimate-converter');
    await expect(buildSeriesAddressScope(null, { id: 'x' }, 'cust')).resolves.toBeNull();
    await expect(buildSeriesAddressScope(null, null, 'cust')).resolves.toBeNull();
  });

  test('a palm plan stamps the RECURRING catalog identity before seeding, and aborts without it', () => {
    // codex #3504 r4 (converter palm doctrine, #3349 r15): a name-only
    // 'Palm Injections' row completion-resolves the ONE-TIME profile and
    // invoices work the plan already billed.
    expect(booking).toMatch(/service_key: 'palm_injection_semiannual'/);
    expect(booking).toMatch(/palm_injection_semiannual\) unavailable — aborting series activation/);
    const stampAt = booking.indexOf("where({ service_key: 'palm_injection_semiannual' })");
    const seedAt = booking.indexOf('await RecurringAppointmentSeeder.seedFollowUpsForParent(trx, seriesParentRow');
    expect(stampAt).toBeGreaterThan(0);
    expect(seedAt).toBeGreaterThan(stampAt);
    // Children inherit the identity from the parent row (seeder contract).
    const seeder = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'recurring-appointment-seeder.js'), 'utf8');
    expect(seeder).toMatch(/copyIfPresent\(row, parent, \[\s*\n\s*'create_invoice_on_complete',[\s\S]{0,400}'service_id',/);
  });

  test('a colliding seeded occurrence demotes to the WINDOWLESS placeholder (inert to occupancy), never a persisted overlap', () => {
    // codex #3504 r4: clearing only the technician left the row occupying
    // the slot in the tech-blind model.
    expect(booking).toMatch(/technician_id: null,\s*\n\s*window_start: null,\s*\n\s*window_end: null,\s*\n\s*notes: trx\.raw[\s\S]{0,200}office to place/);
    // ...and the RETURNED row is patched too, so the reminder loop sees it
    // windowless (codex #3504 r5).
    expect(booking).toMatch(/row\.window_start = null;\s*\n\s*row\.window_end = null;/);
  });

  test('windowless follow-ups register PRE-CLOSED reminder placeholders, never armed 72/24h sends for an unchosen time', () => {
    // codex #3504 r5: the registration loop's slot_start fallback would
    // otherwise arm reminders at the parent's time for a visit the office
    // has not placed.
    expect(booking).toMatch(/isWindowlessFollowUp = row\.id !== serviceRow\.id && !row\.window_start/);
    expect(booking).toMatch(/isWindowlessFollowUp \? \{ closeReminderWindows: true \} : \{\}/);
  });

  test('a replay-activated series registers its reminder rows before the early return', () => {
    // codex #3504 r5 hook: the replay path returns before the main
    // registration loop — without its own idempotent pass the whole
    // replay-seeded series would never enter appointment_reminders.
    expect(booking).toMatch(/const replayActivation = await activateWizardSeries\(replayParent\);/);
    expect(booking).toMatch(/\[replayParent, \.\.\.replaySeeded\]/);
    expect(booking).toMatch(/replaySeeded\.length[\s\S]{0,1500}sendConfirmation: false,\s*\n\s*\.\.\.\(windowless \? \{ closeReminderWindows: true \} : \{\}\)/);
  });

  test('the duplicate-series skip log is cadence-neutral (non-pest plans are not quarterly)', () => {
    expect(booking).toMatch(/Skipped recurring follow-up seeding for booking/);
    expect(booking).toMatch(/no second recurring series was seeded/);
    expect(booking).not.toMatch(/no second quarterly series was seeded/);
  });

  test('wizard series seed as FIXED-length plans, never Ongoing (auto-extend would rebill the remainder price)', () => {
    // codex #3504 hook P0: the auto-extend maintenance templates extension
    // visits off the PARENT's remainder-bearing first-visit price, so an
    // Ongoing wizard series would overbill every renewal cycle.
    expect(booking).toMatch(/durationMinutes: duration,\s*\n\s*source: source \|\| 'self_booked',[\s\S]{0,1200}recurringOngoing: false,/);
    // The seeder honors the flag on both the parent mark and the children.
    const seeder = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'recurring-appointment-seeder.js'), 'utf8');
    expect(seeder.match(/recurring_ongoing: opts\.recurringOngoing !== false/g).length).toBeGreaterThanOrEqual(2);
  });

  test('fee-exempt seeded bookings still correlate the parent and retire the draft', () => {
    expect(booking).toMatch(/whereNull\('source_estimate_id'\)\s*\n\s*\.update\(\{ source_estimate_id: pricing_estimate_id/);
    expect(booking).toMatch(/source: 'quote_wizard', status: 'draft' \}\)\s*\n\s*\.whereNull\('archived_at'\)/);
  });
});
