// ============================================================
// test-engine.js — Verify all pricing calculations
// ============================================================
const { generateEstimate, quickQuote } = require('./estimate-engine');
const { pricePestControl, priceLawnCare, priceTreeShrub, pricePalmInjection,
        priceMosquito, priceTermiteBait, priceRodentBait, priceRodentTrapping,
        priceOneTimePest, priceBoraCare, priceGermanRoach, priceBedBug,
        priceWDO, priceTrenching, priceTopDressing, priceDethatching } = require('./service-pricing');
const { calculatePropertyProfile } = require('./property-calculator');
const { determineWaveGuardTier, getEffectiveDiscount } = require('./discount-engine');
const { ZONES } = require('./constants');
const { zoneMultiplier } = require('./modifiers');

const fmt = (n) => typeof n === 'number' ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}` : n;
const pct = (n) => typeof n === 'number' ? `${(n * 100).toFixed(1)}%` : n;

console.log('═'.repeat(70));
console.log('WAVES PRICING ENGINE — FULL TEST SUITE');
console.log('═'.repeat(70));

// Reference property
const refProperty = calculatePropertyProfile({
  homeSqFt: 2000, stories: 1, lotSqFt: 10000,
  propertyType: 'single_family',
  lawnSqFt: 4500, bedArea: 2000,
  features: { poolCage: true, shrubs: 'moderate', trees: 'moderate', complexity: 'standard' },
});

console.log('\n── REFERENCE PROPERTY ──');
console.log(`  Footprint: ${refProperty.footprint} sqft`);
console.log(`  Lawn: ${refProperty.lawnSqFt} sqft | Beds: ${refProperty.bedArea} sqft`);
console.log(`  Perimeter: ${refProperty.perimeter} ft | Lot: ${refProperty.lotCategory}`);

// ── PEST CONTROL ──
console.log('\n' + '─'.repeat(70));
console.log('PEST CONTROL');
console.log('─'.repeat(70));
for (const [ver, freq] of [['v1','quarterly'],['v1','bimonthly'],['v1','monthly'],['v2','bimonthly'],['v2','monthly']]) {
  const r = pricePestControl(refProperty, { frequency: freq, pricingVersion: ver });
  console.log(`  ${ver} ${freq.padEnd(10)} | Per-app: ${fmt(r.perApp).padStart(7)} | Annual: ${fmt(r.annual).padStart(8)} | Mo: ${fmt(r.monthly).padStart(8)} | Margin: ${pct(r.margin)}`);
}

// ── LAWN CARE ──
console.log('\n' + '─'.repeat(70));
console.log('LAWN CARE (St. Augustine, 4,500 sqft)');
console.log('─'.repeat(70));
for (const tier of ['basic', 'standard', 'enhanced', 'premium']) {
  const r = priceLawnCare(refProperty, { track: 'st_augustine', tier });
  console.log(`  ${tier.padEnd(10)} | Mo: ${fmt(r.monthly).padStart(5)} | Annual: ${fmt(r.annual).padStart(7)} | Cost: ${fmt(r.costs.total).padStart(6)} | Margin: ${pct(r.margin)} ${r.marginFloorOk ? '✓' : '⚠ BELOW FLOOR'}`);
}
console.log('  --- Other tracks (Enhanced) ---');
for (const track of ['bermuda', 'zoysia', 'bahia']) {
  const r = priceLawnCare(refProperty, { track, tier: 'enhanced' });
  console.log(`  ${track.padEnd(14)} | Mo: ${fmt(r.monthly).padStart(5)} | Annual: ${fmt(r.annual).padStart(7)} | Margin: ${pct(r.margin)}`);
}
console.log('  --- Shade modifier (St. Aug) ---');
for (const shade of ['FULL_SUN', 'MODERATE_SHADE', 'HEAVY_SHADE']) {
  const r = priceLawnCare(refProperty, { track: 'st_augustine', tier: 'enhanced', shadeClassification: shade });
  console.log(`  ${shade.padEnd(16)} | Cost: ${fmt(r.costs.total).padStart(6)} | Margin: ${pct(r.margin)}`);
}

// ── TREE & SHRUB ──
console.log('\n' + '─'.repeat(70));
console.log('TREE & SHRUB (2,000 sqft beds, 5 trees)');
console.log('─'.repeat(70));
for (const tier of ['standard', 'enhanced', 'premium']) {
  const r = priceTreeShrub(refProperty, { tier, treeCount: 5 });
  console.log(`  ${tier.padEnd(10)} | Mo: ${fmt(r.monthly).padStart(8)} | Annual: ${fmt(r.annual).padStart(8)} | Cost: ${fmt(r.costs.total).padStart(6)} | Margin: ${pct(r.margin)}`);
}

// ── PALM INJECTION ──
console.log('\n' + '─'.repeat(70));
console.log('PALM INJECTION (3 palms)');
console.log('─'.repeat(70));
for (const tt of ['nutrition', 'insecticide', 'combo', 'fungal', 'lethalBronzing']) {
  const r = pricePalmInjection(refProperty, { palmCount: 3, treatmentType: tt });
  console.log(`  ${r.treatmentType.padEnd(16)} | Per palm: ${fmt(r.pricePerPalm).padStart(6)} | Annual: ${fmt(r.annual).padStart(7)} | Mo: ${fmt(r.monthly).padStart(7)}`);
}

// ── MOSQUITO ──
console.log('\n' + '─'.repeat(70));
console.log('MOSQUITO (Small lot, pool+mod trees)');
console.log('─'.repeat(70));
for (const tier of ['bronze', 'silver', 'gold', 'platinum']) {
  const r = priceMosquito(refProperty, { tier });
  console.log(`  ${tier.padEnd(10)} | Visit: ${fmt(r.perVisit).padStart(6)} × ${r.visits} = Annual: ${fmt(r.annual).padStart(7)} | Margin: ${pct(r.margin)}`);
}

// ── TERMITE ──
console.log('\n' + '─'.repeat(70));
console.log('TERMITE BAIT (2,000 sqft footprint)');
console.log('─'.repeat(70));
const termR = priceTermiteBait(refProperty, { system: 'trelona', monitoringTier: 'basic' });
console.log(`  Stations: ${termR.stations} | Install: ${fmt(termR.installation.price)} (margin: ${pct(termR.installation.margin)})`);
console.log(`  Basic monitoring: ${fmt(termR.monitoring.monthly)}/mo = ${fmt(termR.monitoring.annual)}/yr`);

// ── RODENT ──
console.log('\n' + '─'.repeat(70));
console.log('RODENT BAIT');
console.log('─'.repeat(70));
const rodR = priceRodentBait(refProperty);
console.log(`  Score: ${rodR.score} → ${rodR.size} | ${fmt(rodR.monthly)}/mo = ${fmt(rodR.annual)}/yr | Margin: ${pct(rodR.margin)}`);

// ── ONE-TIME SERVICES ──
console.log('\n' + '─'.repeat(70));
console.log('ONE-TIME & SPECIALTY');
console.log('─'.repeat(70));
const otPest = priceOneTimePest(refProperty, { isRecurringCustomer: false });
const otPestRec = priceOneTimePest(refProperty, { isRecurringCustomer: true });
console.log(`  One-time pest (non-recurring): ${fmt(otPest.price)}`);
console.log(`  One-time pest (recurring cust): ${fmt(otPestRec.price)}`);
const otPestUrg = priceOneTimePest(refProperty, { urgency: 'URGENT' });
console.log(`  One-time pest (URGENT):         ${fmt(otPestUrg.price)}`);

const trenchR = priceTrenching(refProperty);
console.log(`  Trenching: ${fmt(trenchR.price)} (${trenchR.dirtLF}ft dirt + ${trenchR.concreteLF}ft concrete)`);

const bcR = priceBoraCare(2000);
console.log(`  Bora-Care (2,000 sqft attic): ${fmt(bcR.price)}`);

const grR = priceGermanRoach(refProperty);
console.log(`  German Roach (3-visit): ${fmt(grR.total)} (${fmt(grR.price)} + ${fmt(grR.setupCharge)} setup)`);

const bbChem = priceBedBug(2, 'chemical', 2000);
const bbHeat = priceBedBug(2, 'heat', 2000);
console.log(`  Bed Bug 2-room chemical: ${fmt(bbChem.price)} | heat: ${fmt(bbHeat.price)}`);

const wdoR = priceWDO(2000);
console.log(`  WDO Inspection (2,000 sqft): ${fmt(wdoR.price)}`);

const tdR = priceTopDressing(4500, 'eighth', true);
console.log(`  Top Dressing 1/8" (4,500 sqft): ${fmt(tdR.price)}`);

const dtR = priceDethatching(4500);
console.log(`  Dethatching (4,500 sqft): ${fmt(dtR.price)}`);

// ── WAVEGUARD TIER DETERMINATION ──
console.log('\n' + '─'.repeat(70));
console.log('WAVEGUARD TIER TESTS');
console.log('─'.repeat(70));
const tests = [
  { services: ['pest_control'], expected: 'bronze' },
  { services: ['pest_control', 'lawn_care'], expected: 'silver' },
  { services: ['pest_control', 'lawn_care', 'mosquito'], expected: 'gold' },
  { services: ['pest_control', 'lawn_care', 'tree_shrub', 'mosquito'], expected: 'platinum' },
  // Palm does NOT count toward tier
  { services: ['pest_control', 'lawn_care'], note: '+ palm (non-qualifier)', expected: 'silver' },
];
for (const t of tests) {
  const tier = determineWaveGuardTier(t.services);
  const pass = tier.tier === t.expected;
  console.log(`  ${pass ? '✓' : '✗'} ${t.services.join(' + ')}${t.note ? ' ' + t.note : ''} → ${tier.tier} (${tier.qualifyingCount} qualifying) ${pass ? '' : `EXPECTED ${t.expected}`}`);
}

// ── DISCOUNT ENGINE TESTS ──
console.log('\n' + '─'.repeat(70));
console.log('DISCOUNT ENGINE TESTS');
console.log('─'.repeat(70));
const goldTier = determineWaveGuardTier(['pest_control', 'lawn_care', 'mosquito']);
const platTier = determineWaveGuardTier(['pest_control', 'lawn_care', 'tree_shrub', 'mosquito']);

// Normal recurring service at Gold
let disc = getEffectiveDiscount('pest_control', goldTier);
console.log(`  Pest @ Gold: ${pct(disc.effectiveDiscount)} discount`);

// Lawn Enhanced at Platinum (Session 6: full 20%, no cap)
disc = getEffectiveDiscount('lawn_care_enhanced', platTier);
console.log(`  Lawn Enhanced @ Platinum: ${pct(disc.effectiveDiscount)} (should be 20%, no cap)`);

// Rodent (excluded from %)
disc = getEffectiveDiscount('rodent_bait', goldTier);
console.log(`  Rodent Bait @ Gold: ${pct(disc.effectiveDiscount)} discount (should be 0%) + setup credit: $${disc.setupCredit || 0}`);

// Palm (excluded, flat credit)
disc = getEffectiveDiscount('palm_injection', goldTier);
console.log(`  Palm @ Gold: ${pct(disc.effectiveDiscount)} + flat credit: $${disc.flatCredit || 0}/palm/yr`);

// Recurring customer one-time perk
disc = getEffectiveDiscount('one_time_pest', goldTier, {
  isOneTimeService: true, isRecurringCustomer: true,
});
console.log(`  One-time pest, recurring customer @ Gold: ${pct(disc.effectiveDiscount)} perk (no tier stacking)`);

// One-time, non-recurring customer (no discount)
disc = getEffectiveDiscount('one_time_pest', goldTier, { isOneTimeService: true, isRecurringCustomer: false });
console.log(`  One-time pest, non-recurring @ Gold: ${pct(disc.effectiveDiscount)} (should be 0%)`);

// ── FULL ESTIMATE ──
console.log('\n' + '═'.repeat(70));
console.log('FULL ESTIMATE — REFERENCE CUSTOMER');
console.log('═'.repeat(70));
const estimate = generateEstimate({
  homeSqFt: 2000, stories: 1, lotSqFt: 10000,
  propertyType: 'single_family',
  lawnSqFt: 4500, bedArea: 2000,
  zone: 'A',
  features: { poolCage: true, shrubs: 'moderate', trees: 'moderate' },
  paymentMethod: 'card',
  services: {
    pest: { frequency: 'quarterly', version: 'v1' },
    lawn: { track: 'st_augustine', tier: 'enhanced' },
    treeShrub: { tier: 'enhanced', treeCount: 5 },
    mosquito: { tier: 'silver' },
  },
});

console.log(`\n  WaveGuard Tier: ${estimate.waveGuard.tier.toUpperCase()} (${estimate.waveGuard.qualifyingCount} services)`);
console.log(`  Active: ${estimate.waveGuard.activeServices.join(', ')}\n`);

console.log('  SERVICE LINE BREAKDOWN:');
for (const item of estimate.lineItems) {
  if (item.annual) {
    const before = item.annualBeforeDiscount || item.annual;
    const after = item.annualAfterDiscount || item.annual;
    const discPct = item.discount ? pct(item.discount.effectiveDiscount) : '0%';
    console.log(`    ${item.service.padEnd(20)} | ${fmt(before).padStart(8)}/yr → ${fmt(after).padStart(8)}/yr (${discPct} off) | ${fmt(item.monthlyAfterDiscount || item.monthly).padStart(7)}/mo`);
  } else if (item.price) {
    console.log(`    ${item.service.padEnd(20)} | ${fmt(item.priceAfterDiscount || item.price)}`);
  }
}

console.log('\n  TOTALS:');
console.log(`    Recurring annual (before):  ${fmt(estimate.summary.recurringAnnualBeforeDiscount)}`);
console.log(`    WaveGuard savings:          ${fmt(estimate.summary.waveGuardSavings)}`);
console.log(`    Recurring annual (after):   ${fmt(estimate.summary.recurringAnnualAfterDiscount)}`);
console.log(`    Recurring monthly:          ${fmt(estimate.summary.recurringMonthlyAfterDiscount)}`);
console.log(`    Year 1 total:               ${fmt(estimate.summary.year1Total)}`);
console.log(`    Year 2+ annual:             ${fmt(estimate.summary.year2Annual)}`);

if (estimate.marginWarnings.length > 0) {
  console.log('\n  ⚠ MARGIN WARNINGS:');
  for (const w of estimate.marginWarnings) {
    console.log(`    ${w.message}`);
  }
}

// ACH estimate
console.log('\n  --- Same estimate with ACH payment ---');
const achEstimate = generateEstimate({
  ...{
    homeSqFt: 2000, stories: 1, lotSqFt: 10000,
    propertyType: 'single_family', lawnSqFt: 4500, bedArea: 2000,
    zone: 'A', features: { poolCage: true, shrubs: 'moderate', trees: 'moderate' },
    services: {
      pest: { frequency: 'quarterly', version: 'v1' },
      lawn: { track: 'st_augustine', tier: 'enhanced' },
      treeShrub: { tier: 'enhanced', treeCount: 5 },
      mosquito: { tier: 'silver' },
    },
  },
  paymentMethod: 'us_bank_account',
});
console.log(`    Card monthly:  ${fmt(estimate.summary.recurringMonthlyAfterDiscount)}`);
console.log(`    ACH monthly:   ${fmt(achEstimate.summary.recurringMonthlyAfterDiscount)}`);
console.log(`    ACH savings:   ${fmt(achEstimate.achSavings)}/yr`);

// ── ZONE MULTIPLIER REGRESSION ────────────────────────────────
// Session 6 pre-work: insurance against the Session 3 bug class where
// constants.ZONES and modifiers.zoneMultiplier() drifted apart. The
// startup assertion in estimate-engine.js only covers A/B/C/D — this
// block exposes UNKNOWN and any default-case divergence.
console.log('\n' + '═'.repeat(70));
console.log('ZONE MULTIPLIER ALIGNMENT (constants.ZONES vs modifiers.zoneMultiplier)');
console.log('═'.repeat(70));
for (const z of ['A', 'B', 'C', 'D', 'UNKNOWN']) {
  const c = ZONES[z]?.multiplier;
  const m = zoneMultiplier(z);
  const aligned = typeof c === 'number' && Math.abs(c - m) < 0.0001;
  console.log(`  ${z.padEnd(8)} | constants: ${c ?? 'MISSING'} | modifiers: ${m} ${aligned ? '✓' : '⚠ DRIFT'}`);
}
// Also exercise the actual engine path with zone='UNKNOWN' — ref customer,
// v1 quarterly pest only. Output should be a stable number we can eyeball
// across releases. When Session 6 lands, re-run and compare.
const unknownRef = generateEstimate({
  homeSqFt: 2000, stories: 1, lotSqFt: 10000,
  propertyType: 'single_family', lawnSqFt: 4500, bedArea: 2000,
  zone: 'UNKNOWN',
  features: { poolCage: true, shrubs: 'moderate', trees: 'moderate' },
  services: { pest: { frequency: 'quarterly', version: 'v1' } },
});
console.log(`\n  Ref customer, zone=UNKNOWN, v1 pest quarterly:`);
console.log(`    engine zone.multiplier: ${unknownRef.zone.multiplier}`);
console.log(`    recurring monthly:      ${fmt(unknownRef.summary.recurringMonthlyAfterDiscount)}`);

console.log('\n' + '═'.repeat(70));
console.log('ALL TESTS COMPLETE');
console.log('═'.repeat(70));
