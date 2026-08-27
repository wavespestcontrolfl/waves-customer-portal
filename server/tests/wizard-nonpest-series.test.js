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

  test('retired-but-consistent cadences fail closed via the converter eligibility gate', () => {
    // codex #3504 r7: 4-visit quarterly lawn is owner-retired and 12-visit
    // monthly tree/shrub was never sold — the accept paths reject both, so
    // a drifted handoff draft must not activate them here either.
    const retiredLawn = {
      id: 'est-lawn-q', annual_total: 400, monthly_total: 33.33,
      estimate_data: { engineResult: { lineItems: [{ service: 'lawn_care', name: 'Lawn Care', monthly: 33.33, annual: 400, perApp: 100, visitsPerYear: 4, frequency: 'quarterly' }] } },
    };
    expect(resolveWizardSeriesPlan(retiredLawn, 'lawn_care')).toBeNull();
    const monthlyTree = {
      id: 'est-tree-m', annual_total: 1200, monthly_total: 100,
      estimate_data: { engineResult: { lineItems: [{ service: 'tree_shrub', name: 'Tree & Shrub', monthly: 100, annual: 1200, perApp: 100, visitsPerYear: 12, frequency: 'monthly' }] } },
    };
    expect(resolveWizardSeriesPlan(monthlyTree, 'tree_shrub')).toBeNull();
    // ...while the sold tiers still resolve (Enhanced 9x tree carries the
    // all-numeric-nine cadence fields that read every_6_weeks).
    const soldTree = {
      id: 'est-tree-9', annual_total: 900, monthly_total: 75,
      estimate_data: { engineResult: { lineItems: [{ service: 'tree_shrub', name: 'Tree & Shrub', monthly: 75, annual: 900, perApp: 100, visits: 9, frequency: 9 }] } },
    };
    expect(resolveWizardSeriesPlan(soldTree, 'tree_shrub')).toEqual({ pattern: 'every_6_weeks', visits: 9 });
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'booking-pay-at-visit.js'), 'utf8');
    expect(src).toMatch(/supportsConverterFollowUpSeeding\(gateLine, \{\}, pattern\)/);
  });

  test('an off-tier mosquito count NEVER falls through to the generic buckets (runtime-config drift)', () => {
    // codex #3504 r6: pricing_config.mosquito_visits is configurable — a
    // seasonal program tuned to 6 visits would read 'bimonthly', pass the
    // generic promise check, and seed billable treatments year-round,
    // bypassing the winter guard. Only the 9/12 programs exist.
    expect(resolveWizardSeriesPlan(mosquitoEstimate({ visits: 6, frequency: 'bimonthly' }), 'mosquito')).toBeNull();
    expect(resolveWizardSeriesPlan(mosquitoEstimate({ visits: 4, frequency: 'quarterly' }), 'mosquito')).toBeNull();
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

  test('the REAL palm pricer output resolves a semiannual plan through the mirror mapping', () => {
    // Executable regression against the actual engine shape (codex #3504
    // r8 raised perVisit as absent from the pricer's return — it is not:
    // service-pricing.js computes perVisit = max(rawPerVisit, minPerVisit)
    // and returns BOTH, the engine pushes the raw result as the line item,
    // and the mirror persists item.perVisit).
    const { pricePalmInjection } = require('../services/pricing-engine/service-pricing');
    const line = pricePalmInjection({}, { treatmentType: 'insecticide', palmCount: 4, palmSize: 'medium' });
    expect(line.perVisit).toBeGreaterThan(0);
    expect(line.appsPerYear).toBe(2);
    // The public-quote mirror's field mapping, applied verbatim.
    const mirrored = {
      service: line.service,
      annual: line.annual ?? null,
      monthly: line.monthly ?? null,
      perApp: line.perApp ?? null,
      perVisit: line.perVisit ?? null,
      visits: line.visits ?? null,
      frequency: line.frequency ?? line.visitsPerYear ?? null,
      appsPerYear: line.appsPerYear ?? null,
    };
    const estimate = {
      id: 'est-real-palm',
      annual_total: line.annual,
      monthly_total: line.monthly,
      estimate_data: { engineResult: { lineItems: [mirrored] } },
    };
    expect(wizardPlanServiceKey(estimate, 'tree_shrub')).toBe('palm_injection');
    expect(resolveWizardSeriesPlan(estimate, 'palm_injection')).toEqual({ pattern: 'semiannual', visits: 2 });
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

  test('activation re-validates the locked parent IS still the priced row (sweep-strip/cancel race)', () => {
    // codex #3504 r6 hook P0: the recovery sweep can strip the parent
    // while a delayed activation waits on the comms lock — seeding from
    // the stale in-memory row would underbill the series by the first
    // application. Any mismatch = stale, no seed, no write.
    // FOR UPDATE (codex #3504 r7): cancellation writers don't take the
    // comms lock, so the parent row lock is what serializes them.
    expect(booking).toMatch(/\.forUpdate\(\)\s*\n\s*\.first\('id', 'is_recurring', 'status', 'payment_method_preference',\s*\n\s*'estimated_price', 'create_invoice_on_complete', 'source_estimate_id',\s*\n\s*'scheduled_date', 'window_start', 'window_end', 'technician_id',\s*\n\s*'service_type', 'service_id',\s*\n\s*\.\.\.\(\(await trx\.schema\.hasColumn\('scheduled_services', 'source_estimate_generation'\)\)/);
    expect(booking).toMatch(/lockedParent\.payment_method_preference !== 'pay_at_visit'\s*\n\s*\|\| lockedParent\.create_invoice_on_complete !== true\s*\n\s*\|\| Number\(lockedParent\.estimated_price\) !== Number\(visitPrice\)/);
    expect(booking).toMatch(/no longer matches its priced state under lock/);
    // The correlation is stamped SERVER-SIDE from the verified pricing
    // draft, never from the client's optional source_estimate_id field —
    // otherwise an omitted/substituted value strands a priced visit the
    // recovery sweep (joined on source_estimate_id) can never find
    // (codex #3504 r7 hook P0).
    expect(booking).toMatch(/if \(pricingTrusted\) sourceEstimateId = String\(pricing_estimate_id\);/);
    // Ordering: the alreadyActivated fast-path stays FIRST (an activated
    // parent is success, not staleness), then the priced-state check,
    // then the draft drift comparison.
    const activatedAt = booking.indexOf('alreadyActivated: true');
    const pricedStateAt = booking.indexOf('no longer matches its priced state under lock');
    const driftAt = booking.indexOf('freshPlan.pattern !== wizardSeriesPlan.pattern');
    expect(pricedStateAt).toBeGreaterThan(activatedAt);
    expect(driftAt).toBeGreaterThan(pricedStateAt);
  });

  test('a duplicate confirmation reads a completed activation as success, never as drift', () => {
    // The under-lock is_recurring re-check must run BEFORE the locked-draft
    // drift comparison, or the loser strips the winner's activated parent.
    // r18: is_recurring counts as a completed activation ONLY with the
    // activation-archived draft; a live draft beside a recurring parent is
    // a staff-made series → stale + office bell, never alreadyActivated.
    expect(booking).toMatch(/lockedParent && lockedParent\.is_recurring\) \{[\s\S]{0,1400}\.where\(\{ recurring_parent_id: seriesParentRow\.id \}\)\s*\n\s*\.first\('id'\);\s*\n\s*if \(activationChild\) return \{ alreadyActivated: true \};/);
    expect(booking).toMatch(/wizard-activation-foreign-recurring:\$\{seriesParentRow\.id\}/);
    expect(booking).toMatch(/return \{ stale: true, foreignRecurring: true \};/);
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

  test('a failed/stale activation still runs the waiver-only fee disposition', () => {
    // codex #3504 r8: kept-duplicate runs it in-transaction and success
    // paths stamp with the series, but failed/stale outcomes left the live
    // draft's positive frozen fee standing — a later conversion would
    // charge a fee the shared recheck would have waived.
    expect(booking).toMatch(/\} else if \(setupFeeHandoffEligible\) \{[\s\S]{0,900}stampDisclosedSetupFee\(trx, \{ allowStamp: false, stampServiceRow: serviceRow \}\)/);
    expect(booking).toMatch(/post-failure setup-fee waiver recheck failed/);
  });

  test('seasonal plans refuse winter (Nov-Jan) parent starts', () => {
    expect(booking).toMatch(/startMonth >= 2 && startMonth <= 10/);
  });

  test('the plan and price re-resolve against the LOCKED draft before seeding', () => {
    expect(booking).toMatch(/freshPlan\.pattern !== wizardSeriesPlan\.pattern/);
    expect(booking).toMatch(/freshPriced\.followUpAmount !== followUpVisitPrice/);
    expect(booking).toMatch(/return \{ stale: true \};/);
  });

  test('the locked draft must still quote the BOOKED property, or the activation is stale (r15)', () => {
    // codex #3504 r15: a same-plan/same-price refresh to another address
    // passed the drift check, and the r14 stamp would then have routed
    // the whole series to the second address.
    expect(booking).toMatch(/const bookedCustomerRow = await trx\('customers'\)\s*\n\s*\.where\(\{ id: custId \}\)/);
    expect(booking).toMatch(/quotedPropertyIsBooked = !!lockedDraft\s*\n\s*&& !!bookedCustomerRow\s*\n\s*&& estimateQuotesCustomerAddress\(lockedDraft\.address, bookedCustomerRow\)/);
    expect(booking).toMatch(/if \(!freshPlan\s*\n\s*\|\| !quotedPropertyIsBooked/);
    // The comparator itself fails closed on a different street / city / zip
    // and passes the customer's own property (unit-tolerant).
    const { estimateQuotesCustomerAddress } = require('../services/estimate-property-linkage');
    const booked = { address_line1: '100 Main St', address_line2: null, city: 'Venice', state: 'FL', zip: '34285' };
    expect(estimateQuotesCustomerAddress('100 Main St, Venice, FL 34285', booked)).toBe(true);
    expect(estimateQuotesCustomerAddress('200 Other St, Venice, FL 34285', booked)).toBe(false);
    expect(estimateQuotesCustomerAddress('100 Main St, Sarasota, FL 34236', booked)).toBe(false);
  });

  test('in-activation property linkage runs in a SAVEPOINT with a transaction-health probe (r15)', () => {
    // codex #3504 r15: the helper swallows SQL errors → aborted trx →
    // COMMIT silently rolls back while the request reports success.
    expect(booking).toMatch(/await trx\.raw\('SAVEPOINT wizard_activation_linkage'\);/);
    expect(booking).toMatch(/await trx\.raw\('RELEASE SAVEPOINT wizard_activation_linkage'\);/);
    expect(booking).toMatch(/await trx\.raw\('ROLLBACK TO SAVEPOINT wizard_activation_linkage'\);/);
    expect(booking).toMatch(/await trx\.raw\('SELECT 1'\);\s*\n\s*return \{ seedResult, parentExtension \};/);
  });

  test('a reschedule-pending visit keeps a fixed series ACTIVE in the duplicate guard (r15)', () => {
    const seeder = fs.readFileSync(path.join(__dirname, '..', 'services', 'recurring-appointment-seeder.js'), 'utf8');
    expect(seeder).toMatch(/\.whereIn\('status', \['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site'\]\)[\s\S]{0,900}this\.where\('scheduled_date', '>=', etDateString\(\)\)\s*\n\s*\.orWhere\('status', 'rescheduled'\)/);
    // r16: a rescheduled PARENT stays in the candidate set too — only a
    // cancelled parent is excluded; the probe/ongoing flag decide activity.
    expect(seeder).toMatch(/\.whereNull\('recurring_parent_id'\)[\s\S]{0,700}\.whereNotIn\('status', \['cancelled'\]\)\s*\n\s*\.select\('id', 'service_type', 'recurring_pattern', 'scheduled_date', 'status'\)/);
    const guardBody = seeder.slice(seeder.indexOf('async function findActiveRecurringSeries'), seeder.indexOf('async function checkActiveSeriesLocked'));
    expect(guardBody).not.toMatch(/whereNotIn\('status', \['cancelled', 'rescheduled'\]\)/);
  });

  test('a missing cadence catalog row keeps the funnel duration and stays name-resolved (fail-open, never a throw)', () => {
    // codex #3504 r16 P2 rebuttal pin: the duration read is guarded by the
    // optional chain IN the condition, so the block (and its plain deref)
    // is unreachable when the row is absent; the warn branch runs instead.
    expect(booking).toMatch(/if \(!\(Number\(authorityDuration\) > 0\) && Number\(catalogRow\?\.default_duration_minutes\) > 0\) \{\s*\n\s*seededChildDuration = Number\(catalogRow\.default_duration_minutes\);/);
    expect(booking).toMatch(/\} else if \(cadenceKey\) \{\s*\n\s*logger\.warn\(`\[booking:confirm\] cadence catalog row \$\{cadenceKey\} missing/);
    const catalogRow = null;
    const authorityDuration = null;
    let seededChildDuration = 45;
    expect(() => {
      if (!(Number(authorityDuration) > 0) && Number(catalogRow?.default_duration_minutes) > 0) {
        seededChildDuration = Number(catalogRow.default_duration_minutes);
      }
    }).not.toThrow();
    expect(seededChildDuration).toBe(45);
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

  test('every pricing strip surfaces a deduped admin bell in the SAME transaction', () => {
    // codex #3504 r8 hook: a stripped parent is invisible to the recovery
    // sweep, so a log-only strip lets the office serve an unbilled visit
    // unaware the live quote needs conversion. Savepoint-wrapped: a bell
    // failure never voids the strip.
    expect(booking).toMatch(/notifySeriesStripInTx = async \(trx, parentId, reason\)/);
    expect(booking).toMatch(/wizard-activation-stripped:\$\{parentId\}/);
    expect(booking).toMatch(/notifySeriesStripInTx\(trx, seriesParentRow\.id, 'the quote changed while the booking was confirming'\)/);
    expect(booking).toMatch(/notifySeriesStripInTx\(trx, seriesParentRow\.id, 'series seeding failed'\)/);
    // r9: the duplicate-kept and moved-placement strips ring it too.
    expect(booking).toMatch(/notifySeriesStripInTx\(trx, seriesParentRow\.id, 'the customer already has an active series for this service'\)/);
    expect(booking).toMatch(/notifySeriesStripInTx\(trx, seriesParentRow\.id, 'the first visit was moved before the plan activated'\)/);
    // r14: the strip bell rides the shared in-trx office-bell helper; the
    // failure log names the decision that stands.
    expect(booking).toMatch(/\$\{failLabel\} bell failed for \$\{metadata\?\.scheduled_service_id\} \(\$\{failLabel\} stands\)/);
    expect(booking).toMatch(/failLabel: 'strip',/);
    // The drift/failure/moved strips carry the office note on the row.
    expect((booking.match(/self-booked plan did not activate \((quote changed|seeding failed|visit was moved before the plan started)\); office converts from the live quote/g) || []).length).toBe(3);
  });

  test('a rescheduled parent (date/window/technician moved before activation) fails closed with strip + bell', () => {
    // codex #3504 r9: seeding from the stale in-memory parent would anchor
    // every child and the pre-locked occupancy plan to the OLD placement.
    expect(booking).toMatch(/'scheduled_date', 'window_start', 'window_end', 'technician_id',/);
    expect(booking).toMatch(/lockedDateStr !== parentDateStr\s*\n\s*\|\| timeKey\(lockedParent\.window_start\) !== timeKey\(seriesParentRow\.window_start\)/);
    expect(booking).toMatch(/placement changed before activation/);
  });

  test('the follow-through heal sweep durably re-runs it for recently activated parents', () => {
    // codex #3504 r9: a worker death after the activation commit loses the
    // in-request follow-through with no other recovery path.
    const recoverySrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'wizard-series-activation-recovery.js'), 'utf8');
    expect(recoverySrc).toMatch(/async function healActivatedFollowThroughs/);
    expect(recoverySrc).toMatch(/where\('ss\.is_recurring', true\)/);
    expect(typeof require('../services/wizard-series-activation-recovery').healActivatedFollowThroughs).toBe('function');
    const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    expect(indexSrc).toMatch(/healActivatedFollowThroughs\(\)/);
    // Every run walks the WHOLE windowed set oldest-first — a newest-N
    // slice with no completion marker starves older rows (r9 hook).
    expect(recoverySrc).toMatch(/orderBy\('ss\.created_at', 'asc'\)/);
    // No row cap (r17 pre-push audit): the cursor is per-invocation, so a
    // cap would re-walk the same oldest rows every tick.
    expect(recoverySrc).not.toMatch(/maxRows/);
    // One replica per tick (r10): the heal pass can re-create a welcome
    // enqueue and sms_sequences has no unique constraint.
    expect(indexSrc).toMatch(/runExclusive\('wizard-series-recovery-sweep', async \(\) => \{/);
    // The stranded-strip predicate keeps NO upper age bound (r9 P2): an
    // outage must never expire an unrecovered billable row.
    expect(recoverySrc).not.toMatch(/youngerThanDays[\s\S]{0,400}findStrandedParents/);
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

  test('every seeded family stamps its cadence catalog identity (shared slot-reservation resolver)', () => {
    // codex #3504 r6: the coarse funnel labels cannot name a
    // cadence-specific catalog row at completion — unstamped series fall
    // back to the generic completion profile.
    expect(booking).toMatch(/cadenceCatalogKeyForProfile\(\s*\n\s*\{ service: activationFamilyKey, visitsPerYear: wizardSeriesPlan\.visits \},/);
    expect(booking).toMatch(/cadence catalog row \$\{cadenceKey\} missing — series/);
    const { cadenceCatalogKeyForProfile } = require('../services/slot-reservation');
    expect(cadenceCatalogKeyForProfile({ service: 'mosquito', visitsPerYear: 12 }, false)).toBe('mosquito_monthly');
    expect(cadenceCatalogKeyForProfile({ service: 'mosquito', visitsPerYear: 9 }, false)).toBe('mosquito_seasonal');
    expect(cadenceCatalogKeyForProfile({ service: 'tree_shrub', visitsPerYear: 9 }, false)).toBe('tree_shrub_6week');
    expect(cadenceCatalogKeyForProfile({ service: 'lawn_care', visitsPerYear: 9 }, false)).toBe('lawn_care_6week');
  });

  test('activation runs the shared post-activation follow-through (tier sync, tagger/welcome, lead conversion)', () => {
    // codex #3504 r6+r9+r10: the logic lives in the recovery SERVICE (the
    // heal sweep re-runs it durably); the route delegates with the
    // trusted ids. Property linkage deliberately is NOT in the service —
    // the reusable draft can carry a LATER quote's address, so it runs
    // INSIDE the activation transaction against the row-locked draft.
    const recoverySrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'wizard-series-activation-recovery.js'), 'utf8');
    expect(recoverySrc).not.toMatch(/linkAcceptedEstimateProperty\(/);
    expect(recoverySrc).toMatch(/syncCustomerWaveGuardPlanFromScheduledServices\(\{ database: trx, customerId: parent\.customer_id \}\)/);
    expect(recoverySrc).toMatch(/onServiceScheduled\(parent\.id\)/);
    expect(recoverySrc).toMatch(/convertLeadFromEvent\(\{\s*\n\s*source: 'recurring_service_booked',\s*\n\s*customerId: parent\.customer_id,\s*\n\s*enforceOriginating: true,/);
    // In-activation linkage: inside the transaction, AFTER the draft
    // archive (the draft is row-locked, so a wizard re-run for another
    // address serializes behind this commit).
    // ...and pinned to THIS activation's row ids: the reusable draft id
    // also matches older still-unstamped series (r10 hook P0).
    expect(booking).toMatch(/estimateId: pricing_estimate_id,\s*\n\s*customerId: custId,\s*\n\s*database: trx,[\s\S]{0,400}onlyServiceIds: sweepExcludeIds,/);
    const linkageSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'estimate-property-linkage.js'), 'utf8');
    expect((linkageSrc.match(/\.where\(\{ source_estimate_id: estimateId \}\)\.modify\(scopeToActivation\)/g) || []).length).toBe(4);
    const archiveAt = booking.indexOf("update({ archived_at: trx.fn.now(), updated_at: trx.fn.now() })");
    const linkAt = booking.indexOf('await linkAcceptedEstimateProperty({');
    const seedReturnAt = booking.indexOf('return { seedResult };');
    expect(linkAt).toBeGreaterThan(archiveAt);
    expect(seedReturnAt).toBeGreaterThan(linkAt);
    expect(booking).toMatch(/runActivationFollowThroughForParent\(\{\s*\n\s*id: parentRowId,\s*\n\s*customer_id: custId,\s*\n\s*source_estimate_id: pricing_estimate_id,/);
    // Both activation completions run it AWAITED — primary and replay —
    // and alreadyActivated retries heal a lost follow-through (codex
    // #3504 r6 hook: unawaited, a worker exit lost the property stamps
    // with no retry path).
    expect(booking).toMatch(/seriesOutcome\?\.seedResult \|\| seriesOutcome\?\.alreadyActivated/);
    expect(booking).toMatch(/await runWizardActivationFollowThrough\(serviceRow\.id\);/);
    expect(booking).toMatch(/replayActivation\?\.seedResult \|\| replayActivation\?\.alreadyActivated/);
    expect(booking).toMatch(/await runWizardActivationFollowThrough\(replayParent\.id\);/);
    // A COMMITTED activation (children exist, draft archived) still heals
    // its follow-through on retry, and replay reminder registration gates
    // on activation success — a one-visit annual plan has zero children
    // but its parent still needs reminder rows (codex #3504 r6 hook).
    expect(booking).toMatch(/\} else if \(replayParentIsOwn && replayParent\.is_recurring\) \{/);
    const remGate = booking.indexOf('Gate on ACTIVATION SUCCESS, not on child count');
    expect(remGate).toBeGreaterThan(0);
  });

  test('a replay-activated (or replay-recognized) series converts the lead like the primary path', () => {
    // codex #3504 r7: the replay branch returns before the primary lead
    // conversion block — a plan booked on the retry must not leave the
    // quote-wizard lead pre-sale.
    expect(booking).toMatch(/if \(replaySeriesActivated\) \{[\s\S]{0,600}convertLeadFromEvent\(\{\s*\n\s*source: 'recurring_service_booked',/);
    // Both replay shapes set the flag: fresh/already activation AND the
    // committed-heal branch.
    expect((booking.match(/replaySeriesActivated = true;/g) || []).length).toBe(2);
  });

  test('a stranded activation (worker died between booking commit and activation) is recovered by the strip sweep', () => {
    // codex #3504 r6: the stranded state is the durable claim; the sweep
    // strips fail-safe (price-less single visit, office converts from the
    // still-live draft) and rings a deduped admin bell.
    const recovery = fs.readFileSync(path.join(__dirname, '..', 'services', 'wizard-series-activation-recovery.js'), 'utf8');
    expect(recovery).toMatch(/whereNotNull\('ss\.self_booking_id'\)/);
    // r21: the claim is parent-scoped — the shared draft's status/archive
    // state must NOT gate the predicate (a later activation archives it).
    const findBody = recovery.slice(recovery.indexOf('function findStrandedParents'), recovery.indexOf('.limit(limit)'));
    expect(findBody).toMatch(/where\('e\.source', 'quote_wizard'\)/);
    expect(findBody).not.toMatch(/where\('e\.status', 'draft'\)/);
    expect(findBody).not.toMatch(/whereNull\('e\.archived_at'\)/);
    expect(recovery).toMatch(/lockCustomerComms\(trx, parent\.customer_id\)/);
    // The FULL stranded predicate re-validates under the lock (codex
    // #3504 r6 hook): status, activation, children, and the live draft.
    expect(recovery).toMatch(/\.forUpdate\(\)/);
    // r13: every non-cancelled status is recoverable (by status class).
    expect(recovery).toMatch(/\['cancelled', 'canceled'\]\.includes\(String\(fresh\.status \|\| ''\)\)/);
    expect(recovery).toMatch(/freshChild/);
    expect(recovery).toMatch(/const draftLive = !!freshDraft;/);
    expect(recovery).not.toMatch(/if \(!freshDraft\) return false;/);
    expect(recovery).toMatch(/body: byDisposition\.bell \+ draftNote,/);
    // The admin bell persists ATOMICALLY with the strip: a failed insert
    // rolls the strip back so the row stays sweepable (codex #3504 r6
    // hook).
    expect(recovery).toMatch(/connection: trx,/);
    expect(recovery).toMatch(/if \(!created\) throw new Error\('recovery bell insert failed/);
    expect(recovery).toMatch(/estimated_price: null,\s*\n\s*payment_method_preference: null,\s*\n\s*create_invoice_on_complete: false,/);
    const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    expect(indexSrc).toMatch(/sweepStrandedWizardActivations\(\{ limit: 10 \}\)/);
    expect(typeof require('../services/wizard-series-activation-recovery').sweepStrandedWizardActivations).toBe('function');
  });

  test('a colliding seeded occurrence demotes to the WINDOWLESS placeholder (inert to occupancy), never a persisted overlap', () => {
    // codex #3504 r4: clearing only the technician left the row occupying
    // the slot in the tech-blind model.
    expect(booking).toMatch(/technician_id: null,\s*\n\s*window_start: null,\s*\n\s*window_end: null,\s*\n\s*notes: trx\.raw[\s\S]{0,200}office to place/);
    // ...and the RETURNED row is patched too, so the reminder loop sees it
    // windowless (codex #3504 r5).
    expect(booking).toMatch(/row\.window_start = null;\s*\n\s*row\.window_end = null;/);
  });

  test('in-activation linkage keeps the property helpers on the activation connection (no self-deadlock)', () => {
    // codex #3504 r11: with GATE_CUSTOMER_PROPERTIES on, recordCallProperty
    // / ensurePrimaryProperty opened their own pool transactions and waited
    // on the customers row the activation already holds.
    const props = fs.readFileSync(path.join(__dirname, '..', 'services', 'customer-properties.js'), 'utf8');
    expect(props).toMatch(/const \{ claimFence = null, conn = null \} = opts;/);
    expect(props).toMatch(/return ensurePrimaryCore\(customerOrId, opts, conn && conn\.isTransaction \? conn : db\);/);
    expect(props).toMatch(/return conn && conn\.isTransaction \? run\(conn\) : db\.transaction\(run\);/);
    const linkageSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'estimate-property-linkage.js'), 'utf8');
    expect(linkageSrc).toMatch(/ensurePrimaryProperty\(customerId, \{ conn: database \}\)/);
    expect(linkageSrc).toMatch(/source: 'estimate_accept',\s*\n\s*conn: database,/);
  });

  test('a reused wizard draft drops its stale property_id when the quoted address changes', () => {
    // codex #3504 r11: linkAcceptedEstimateProperty prioritizes an existing
    // estimate.property_id, so a re-run for another property would stamp
    // the next series with the OLD property.
    const publicQuote = fs.readFileSync(path.join(__dirname, '..', 'routes', 'public-quote.js'), 'utf8');
    expect(publicQuote).toMatch(/const wizardAddressChanged = \(row\) =>/);
    expect((publicQuote.match(/\.\.\.\(wizardAddressChanged\((lockedEst|lockedDup)\) \? \{ property_id: null \} : \{\}\)/g) || []).length).toBe(2);
    // Both locked reads carry the address the comparison needs.
    expect((publicQuote.match(/\.first\('id', 'source', 'status', 'archived_at', 'address'\)/g) || []).length).toBe(2);
  });

  test('activation sends the new-recurring welcome through the shared candidacy gate, not the paid-tier tagger gate', () => {
    // codex #3504 r11: the accept path welcomes on new-signup candidacy
    // alone ("all tiers are included"); the tagger requires a paid tier.
    const recoverySrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'wizard-series-activation-recovery.js'), 'utf8');
    expect(recoverySrc).toMatch(/isNewRecurringSignupCandidate\(parent\.customer_id, \{ excludeServiceId: parent\.id \}\)/);
    expect(recoverySrc).toMatch(/entryPoint: 'wizard_series_activation_welcome'/);
    // Welcome only for an ACTIVATED, live parent.
    expect(recoverySrc).toMatch(/parentRow\?\.is_recurring\s*\n\s*&& String\(parentRow\.status \|\| ''\) !== 'cancelled'/);
  });

  test('the PRODUCTION lawn line (count only as numeric frequency) still passes the shared converter gate', () => {
    // codex #3504 r13: priceLawnCare emits `frequency: LAWN_TIERS.freq`
    // and no visitsPerYear/visits; the converter's count vocabulary
    // excludes frequency, so the gate saw no count and rejected every
    // lawn plan. The resolver presents its validated count under a
    // recognized alias.
    for (const [freq, pattern] of [[6, 'bimonthly'], [9, 'every_6_weeks'], [12, 'monthly']]) {
      const lawn = {
        id: `est-lawn-${freq}`, annual_total: 100 * freq, monthly_total: (100 * freq) / 12,
        estimate_data: { engineResult: { lineItems: [{ service: 'lawn_care', name: 'Lawn Care', monthly: (100 * freq) / 12, annual: 100 * freq, perApp: 100, frequency: freq }] } },
      };
      expect(resolveWizardSeriesPlan(lawn, 'lawn_care')).toEqual({ pattern, visits: freq });
    }
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'booking-pay-at-visit.js'), 'utf8');
    expect(src).toMatch(/const gateLine = \{ \.\.\.picked\.svc, visitsPerYear: picked\.visits \};/);
  });

  test('the parent is reserved at the program duration when the extended window is clear', () => {
    // codex #3504 r13: the funnel booked mosquito at 45 while the program
    // authority is 60 — the first treatment was under-reserved.
    expect(booking).toMatch(/if \(seededChildDuration > parentDurationNow\) \{/);
    expect(booking).toMatch(/parentExtensionGuard\(\{\s*\n\s*db: trx,\s*\n\s*date: parentDateStr,\s*\n\s*windowStart: slot_start,\s*\n\s*windowEnd: extendedEnd,\s*\n\s*excludeServiceIds: \[seriesParentRow\.id\],/);
    expect(booking).toMatch(/update\(\{ estimated_duration_minutes: seededChildDuration, window_end: extendedEnd, updated_at: trx\.fn\.now\(\) \}\)/);
    expect(booking).toMatch(/self_booked_appointments'\)\s*\n\s*\.where\(\{ id: seriesParentRow\.self_booking_id \}\)\s*\n\s*\.update\(\{ end_time: extendedEnd, duration_minutes: seededChildDuration \}\)/);
    expect(booking).toMatch(/could not extend to/);
  });

  test('progressed stranded activations (rescheduled/en_route/completed…) stay recoverable, by status class', () => {
    // codex #3504 r13: a pending/confirmed-only predicate silently dropped
    // stranded rows that moved on while still carrying the price.
    const recoverySrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'wizard-series-activation-recovery.js'), 'utf8');
    expect(recoverySrc).toMatch(/\.whereNotIn\('ss\.status', \['cancelled', 'canceled'\]\)/);
    expect(recoverySrc).not.toMatch(/whereIn\('ss\.status', \['pending', 'confirmed'\]\)/);
    // r14: only a COMPLETED visit with a live invoice is "billed"; skipped
    // / no_show never ran the completion-invoice path.
    expect(recoverySrc).toMatch(/COMPLETED_STATES = new Set\(\['completed'\]\)/);
    expect(recoverySrc).toMatch(/UNBILLED_TERMINAL_STATES = new Set\(\['skipped', 'no_show'\]\)/);
    expect(recoverySrc).toMatch(/\.update\(byDisposition\.patch\)/);
    // Terminal-but-billed keeps estimated_price (history), clears the
    // pay-at-visit machinery, bells for the REMAINING program.
    expect(recoverySrc).toMatch(/KEEP_PRICE_PATCH = \(trx, noteTail\) => \(\{\s*\n\s*payment_method_preference: null,\s*\n\s*create_invoice_on_complete: false,/);
    expect(recoverySrc).toMatch(/bill the REMAINING program/);
  });

  test('r28: the sweep row-locks the draft before the generation compare, so the retire-handoff archive can never land on a concurrently refreshed newer quote', () => {
    const recoverySrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'wizard-series-activation-recovery.js'), 'utf8');
    // The freshDraft read (whose updated_at the generation compare and the
    // archive both trust) must hold the row lock /calculate's refresh takes.
    expect(recoverySrc).toMatch(/const freshDraft = await trx\('estimates'\)\s*\n\s*\.where\(\{ id: parent\.source_estimate_id, source: 'quote_wizard', status: 'draft' \}\)\s*\n\s*\.whereNull\('archived_at'\)\s*\n\s*\.forUpdate\(\)\s*\n\s*\.first\(\);/);
  });

  test('r27: bells match the billing state left on the visit; locked service identity is drift-checked; placeholder label reads ride the trx', () => {
    const recoverySrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'wizard-series-activation-recovery.js'), 'utf8');
    expect((recoverySrc.match(/bell: mintedPriceConfirmed\s*\n\s*\?/g) || []).length).toBe(2);
    expect(recoverySrc).toMatch(/BILLING WAS LEFT UNTOUCHED[^`]*convert the quote for the REMAINING program only/);
    expect(booking).toMatch(/'service_type', 'service_id',\s*\n\s*\.\.\.\(\(await trx\.schema\.hasColumn\('scheduled_services', 'source_estimate_generation'\)\)/);
    expect(booking).toMatch(/\|\| RecurringAppointmentSeeder\.serviceKeyFor\(\{ service_type: lockedParent\.service_type \}\)\s*\n\s*!== RecurringAppointmentSeeder\.serviceKeyFor\(\{ service_type: resolvedServiceType \}\)/);
    expect(booking).toMatch(/String\(lockedParent\.service_id\) !== String\(seriesParentRow\.service_id\)\)\) \{/);
    const reminders = fs.readFileSync(path.join(__dirname, '..', 'services', 'appointment-reminders.js'), 'utf8');
    expect(reminders).toMatch(/async function buildServiceLabel\(scheduledServiceId, parentName, conn = db\) \{\s*\n\s*const resolvedParent = await estimateBackedServiceName\(scheduledServiceId, parentName, conn\);/);
    expect(reminders).toMatch(/const addons = await conn\('scheduled_service_addons'\)/);
    expect(reminders).toMatch(/await buildServiceLabel\(svc\.id, lockedVisit\.service_type, trx\);/);
  });

  test('r26: reconciled marker (not billing mutation) leaves the claim; unconfirmed price leaves billing untouched; sweep defers to in-flight completions; placeholder insert is idempotent', () => {
    const recoverySrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'wizard-series-activation-recovery.js'), 'utf8');
    expect(recoverySrc).toMatch(/\.whereNull\('ss\.wizard_recovery_reconciled_at'\)/);
    expect(recoverySrc).toMatch(/const BILLING_UNTOUCHED_PATCH = \(trx, noteTail\) => \(\{\s*\n\s*notes: trx\.raw/);
    expect(recoverySrc).not.toMatch(/BILLING_UNTOUCHED_PATCH = \(trx, noteTail\) => \(\{[\s\S]{0,200}payment_method_preference/);
    expect((recoverySrc.match(/wizard_recovery_reconciled_at: trx\.fn\.now\(\),/g) || []).length).toBe(3);
    expect(recoverySrc).toMatch(/if \(!hasGenerationColumn \|\| !hasReconciledColumn\) \{[\s\S]{0,400}return \{ examined: 0, stripped: 0, skipped: 'schema' \};/);
    expect(recoverySrc).toMatch(/\.whereIn\('status', \['pending', 'side_effects_pending', 'side_effects_running'\]\)\s*\n\s*\.first\('id'\);\s*\n\s*if \(inFlightCompletion\) return false;/);
    const migSrc = fs.readFileSync(path.join(__dirname, '..', 'models', 'migrations', '20260827000001_source_estimate_generation.js'), 'utf8');
    expect(migSrc).toMatch(/t\.timestamp\('wizard_recovery_reconciled_at', \{ useTz: true \}\)\.nullable\(\);/);
    const reminders = fs.readFileSync(path.join(__dirname, '..', 'services', 'appointment-reminders.js'), 'utf8');
    expect(reminders).toMatch(/async insertPreClosedPlaceholderRowInTx\([\s\S]{0,900}pg_advisory_xact_lock\(hashtext\(\?\)\)', \[\s*\n\s*`appointment-reminder:\$\{customerId\}:\$\{apptTime\.toISOString\(\)\}`,[\s\S]{0,300}\.where\(\{ scheduled_service_id: scheduledServiceId \}\)\s*\n\s*\.first\('id'\);\s*\n\s*if \(existing\) return existing;/);
  });

  test('r25: sweep preserves staff billing edits; in-progress final visits stay active; activation binds to the parent generation', () => {
    const recoverySrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'wizard-series-activation-recovery.js'), 'utf8');
    expect(recoverySrc).toMatch(/\.where\('ss\.create_invoice_on_complete', true\)/);
    expect(recoverySrc).toMatch(/\|\| fresh\.create_invoice_on_complete !== true/);
    expect(recoverySrc).toMatch(/const mintedPriceConfirmed = \(\(\) => \{\s*\n\s*if \(!draftRepresentsParent\) return false;/);
    expect(recoverySrc).toMatch(/in_flight: \{\s*\n\s*patch: \(mintedPriceConfirmed \? STRIP_PATCH : BILLING_UNTOUCHED_PATCH\)\(/);
    expect(recoverySrc).toMatch(/terminal_unbilled: \{\s*\n\s*patch: \(mintedPriceConfirmed \? STRIP_PATCH : BILLING_UNTOUCHED_PATCH\)\(/);
    const seeder = fs.readFileSync(path.join(__dirname, '..', 'services', 'recurring-appointment-seeder.js'), 'utf8');
    expect(seeder).toMatch(/\.whereIn\('status', \['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site'\]\)/);
    expect(seeder).toMatch(/\.orWhere\('status', 'rescheduled'\)\s*\n\s*\.orWhere\('status', 'en_route'\)\s*\n\s*\.orWhere\('status', 'on_site'\);/);
    expect(booking).toMatch(/const draftGenerationMatches = !lockedParent\?\.source_estimate_generation\s*\n\s*\|\| \(!!lockedDraft\?\.updated_at\s*\n\s*&& new Date\(lockedDraft\.updated_at\)\.getTime\(\) === new Date\(lockedParent\.source_estimate_generation\)\.getTime\(\)\);/);
    expect(booking).toMatch(/\|\| !quotedPropertyIsBooked\s*\n\s*\|\| !draftGenerationMatches/);
  });

  test('r22: handoff retires only for a draft proven to be THIS booking\'s; replay echoes extension; cleanup strip is priced-state conditional', () => {
    const recoverySrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'wizard-series-activation-recovery.js'), 'utf8');
    // P0: a reused draft (updated_at after the booking) is a NEWER quote —
    // never archived by an older parent's reconcile.
    // r24 P0: ownership proof is the PARENT-OWNED generation marker
    // (migration 20260827000001) — exact equality with the live draft's
    // updated_at; no window, no content inference, unstamped fails closed.
    expect(recoverySrc).toMatch(/&& !!fresh\.source_estimate_generation\s*\n\s*&& !!freshDraft\.updated_at\s*\n\s*&& new Date\(freshDraft\.updated_at\)\.getTime\(\) === new Date\(fresh\.source_estimate_generation\)\.getTime\(\);/);
    expect(recoverySrc).toMatch(/hasColumn\('scheduled_services', 'source_estimate_generation'\)/);
    // ownership never infers from content — the price match lives only in
    // mintedPriceConfirmed (r25), which is gated on the generation proof.
    expect(recoverySrc).toMatch(/const draftRepresentsParent = draftLive\s*\n\s*&& String\(freshDraft\.customer_id \|\| ''\) === String\(fresh\.customer_id \|\| ''\)\s*\n\s*&& !!fresh\.source_estimate_generation/);
    // The booking stamps the generation on the parent at INSERT, only for
    // trusted wizard pricing, column-guarded.
    expect(booking).toMatch(/sourceEstimateGeneration = pricingTrusted && pricingEstimate\?\.updated_at \? pricingEstimate\.updated_at : null;/);
    // (Pest lane: the reconciled-column read + in-transaction kept guard now
    // sit between the generation-column read and the INSERT.)
    expect(booking).toMatch(/const hasGenerationColumn = await trx\.schema\.hasColumn\('scheduled_services', 'source_estimate_generation'\);\s*\n\s*const hasReconciledColumn = await trx\.schema\.hasColumn\('scheduled_services', 'wizard_recovery_reconciled_at'\);/);
    expect(booking).toMatch(/const \[scheduledRow\] = await trx\('scheduled_services'\)\.insert\(\{\s*\n\s*\.\.\.\(pestDuplicateKeptAtBooking \? \{ wizard_recovery_reconciled_at: trx\.fn\.now\(\) \} : \{\}\),\s*\n\s*\.\.\.\(hasGenerationColumn && paymentPref === 'pay_at_visit' && sourceEstimateGeneration/);
    const migration = require('../models/migrations/20260827000001_source_estimate_generation');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');
    const migSrc = fs.readFileSync(path.join(__dirname, '..', 'models', 'migrations', '20260827000001_source_estimate_generation.js'), 'utf8');
    expect(migSrc).toMatch(/hasTable\('scheduled_services'\)/);
    expect(migSrc).toMatch(/hasColumn\('scheduled_services', 'source_estimate_generation'\)/);
    expect(migSrc).toMatch(/t\.timestamp\('source_estimate_generation', \{ useTz: true \}\)\.nullable\(\);/);
    expect(recoverySrc).toMatch(/its booking link was left intact/);
    expect((recoverySrc.match(/\$\{draftRepresentsParent \? "The quote draft has been ARCHIVED/g) || []).length).toBe(3);
    // replay response patch
    expect(booking).toMatch(/if \(replayActivation\?\.parentExtension\) Object\.assign\(txResult\.existing, replayActivation\.parentExtension\);/);
    // cleanup strip: conditional on the exact priced state
    expect(booking).toMatch(/const stripped = await trx\('scheduled_services'\)\s*\n\s*\.where\(\{\s*\n\s*id: seriesParentRow\.id,\s*\n\s*payment_method_preference: 'pay_at_visit',\s*\n\s*create_invoice_on_complete: true,\s*\n\s*source_estimate_id: pricing_estimate_id,\s*\n\s*\}\)\s*\n\s*\.whereIn\('status', \['pending', 'confirmed'\]\)\s*\n\s*\.where\('estimated_price', visitPrice\)/);
    expect(booking).toMatch(/if \(!stripped\) \{[\s\S]{0,300}return;\s*\n\s*\}\s*\n\s*await notifySeriesStripInTx\(trx, seriesParentRow\.id, 'series seeding failed'\);/);
  });

  test('r21: overdue reschedule placeholders stay active; extended reservation is echoed on the response', () => {
    const seeder = fs.readFileSync(path.join(__dirname, '..', 'services', 'recurring-appointment-seeder.js'), 'utf8');
    expect(seeder).toMatch(/\.where\(function activeBound\(\) \{\s*\n\s*this\.where\('scheduled_date', '>=', etDateString\(\)\)\s*\n\s*\.orWhere\('status', 'rescheduled'\)/);
    expect(booking).toMatch(/parentExtension = \{ end_time: extendedEnd, duration_minutes: seededChildDuration \};/);
    expect(booking).toMatch(/return \{ seedResult, parentExtension \};/);
    expect(booking).toMatch(/if \(seriesOutcome\?\.parentExtension\) Object\.assign\(booking, seriesOutcome\.parentExtension\);/);
  });

  test('r20: seeding blackout reads ride the caller connection; refunded invoices keep their own disposition', () => {
    const seeder = fs.readFileSync(path.join(__dirname, '..', 'services', 'recurring-appointment-seeder.js'), 'utf8');
    expect(seeder).toMatch(/async function seedingBlackoutDates\(conn, parent, opts = \{\}\)/);
    expect(seeder).toMatch(/getBlackoutLayers\(\s*\n\s*baseDate,\s*\n\s*etDateString\([^\n]*\),\s*\n\s*conn,\s*\n\s*\)/);
    expect((seeder.match(/await seedingBlackoutDates\(conn, parent, opts\)/g) || []).length).toBe(2);
    expect(seeder).not.toMatch(/getBlackoutDates\(/);
    const recoverySrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'wizard-series-activation-recovery.js'), 'utf8');
    expect(recoverySrc).toMatch(/completed_refunded: \{\s*\n\s*retireHandoff: true,/);
    expect(recoverySrc).toMatch(/do NOT bill the application again until the refund is final/);
    expect(recoverySrc).toMatch(/DEAD_INVOICE_STATUSES = \['void', 'voided', 'cancelled', 'canceled'\]/);
  });

  test('r19: lock order, healer evidence, retired handoff, accept-path linkage scope', () => {
    // #1 customer row FOR UPDATE precedes the recurring-series advisory
    // (converter order: customers → series advisory).
    expect(booking).toMatch(/const bookedCustomerRow = await trx\('customers'\)\s*\n\s*\.where\(\{ id: custId \}\)\s*\n\s*\.forUpdate\(\)/);
    // The activation's OWN guard call (the pest lane added an earlier one
    // inside the booking transaction) follows the customer row lock.
    const bookedCustomerRowAt = booking.indexOf("const bookedCustomerRow = await trx('customers')");
    const activationGuardAt = booking.indexOf('RecurringAppointmentSeeder.checkActiveSeriesLocked(trx, {', bookedCustomerRowAt);
    expect(bookedCustomerRowAt).toBeGreaterThan(0);
    expect(activationGuardAt).toBeGreaterThan(bookedCustomerRowAt);
    // #2 the healer requires the activation-archived draft, never
    // is_recurring alone (same rule as the request path, r18).
    const recoverySrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'wizard-series-activation-recovery.js'), 'utf8');
    const healerBody = recoverySrc.slice(recoverySrc.indexOf('async function healActivatedFollowThroughs'), recoverySrc.indexOf('module.exports'));
    expect(healerBody).toMatch(/\.where\('e\.source', 'quote_wizard'\)[\s\S]{0,1200}\.whereExists\(function activationChild\(\) \{\s*\n\s*this\.select\(1\)\.from\('scheduled_services as c'\)\.whereRaw\('c\.recurring_parent_id = ss\.id'\);/);
    expect(healerBody).not.toMatch(/whereNotNull\('e\.archived_at'\)/);
    // #3 completed dispositions retire the public handoff (archive the
    // draft) in the same transaction; unbilled/in-flight keep it live.
    expect(recoverySrc).toMatch(/completed_billed: \{\s*\n\s*retireHandoff: true,/);
    expect(recoverySrc).toMatch(/completed_unbilled: \{\s*\n\s*retireHandoff: true,/);
    expect(recoverySrc).not.toMatch(/terminal_unbilled: \{\s*\n\s*retireHandoff: true,/);
    expect(recoverySrc).toMatch(/if \(byDisposition\.retireHandoff && draftRepresentsParent\) \{\s*\n\s*await trx\('estimates'\)\s*\n\s*\.where\(\{ id: parent\.source_estimate_id, source: 'quote_wizard', status: 'draft' \}\)\s*\n\s*\.whereNull\('archived_at'\)\s*\n\s*\.update\(\{ archived_at: trx\.fn\.now\(\)/);
    // #4 an unscoped linkage on a wizard-sourced estimate never touches
    // self-booked rows (activation-owned, stamped with explicit ids).
    const linkageSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'estimate-property-linkage.js'), 'utf8');
    expect(linkageSrc).toMatch(/const excludeSelfBooked = sourceRow\?\.source === 'quote_wizard'\s*\n\s*&& !\(Array\.isArray\(onlyServiceIds\) && onlyServiceIds\.length\);/);
    expect(linkageSrc).toMatch(/else if \(excludeSelfBooked\) qb\.whereNull\('self_booking_id'\);/);
  });

  test('skipped / no-show stranded first visits are UNBILLED: strip + convert the FULL program (r14)', async () => {
    // codex #3504 r14: those statuses skip the completion-invoice path (a
    // no-show charges at most its flat fee), so "already billed at the
    // quoted price" was false and the office would under-convert.
    const { classifyStrandedDisposition } = require('../services/wizard-series-activation-recovery');
    const trxWithInvoice = (rows) => {
      const chain = {
        where: jest.fn(() => chain),
        whereNotIn: jest.fn(() => chain),
        select: jest.fn(async () => rows),
      };
      return Object.assign(jest.fn(() => chain), { chain });
    };
    expect(await classifyStrandedDisposition(trxWithInvoice([{ id: 'inv' }]), 'p1', 'skipped')).toBe('terminal_unbilled');
    expect(await classifyStrandedDisposition(trxWithInvoice([{ id: 'inv' }]), 'p1', 'no_show')).toBe('terminal_unbilled');
    expect(await classifyStrandedDisposition(trxWithInvoice([]), 'p1', 'en_route')).toBe('in_flight');
    expect(await classifyStrandedDisposition(trxWithInvoice([]), 'p1', 'confirmed')).toBe('in_flight');
    // completed is billed ONLY with a live invoice on the visit.
    const billed = trxWithInvoice([{ id: 'inv', status: 'paid' }]);
    expect(await classifyStrandedDisposition(billed, 'p1', 'completed')).toBe('completed_billed');
    expect(billed.chain.whereNotIn).toHaveBeenCalledWith('status', expect.arrayContaining(['void', 'cancelled']));
    expect(billed.chain.whereNotIn).not.toHaveBeenCalledWith('status', expect.arrayContaining(['refunded']));
    expect(await classifyStrandedDisposition(trxWithInvoice([]), 'p1', 'completed')).toBe('completed_unbilled');
    // r20: a REFUNDED invoice is its own state — never "never invoiced"
    // (the refund can fail and restore the original; no re-bill).
    expect(await classifyStrandedDisposition(trxWithInvoice([{ id: 'inv', status: 'refunded' }]), 'p1', 'completed')).toBe('completed_refunded');
    expect(await classifyStrandedDisposition(trxWithInvoice([{ id: 'a', status: 'refunded' }, { id: 'b', status: 'paid' }]), 'p1', 'completed')).toBe('completed_billed');
    const recoverySrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'wizard-series-activation-recovery.js'), 'utf8');
    expect(recoverySrc).toMatch(/terminal_unbilled: \{\s*\n\s*patch: \(mintedPriceConfirmed \? STRIP_PATCH : BILLING_UNTOUCHED_PATCH\)\(/);
    expect(recoverySrc).toMatch(/bill the FULL plan/);
    expect(recoverySrc).toMatch(/completed_unbilled: \{\s*\n\s*retireHandoff: true,\s*\n\s*patch: KEEP_PRICE_PATCH\(/);
  });

  test('the follow-through healer walks the whole eligible set by keyset cursor, never one re-selected page (r14)', () => {
    const recoverySrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'wizard-series-activation-recovery.js'), 'utf8');
    expect(recoverySrc).toMatch(/whereRaw\('\(ss\.created_at, ss\.id\) > \(\?, \?\)', \[cursor\.created_at, cursor\.id\]\)/);
    expect(recoverySrc).toMatch(/\.orderBy\('ss\.created_at', 'asc'\)\s*\n\s*\.orderBy\('ss\.id', 'asc'\)/);
    expect(recoverySrc).toMatch(/cursor = parents\[parents\.length - 1\]/);
    expect(recoverySrc).toMatch(/if \(parents\.length < pageSize\) break;/);
    expect(recoverySrc).not.toMatch(/limit = 200/);
    expect(recoverySrc).not.toMatch(/safety cap/);
  });

  test('a wizard parent carries the QUOTED address itself at activation; the guard never reads a live wizard draft back (r14)', async () => {
    // codex #3504 r14: the wizard draft is REUSED for the customer's next
    // quote (any address). An unstamped primary-address parent whose
    // source is that draft would re-home to whatever was quoted last and
    // strip the legitimate second-property booking.
    // r15: the stamp copies the BOOKED customer row's address (the
    // property the visit was booked at), never the rewritable draft text.
    expect(booking).toMatch(/service_address_line1: bookedCustomerRow\.address_line1,/);
    expect(booking).not.toMatch(/parseEstimateAddress\(lockedDraft\.address\)/);
    expect(booking).toMatch(/if \(!String\(seriesParentRow\.service_address_line1 \|\| ''\)\.trim\(\)\) \{/);
    expect(booking).toMatch(/Object\.assign\(seriesParentRow, addressStamp\)/);
    // Stamp precedes seeding so children inherit it (copyIfPresent).
    expect(booking.indexOf('Object.assign(seriesParentRow, addressStamp)')).toBeLessThan(booking.indexOf('RecurringAppointmentSeeder.seedFollowUpsForParent(trx, seriesParentRow, {'));
    const { sourceEstimateForScope } = require('../services/recurring-appointment-seeder');
    const connFor = (row) => jest.fn(() => ({ where: () => ({ first: async () => row }) }));
    const live = { property_id: 'pB', address: '200 Other St, Venice, FL 34285', source: 'quote_wizard', status: 'draft', archived_at: null };
    expect(await sourceEstimateForScope(connFor(live), 'd1')).toBeNull();
    const archived = { ...live, archived_at: new Date() };
    expect(await sourceEstimateForScope(connFor(archived), 'd1')).toEqual(archived);
    const accepted = { ...live, source: 'website', status: 'accepted' };
    expect(await sourceEstimateForScope(connFor(accepted), 'd1')).toEqual(accepted);
    expect(await sourceEstimateForScope(connFor(null), 'd1')).toBeNull();
    const seeder = fs.readFileSync(path.join(__dirname, '..', 'services', 'recurring-appointment-seeder.js'), 'utf8');
    // Both fallbacks (property id AND address) go through the refusal.
    expect((seeder.match(/await sourceEstimateForScope\(conn, parent\.source_estimate_id\)/g) || []).length).toBe(2);
    expect(seeder).not.toMatch(/where\(\{ id: parent\.source_estimate_id \}\)\.first\('address'\)/);
  });

  test('a parent that cannot extend to the program duration keeps its signed slot AND rings the office bell in-trx (r14)', () => {
    expect(booking).toMatch(/dedupeKey: `wizard-activation-short-slot:\$\{seriesParentRow\.id\}`/);
    expect(booking).toMatch(/notifySeriesOfficeBellInTx = async \(trx, \{ dedupeKey, title, body, metadata, failLabel \}\)/);
    // The strip bell is the same shared helper.
    expect(booking).toMatch(/notifySeriesStripInTx = async \(trx, parentId, reason\) => notifySeriesOfficeBellInTx\(trx, \{/);
  });

  test('the quote-page handoff/link mint and the confirm-time gate share ONE mixed-billing predicate (r18)', () => {
    const { engineSummaryHasMixedBilling } = require('../services/booking-pay-at-visit');
    expect(engineSummaryHasMixedBilling({ recurringAnnual: 900, specialtyTotal: 250 })).toBe(true);
    expect(engineSummaryHasMixedBilling({ recurringAnnual: 900, installationTotal: 400 })).toBe(true);
    expect(engineSummaryHasMixedBilling({ recurringAnnual: 900, oneTimeTotal: 150 })).toBe(true);
    expect(engineSummaryHasMixedBilling({ recurringAnnual: 900 })).toBe(false);
    expect(engineSummaryHasMixedBilling({ oneTimeTotal: 150, specialtyTotal: 250 })).toBe(false);
    const publicQuote = fs.readFileSync(path.join(__dirname, '..', 'routes', 'public-quote.js'), 'utf8');
    expect(publicQuote).toMatch(/function estimateBlocksBookingHandoff\(estimate\) \{\s*\n\s*const \{ engineSummaryHasMixedBilling \} = require\('\.\.\/services\/booking-pay-at-visit'\);\s*\n\s*return engineSummaryHasMixedBilling\(estimate\?\.summary \|\| \{\}\);/);
    const { _internals } = require('../routes/public-quote');
    expect(_internals.estimateBlocksBookingHandoff({ summary: { recurringAnnual: 900, specialtyTotal: 250 } })).toBe(true);
    expect(_internals.estimateBlocksSelfBookLink({ summary: { recurringAnnual: 900, installationTotal: 400 }, lineItems: [] })).toBe(true);
  });

  test('a mixed quote (recurring + specialty/installation add-on) is not self-serve bookable', () => {
    // codex #3504 r12: specialty add-ons ride summary.specialtyTotal, not
    // oneTimeTotal — activating the recurring plan alone would archive
    // the draft with the add-on neither scheduled nor billed.
    const { wizardDraftSelfServeBookable } = require('../services/booking-pay-at-visit');
    const base = (summary) => ({
      source: 'quote_wizard', status: 'draft', archived_at: null,
      estimate_data: { engineResult: { summary, lineItems: [{ service: 'lawn_care', annual: 900 }] } },
    });
    expect(wizardDraftSelfServeBookable(base({ recurringAnnual: 900, oneTimeTotal: 0, specialtyTotal: 0 }))).toBe(true);
    expect(wizardDraftSelfServeBookable(base({ recurringAnnual: 900, oneTimeTotal: 0, specialtyTotal: 350 }))).toBe(false);
    expect(wizardDraftSelfServeBookable(base({ recurringAnnual: 900, oneTimeTotal: 0, installationTotal: 500 }))).toBe(false);
  });

  test('the recovery sweep covers the PEST funnel; a duplicate-kept pest one-off is marked reconciled at kept-time (owner ruling 2026-08-27)', () => {
    const recoverySrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'wizard-series-activation-recovery.js'), 'utf8');
    expect(recoverySrc).not.toMatch(/ypest/);
    expect(recoverySrc).not.toMatch(/familyKey === 'pest_control'/);
    // The locked re-validation re-reads the marker and refuses a stamped row.
    expect(recoverySrc).toMatch(/'source_estimate_generation', 'wizard_recovery_reconciled_at'\);/);
    expect(recoverySrc).toMatch(/\|\| fresh\.wizard_recovery_reconciled_at\s*\n\s*\|\| \['cancelled', 'canceled'\]/);
    // Pre-deploy pest one-offs are backfilled with the marker.
    const backfill = require('../models/migrations/20260827000002_pest_recovery_backfill');
    expect(typeof backfill.up).toBe('function');
    expect(typeof backfill.down).toBe('function');
    const backfillSrc = fs.readFileSync(path.join(__dirname, '..', 'models', 'migrations', '20260827000002_pest_recovery_backfill.js'), 'utf8');
    expect(backfillSrc).toMatch(/hasColumn\('scheduled_services', 'wizard_recovery_reconciled_at'\)/);
    expect(backfillSrc).toMatch(/whereRaw\("COALESCE\(ss\.service_type, ''\) ~\* '\\\\ypest\\\\y'"\)/);
    expect(backfillSrc).toMatch(/whereNotExists\(function child\(\)/);
    // Pest prices as the fixed quarterly-4 plan for the minted-amount proof.
    expect(recoverySrc).toMatch(/const planVisits = family === 'pest_control' \? 4 : resolveWizardSeriesPlan\(freshDraft, planKey\)\?\.visits;/);
    // The kept branch stamps the durable marker so the sweep can tell a
    // deliberate one-off from a crash.
    expect(booking).toMatch(/if \(matches\.length > 0\) \{\s*\n[\s\S]{0,900}wizard_recovery_reconciled_at: trx\.fn\.now\(\),[\s\S]{0,400}return \{ kept: matches\[0\] \};/);
    // Pest seeds a FIXED 4-visit plan, never Ongoing.
    expect(booking).toMatch(/pattern: 'quarterly',\s*\n\s*plannedCount: 4,[\s\S]{0,2200}recurringOngoing: false,\s*\n\s*\}\);/);
    // Auto-extend templates off the per-visit amount for anchored splits.
    const schedule = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    expect(schedule).toMatch(/async function resolveSeriesExtensionPriceTemplate\(conn, parentId, parent\)/);
    expect(schedule).toMatch(/const extensionPriceParent = await resolveSeriesExtensionPriceTemplate\(conn, parentId, parent\);\s*\n\s*applyStoredVisitFinancials\(nextData, cols, extensionPriceParent,/);
    // Every extension writer (auto-extend, top-up, plan-ending extend and
    // convert) templates off the resolver — never the raw parent.
    expect((schedule.match(/applyStoredVisitFinancials\((?:data|nextData), cols, extensionPriceParent,/g) || []).length).toBe(4);
    expect(schedule).not.toMatch(/applyStoredVisitFinancials\(data, cols, parent,/);
    // Explicit provenance only — never inferred from child prices.
    expect(schedule).toMatch(/raw\.anchored_split_per_visit/);
    expect(schedule).not.toMatch(/if \(diff >= 1\) return parent;/);
    const seeder = fs.readFileSync(path.join(__dirname, '..', 'services', 'recurring-appointment-seeder.js'), 'utf8');
    expect(seeder).toMatch(/anchored_split_per_visit: Math\.round\(Number\(opts\.estimatedPrice\) \* 100\) \/ 100/);
    // Duplicate-kept is decided INSIDE the booking transaction and the
    // marker is born with the row; the post-commit seeding is skipped.
    expect(booking).toMatch(/if \(shouldSeedQuarterlyPestFollowUps && !callbackVisit && hasReconciledColumn\) \{\s*\n\s*await trx\('customers'\)\.where\(\{ id: custId \}\)\.forUpdate\(\)\.first\('id'\);/);
    expect(booking).toMatch(/\.\.\.\(pestDuplicateKeptAtBooking \? \{ wizard_recovery_reconciled_at: trx\.fn\.now\(\) \} : \{\}\),/);
    expect(booking).toMatch(/if \(shouldSeedQuarterlyPestFollowUps && !pestDuplicateKeptAtBooking\) \{/);
    expect(booking.indexOf('const shouldSeedQuarterlyPestFollowUps =')).toBeLessThan(booking.indexOf('let txResult;'));
    const backfillSrc2 = fs.readFileSync(path.join(__dirname, '..', 'models', 'migrations', '20260827000002_pest_recovery_backfill.js'), 'utf8');
    // Cent-exact re-derivation from the stored annual + fixed 4-visit
    // plan — never a price-pattern inference.
    expect(backfillSrc2).toMatch(/FLOOR\(annual_cents \/ 4\) AS quotient_cents/);
    expect(backfillSrc2).toMatch(/annual_cents - 3 \* FLOOR\(annual_cents \/ 4\) AS first_cents/);
    expect(backfillSrc2).toMatch(/WHERE s\.parent_cents = s\.first_cents/);
    // The three EARLIEST seeded follow-ups prove the split (lifetime child
    // count irrelevant); unproven Ongoing series are surfaced, not stamped.
    expect(backfillSrc2).toMatch(/ROW_NUMBER\(\) OVER \(PARTITION BY c\.recurring_parent_id ORDER BY c\.scheduled_date ASC/);
    expect(backfillSrc2).toMatch(/JOIN seeded c ON c\.parent_id = s\.parent_id AND c\.rn <= 3/);
    expect(backfillSrc2).toMatch(/HAVING COUNT\(\*\) = 3/);
    expect(backfillSrc2).toMatch(/jsonb_exists\(p\.recurring_template_overrides, 'anchored_split_per_visit'\)/);
    expect(backfillSrc2).not.toMatch(/recurring_template_overrides \? 'anchored_split_per_visit'/);
    expect(backfillSrc2).toMatch(/dedupeKey: 'pest-renewal-price-unverified-20260827'/);
    expect(backfillSrc2).toMatch(/RENEWAL PRICE UNVERIFIED/);
    // The edit lane's merge carries the provenance key across service-only
    // edits and drops it on an explicit price edit; the resolver yields to
    // an explicit price override.
    expect(schedule).toMatch(/const PROVENANCE_OVERRIDE_KEYS = new Set\(\['anchored_split_per_visit'\]\);/);
    expect(schedule).toMatch(/const priceEdit = entries\.some\(\(\[key\]\) => key === 'estimated_price'\);\s*\n\s*const merged = \{ \.\.\.\(priceEdit \? \{\} : provenance\), \.\.\.existing \};/);
    expect(schedule).toMatch(/if \(raw\.estimated_price !== undefined && raw\.estimated_price !== null\) return parent;/);
    expect(backfillSrc2).toMatch(/BOOL_AND\(c\.estimated_price IS NOT NULL AND ROUND\(c\.estimated_price \* 100\) = s\.quotient_cents\)/);
    expect(backfillSrc2).not.toMatch(/< 1\s*\n/);
    expect(backfillSrc2).toMatch(/anchored_split_per_visit/);
  });

  test('the welcome enqueue is check-and-insert ATOMIC under a per-customer advisory lock', () => {
    // codex #3504 r12: a confirmation racing its own replay could both
    // pass hasWelcomeSequence and enqueue two welcome sequences.
    const welcome = fs.readFileSync(path.join(__dirname, '..', 'services', 'new-recurring-welcome-sms.js'), 'utf8');
    expect(welcome).toMatch(/async function hasWelcomeSequence\(customerId, conn = db\)/);
    expect(welcome).toMatch(/pg_advisory_xact_lock\(hashtext\(\?\)\)', \[`new-recurring-welcome:\$\{customer\.id\}`\]\);\s*\n\s*if \(await hasWelcomeSequence\(customer\.id, trx\)\) return 'already_sent';\s*\n\s*await trx\('sms_sequences'\)\.insert\(data\);/);
  });

  test('seeded children reserve the converter DURATION AUTHORITY first, then the catalog default, never the coarse funnel duration', () => {
    // codex #3504 r10+r12: mosquito's funnel books 45min while its catalog
    // row reserves 60; but lawn's catalog default is 45 and CONTRADICTS
    // the 60-minute slot authority (durationMinutesForRecurringService).
    expect(booking).toMatch(/authorityDuration = durationMinutesForRecurringService\(\s*\n\s*\{ service: activationFamilyKey \},/);
    expect(booking).toMatch(/let seededChildDuration = Number\(authorityDuration\) > 0 \? Number\(authorityDuration\) : duration;/);
    expect((booking.match(/if \(!\(Number\(authorityDuration\) > 0\) && Number\((palmCatalogRow|catalogRow)\?\.default_duration_minutes\) > 0\)/g) || []).length).toBe(2);
    const { durationMinutesForRecurringService } = require('../services/estimate-converter');
    expect(durationMinutesForRecurringService({ service: 'lawn_care' }, 'every_6_weeks', { service_type: 'Lawn Care' })).toBe(60);
    expect(durationMinutesForRecurringService({ service: 'tree_shrub' }, 'every_6_weeks', { service_type: 'Tree & Shrub' })).toBe(60);
    expect(booking).toMatch(/durationMinutes: seededChildDuration,/);
    // ...and their window spans that duration instead of inheriting the
    // parent's shorter one.
    expect(booking).toMatch(/childEndMin = timeToMin\(slot_start\) \+ seededChildDuration/);
  });

  test('the generic reminder self-heal registers windowless visits as PRE-CLOSED placeholders', () => {
    // codex #3504 r10: the legacy path converted a null window to an
    // ARMED 08:00 registration — texting a time nobody chose.
    const reminders = fs.readFileSync(path.join(__dirname, '..', 'services', 'appointment-reminders.js'), 'utf8');
    expect(reminders).toMatch(/async insertPreClosedPlaceholderRowInTx\(trx, \{ scheduledServiceId, customerId, apptTime, serviceLabel, source, createdAt \}\)/);
    expect(reminders).toMatch(/if \(!lockedVisit\.window_start\) \{[\s\S]{0,900}insertPreClosedPlaceholderRowInTx\(trx, \{/);
    // registerAppointment's closeReminderWindows path shares the SAME
    // insert (single implementation): the definition + exactly two call
    // sites.
    expect((reminders.match(/insertPreClosedPlaceholderRowInTx\(trx, \{/g) || []).length).toBe(3);
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
    expect(booking).toMatch(/const replaySeeded = replayActivation\?\.seedResult\?\.insertedRows \|\| \[\];[\s\S]{0,1800}sendConfirmation: false,\s*\n\s*\.\.\.\(windowless \? \{ closeReminderWindows: true \} : \{\}\)/);
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
    expect(booking).toMatch(/durationMinutes: seededChildDuration,[\s\S]{0,1600}source: source \|\| 'self_booked',[\s\S]{0,1200}recurringOngoing: false,/);
    // The seeder honors the flag on both the parent mark and the children.
    const seeder = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'recurring-appointment-seeder.js'), 'utf8');
    expect(seeder.match(/recurring_ongoing: opts\.recurringOngoing !== false/g).length).toBeGreaterThanOrEqual(2);
  });

  test('fee-exempt seeded bookings still correlate the parent and retire the draft', () => {
    expect(booking).toMatch(/whereNull\('source_estimate_id'\)\s*\n\s*\.update\(\{ source_estimate_id: pricing_estimate_id/);
    expect(booking).toMatch(/source: 'quote_wizard', status: 'draft' \}\)\s*\n\s*\.whereNull\('archived_at'\)/);
  });
});
