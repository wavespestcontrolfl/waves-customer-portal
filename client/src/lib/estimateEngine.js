/**
 * @deprecated Since 2026-04-15. Use `pricingEngineClient.js` for new code.
 *   It calls POST /admin/pricing-config/estimate which runs the modular
 *   server engine (pricing-engine/) with live DB-synced constants edited
 *   via 📐 Pricing Logic.
 *
 * This file remains ONLY because EstimatePage.jsx + EstimateViewPage.jsx
 * consume its synchronous flat-return shape. Migration blocker:
 *   - Convert both pages to async (server roundtrip).
 *   - Or add a result-shape adapter in pricingEngineClient to emit the
 *     same fields (monthly, annual, perVisit, etc. per service block).
 *
 * DO NOT add new pricing features here. Add them to
 * server/services/pricing-engine/ and let the shim surface them.
 *
 * Waves Pest Control — Estimate Calculation Engine v1.5
 * Ported from waves-estimator.html weCalculate() function.
 * Pure calculation — no DOM, no side effects.
 *
 * v1.5 changes:
 * - Tree & Shrub: bed area cap raised 8k→12k, access difficulty modifier (+8/+15 min)
 * - Palm Injection: prefers manual injectable count, flags when estimated
 * - Mosquito: irrigation modifier (+0.08 pressure), cap raised 1.50→1.60
 * - Rodent Bait: matrix scoring (footprint + lot + water + trees) replaces OR logic
 * - One-Time Lawn: higher standalone fungicide base ($95 floor vs $73)
 * - Trenching: concrete cap raised 0.50→0.60 for full-cage + 3-car garage
 * - Bora-Care: multi-day pricing for 4,500+ sf attics, labor cap raised 6→10 hrs
 * - Bed Bug Heat: equipment cost for in-house treatments ($150 + $75/extra room)
 *
 * v1.4 changes:
 * - Split roach modifier: Regular 10%, German 25% (was both 15%)
 * - Tiered hardscape marginal: 3% up to 15k, 5% above (was flat 3%)
 * - Fungicide multiplier: 1.55 (was 1.38)
 * - Margin floor check at 35% for WaveGuard tiers
 * - Tier commitment data for billing reconciliation
 */

/* ── helpers ────────────────────────────────────────────────── */

export function interpolate(v, b) {
  if (v <= b[0].at) return b[0].adj;
  if (v >= b[b.length - 1].at) return b[b.length - 1].adj;
  for (let i = 1; i < b.length; i++) {
    if (v <= b[i].at) {
      return b[i - 1].adj;
    }
  }
  return 0;
}

export function fmt(n) {
  if (n === undefined || n === null || isNaN(n)) return '$0.00';
  return '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtInt(n) {
  if (n === undefined || n === null || isNaN(n)) return '$0';
  return '$' + Math.round(Number(n)).toLocaleString();
}

/* ── main engine ────────────────────────────────────────────── */

export function calculateEstimate(inputs) {
  const {
    homeSqFt: _homeSqFt,
    stories: _stories,
    lotSqFt: _lotSqFt,
    propertyType,
    hasPool,
    hasPoolCage,
    hasLargeDriveway,
    indoor,
    shrubDensity,
    treeDensity,
    landscapeComplexity,
    nearWater,
    urgency,
    isAfterHours,
    isRecurringCustomer: isRC,
    bedArea: _bedArea,
    palmCount: _palmCount,
    treeCount: _treeCount,
    roachModifier: roachMod,
    pestFreq: _pestFreq,
    plugArea: _plugArea,
    plugSpacing: _plugSpacing,
    grassType: _grassType,
    otLawnType,
    exclSimple: exS,
    exclModerate: exM,
    exclAdvanced: exA,
    exclWaive: exW,
    bedbugRooms: _bedbugRooms,
    bedbugMethod,
    boracareSqft: bcSqft,
    preslabSqft: psSqft,
    preslabWarranty,
    preslabVolume,
    foamPoints: _foamPoints,
    roachType,
    // Service selections (booleans)
    svcLawn,
    svcPest,
    svcTs,
    svcInjection,
    svcMosquito,
    svcTermiteBait,
    svcRodentBait,
    svcOnetimePest,
    svcOnetimeLawn,
    svcOnetimeMosquito,
    svcPlugging,
    svcTopdress,
    svcDethatch,
    svcTrenching,
    svcBoracare,
    svcPreslab,
    svcFoam,
    svcRodentTrap,
    svcFlea,
    svcWasp,
    svcRoach,
    svcBedbug,
    svcExclusion,
    // v1.5 inputs
    accessDifficulty,   // 'EASY' | 'MODERATE' | 'DIFFICULT' — gate access, narrow side yards
    hasIrrigation,      // boolean — extensive irrigation creates standing water
    injectablePalms: _injectablePalms, // manual override for injectable palm count
    bedbugEquipment,    // 'SUBCONTRACT' | 'INHOUSE' — heat treatment equipment source
  } = inputs;

  const homeSqFt = Number(_homeSqFt) || 0;
  const stories = Math.max(1, Number(_stories) || 1);
  const lotSqFt = Number(_lotSqFt) || 0;
  const bedArea = Number(_bedArea) || 0;
  const palmCount = Number(_palmCount) || 0;
  const treeCount = Number(_treeCount) || 0;
  const pestFreq = Number(_pestFreq) || 4;
  const plugArea = Math.max(0, Number(_plugArea) || 0);
  const plugSpacing = Number(_plugSpacing) || 12;
  const bedbugRooms = Number(_bedbugRooms) || 1;
  const fmPts = Number(_foamPoints) || 5;
  // Backward compat: map old track letters to new keys
  const TRACK_MAP = { A: 'st_augustine', B: 'st_augustine', C1: 'bermuda', C2: 'zoysia', D: 'bahia' };
  const grassType = TRACK_MAP[_grassType] || _grassType || 'st_augustine';

  const LABOR = 35, DRIVE = 20;
  const footprint = homeSqFt > 0 ? Math.round(homeSqFt / stories) : 0;
  const treeNum = treeDensity === 'HEAVY' ? 2 : treeDensity === 'MODERATE' ? 1 : 0;

  if (homeSqFt <= 0 && lotSqFt <= 0) {
    return { error: 'Enter home sq ft or lot size.' };
  }

  /* ── urgency multiplier ──────────────────────────────────── */
  let urgMult = 1.0, urgLabel = '';
  if (urgency === 'SOON') {
    urgMult = isAfterHours ? 1.50 : 1.25;
    urgLabel = isAfterHours ? 'Soon+AH (+50%)' : 'Soon (+25%)';
  } else if (urgency === 'URGENT') {
    urgMult = isAfterHours ? 2.0 : 1.50;
    urgLabel = isAfterHours ? 'Emerg AH (+100%)' : 'Emergency (+50%)';
  }

  const rD = isRC ? 0.85 : 1.0;
  function otP(b) { return Math.round(b * urgMult * rD); }

  /* ── field verify tracking ───────────────────────────────── */
  let fieldVerify = [];
  const bedAreaIsEstimated = !bedArea;
  // atticIsEstimated flag — caller can pass boracareSqftAuto if needed;
  // for now we assume auto-estimated when boracareSqft was auto-filled
  const atticIsEstimated = inputs.boracareSqftAuto || false;

  let R = {}, wgServices = [];

  /* ── pricing modifiers tracking ─────────────────────────── */
  const modifiers = [];
  const addMod = (service, label, impact, type = 'info') => modifiers.push({ service, label, impact, type });

  // Track ALL property-level modifiers with dollar amounts
  addMod('property', `Home: ${homeSqFt.toLocaleString()} sq ft · ${stories} story`, 0, 'info');
  addMod('property', `Footprint: ${footprint.toLocaleString()} sq ft`, 0, 'info');
  addMod('property', `Lot: ${lotSqFt.toLocaleString()} sq ft`, 0, 'info');

  // Footprint impact — based on actual chemical cost + labor data
  const fpAdj = interpolate(footprint, [
    { at: 800, adj: -15 }, { at: 1200, adj: -10 }, { at: 1500, adj: -5 },
    { at: 2000, adj: 0 }, { at: 2500, adj: 8 }, { at: 3000, adj: 14 },
    { at: 4000, adj: 22 }, { at: 5500, adj: 32 },
  ]);
  addMod('pest', `Footprint: ${footprint.toLocaleString()} sq ft → ${fpAdj >= 0 ? '+' : ''}$${fpAdj}/visit`, fpAdj, fpAdj > 0 ? 'up' : fpAdj < 0 ? 'down' : 'info');


  // Pool
  if (hasPoolCage) addMod('pest', 'Pool cage: +$10/visit', 10, 'up');
  else if (hasPool) addMod('pest', 'Pool (no cage): +$5/visit', 5, 'up');
  else addMod('pest', 'No pool: $0/visit', 0, 'info');

  // Shrubs
  if (shrubDensity === 'HEAVY') addMod('pest', 'Heavy shrubs: +$12/visit', 12, 'up');
  else if (shrubDensity === 'MODERATE') addMod('pest', 'Moderate shrubs: +$5/visit', 5, 'up');
  else addMod('pest', 'No/light shrubs: $0/visit', 0, 'info');

  // Trees
  if (treeDensity === 'HEAVY') addMod('pest', 'Heavy trees: +$12/visit', 12, 'up');
  else if (treeDensity === 'MODERATE') addMod('pest', 'Moderate trees: +$5/visit', 5, 'up');
  else addMod('pest', 'No/light trees: $0/visit', 0, 'info');

  // Complexity
  if (landscapeComplexity === 'COMPLEX') addMod('pest', 'Complex landscape: +$8/visit', 8, 'up');
  else addMod('pest', `${landscapeComplexity || 'Simple'} landscape: $0/visit`, 0, 'info');

  // Water proximity
  const waterAdj = (nearWater && nearWater !== 'NONE' && nearWater !== 'NO' && nearWater !== false) ? 5 : 0;
  if (waterAdj > 0) addMod('pest', `Near water: +$5/visit`, waterAdj, 'up');
  else addMod('pest', 'No water nearby: $0/visit', 0, 'info');

  // Driveway
  if (hasLargeDriveway) addMod('pest', 'Large driveway: +$5/visit', 5, 'up');
  else addMod('pest', 'Standard driveway: $0/visit', 0, 'info');

  // Indoor treatment
  if (indoor) addMod('pest', 'Indoor treatment: +$15/visit', 15, 'up');
  else addMod('pest', 'Exterior only: $0/visit', 0, 'info');

  // Urgency
  if (urgency === 'SOON') addMod('one-time', `Urgency (Soon): +25%`, 25, 'up');
  else if (urgency === 'URGENT') addMod('one-time', `Urgency (Emergency): +50%`, 50, 'up');
  else addMod('one-time', 'Routine service: standard pricing', 0, 'info');

  // Property type adjustment
  const ptLower = (propertyType || '').toLowerCase();
  let propTypeAdj = 0;
  let propTypeLabel = 'Single Family';
  if (ptLower.includes('townhome') || ptLower.includes('town home') || ptLower.includes('townhouse')) {
    if (ptLower.includes('interior') || ptLower.includes('inner')) { propTypeAdj = -12; propTypeLabel = 'Townhome (interior)'; }
    else { propTypeAdj = -8; propTypeLabel = 'Townhome (end unit)'; }
  } else if (ptLower.includes('duplex')) { propTypeAdj = -10; propTypeLabel = 'Duplex'; }
  else if (ptLower.includes('condo')) {
    if (ptLower.includes('upper') || ptLower.includes('2nd') || ptLower.includes('3rd') || stories > 1) { propTypeAdj = -22; propTypeLabel = 'Condo (upper floor)'; }
    else { propTypeAdj = -18; propTypeLabel = 'Condo (ground floor)'; }
  }
  addMod('pest', `${propTypeLabel}: ${propTypeAdj >= 0 ? '+' : ''}$${propTypeAdj}/visit`, propTypeAdj, propTypeAdj < 0 ? 'down' : 'info');

  // Recurring customer
  if (isRC) addMod('one-time', 'Recurring customer: -15% one-time services', null, 'down');

  // Roach modifier — German is far more labor-intensive (gel bait, IGR, monitoring, callbacks)
  if (roachMod === 'GERMAN') addMod('pest', 'Roach modifier (German): +25%/visit', null, 'up');
  else if (roachMod === 'REGULAR') addMod('pest', 'Roach modifier (American/Smoky Brown): +10%/visit', null, 'up');

  /* ═══════════ RECURRING ═══════════ */
  let hasRec = false;

  /* ── LAWN ────────────────────────────────────────────────── */
  if (svcLawn && lotSqFt > 0) {
    hasRec = true;

    // ── Hardscape: fixed base + marginal % of excess lot beyond 7,500 sf ──
    const pt = (propertyType || '').toLowerCase();
    let hardscape = 0;
    if (pt.includes('commercial')) {
      hardscape = Math.round(lotSqFt * 0.15);
    } else {
      let base = 800;
      if (pt.includes('town') || pt.includes('duplex')) {
        hardscape = 400 + Math.max(0, Math.round((lotSqFt - 7500) * 0.02));
      } else if (pt.includes('condo')) {
        hardscape = 200 + Math.max(0, Math.round((lotSqFt - 7500) * 0.05));
      } else {
        // Tiered marginal: 3% up to 15k, 5% above — tracks better on larger LWR estate lots
        const tier1 = Math.max(0, Math.min(lotSqFt, 15000) - 7500) * 0.03;
        const tier2 = Math.max(0, lotSqFt - 15000) * 0.05;
        hardscape = base + Math.round(tier1 + tier2);
      }
    }
    // Fixed deductions for features (not percentage-based)
    if (hasPoolCage) hardscape += 600;
    else if (hasPool) hardscape += 450;
    if (hasLargeDriveway) hardscape += 300;

    const oa = Math.max(0, Math.round(lotSqFt - footprint - hardscape));

    // ── Complexity score ──
    let sc = 0;
    if (hasPool) sc += 2;
    if (hasPoolCage) sc += 2;
    if (hasLargeDriveway) sc += 2;
    if (shrubDensity === 'MODERATE') sc += 1; else if (shrubDensity === 'HEAVY') sc += 2;
    if (treeDensity === 'MODERATE') sc += 1; else if (treeDensity === 'HEAVY') sc += 2;
    if (landscapeComplexity === 'MODERATE') sc += 1; else if (landscapeComplexity === 'COMPLEX') sc += 2;
    // Bed coverage estimate from bed area ratio
    if (bedArea > 0 && lotSqFt > 0) {
      const bedRatio = bedArea / lotSqFt;
      if (bedRatio >= 0.20) sc += 3;
      else if (bedRatio >= 0.10) sc += 1;
    }

    // ── Smoothed turf factor (~5% per point) ──
    const tfTable = [0.78, 0.73, 0.68, 0.63, 0.58, 0.53, 0.48, 0.43, 0.38, 0.33];
    const tf = tfTable[Math.min(sc, 9)];
    const lsf = Math.round(oa * tf);

    // ── Track-based pricing lookup (from Lawn_Pricing_v4_TimeScaled) ──
    const LAWN_PRICES = {
      st_augustine: { name: 'St. Augustine', pts: [[0,35,45,55,65],[3000,35,45,55,65],[3500,35,45,55,68],[4000,35,45,55,73],[5000,35,45,59,84],[6000,35,46,66,96],[7000,38,50,73,107],[8000,41,55,80,118],[10000,47,64,94,140],[12000,54,73,109,162],[15000,63,86,130,195],[20000,80,108,165,250]] },
      bermuda:      { name: 'Bermuda',       pts: [[0,40,50,60,75],[4000,40,50,60,75],[5000,40,50,60,86],[6000,40,50,67,97],[7000,40,51,74,108],[8000,42,56,82,120],[10000,48,65,96,142],[12000,55,74,111,165],[15000,65,88,132,199],[20000,81,111,169,256]] },
      zoysia:       { name: 'Zoysia',        pts: [[0,40,50,60,75],[4000,40,50,60,75],[5000,40,50,61,87],[6000,40,50,68,98],[7000,40,52,75,110],[8000,42,56,83,121],[10000,49,66,97,144],[12000,56,75,112,167],[15000,66,89,134,202],[20000,83,112,171,259]] },
      bahia:        { name: 'Bahia',         pts: [[0,30,40,50,60],[3000,30,40,50,60],[3500,30,40,50,63],[4000,30,40,50,68],[5000,30,40,55,78],[6000,32,42,61,87],[7000,35,46,67,97],[8000,37,50,73,107],[10000,43,58,86,126],[12000,48,66,98,145],[15000,57,77,117,174],[20000,71,97,148,223]] },
    };
    const lp = LAWN_PRICES[grassType] || LAWN_PRICES.st_augustine;

    function lawnLookup(sf, freqIdx) {
      const pts = lp.pts;
      if (sf >= pts[pts.length - 1][0]) return pts[pts.length - 1][freqIdx + 1];
      for (let i = 1; i < pts.length; i++) {
        if (sf <= pts[i][0]) return pts[i - 1][freqIdx + 1];
      }
      return pts[pts.length - 1][freqIdx + 1];
    }

    const freqs = [
      { name: '4x/yr', v: 4 },
      { name: '6x/yr', v: 6 },
      { name: '9x/yr', v: 9 },
      { name: '12x/yr', v: 12 },
    ];
    R.lawn = [];
    freqs.forEach((f, i) => {
      const mo = lawnLookup(lsf, i);
      const ann = mo * 12;
      const pa = Math.round(ann / f.v * 100) / 100;
      const rec = i === 2, dim = i !== 2;
      R.lawn.push({ pa, v: f.v, ann, mo, name: f.name, recommended: rec, dimmed: dim });
    });
    wgServices.push({ name: 'Lawn Care', mo: R.lawn[2].mo });
    R.lawnMeta = { lsf, sc, tf, oa, grassType, grassName: lp.name, hardscape };
  }

  /* ── PEST — multi-frequency ──────────────────────────────── */
  if (svcPest) {
    hasRec = true;
    const fpEff = footprint > 0 ? footprint : 2500; // default SWFL home fallback when sqft unknown
    let adj = 0;
    adj += interpolate(fpEff, [
      { at: 800, adj: -15 }, { at: 1200, adj: -10 }, { at: 1500, adj: -5 },
      { at: 2000, adj: 0 }, { at: 2500, adj: 8 }, { at: 3000, adj: 14 },
      { at: 4000, adj: 22 }, { at: 5500, adj: 32 },
    ]);
    if (shrubDensity === 'MODERATE') adj += 5;
    else if (shrubDensity === 'HEAVY') adj += 12;
    if (hasPoolCage) adj += 10;
    else if (hasPool) adj += 5;
    if (treeDensity === 'MODERATE') adj += 5;
    else if (treeDensity === 'HEAVY') adj += 12;
    if (landscapeComplexity === 'COMPLEX') adj += 8;
    if (nearWater && nearWater !== 'NONE' && nearWater !== 'NO' && nearWater !== false) adj += 5;
    if (hasLargeDriveway) adj += 5;
    if (indoor) adj += 15;
    adj += propTypeAdj; // Property type adjustment
    let pp = Math.max(89, 117 + adj), rOG = 0;
    // Split roach modifier: German 25% (labor-intensive: gel bait, IGR, monitoring), Regular 10%
    if (roachMod === 'GERMAN') rOG = Math.round(pp * 0.25 * 100) / 100;
    else if (roachMod === 'REGULAR') rOG = Math.round(pp * 0.10 * 100) / 100;
    const freqTiers = [
      { f: 4, label: 'Quarterly', disc: 1.0, rec: pestFreq === 4 },
      { f: 6, label: 'Bi-Monthly', disc: 0.92, rec: pestFreq === 6 },
      { f: 12, label: 'Monthly', disc: 0.85, rec: pestFreq === 12 },
    ];
    R.pestTiers = [];
    freqTiers.forEach(ft => {
      const perApp = Math.round((pp * ft.disc + rOG) * 100) / 100;
      const ann = Math.round(perApp * ft.f * 100) / 100;
      const mo = Math.round(ann / 12 * 100) / 100;
      R.pestTiers.push({ pa: perApp, apps: ft.f, ann, mo, init: 99, rOG, label: ft.label, recommended: ft.rec, dimmed: !ft.rec });
      if (ft.f === pestFreq) {
        R.pest = { pa: perApp, apps: ft.f, ann, mo, init: 99, rOG, label: ft.label };
      }
    });
    R.pestRoachMod = roachMod;
    wgServices.push({ name: 'Pest (' + R.pest.label + ')', mo: R.pest.mo });
  }

  /* ── TREE & SHRUB ────────────────────────────────────────── */
  if (svcTs && lotSqFt > 0) {
    hasRec = true;
    let eb = bedArea;
    if (eb <= 0) {
      let bp = shrubDensity === 'HEAVY' ? 0.25 : shrubDensity === 'MODERATE' ? 0.18 : 0.10;
      if (landscapeComplexity === 'COMPLEX') bp += 0.05;
      // v1.5: raised cap from 8,000 to 12,000 — 1-acre heavy-shrub properties can exceed 10k sf beds
      eb = Math.min(12000, Math.round(lotSqFt * bp));
      fieldVerify.push('bed area');
    }
    let et = treeCount || (treeDensity === 'HEAVY' ? 12 : treeDensity === 'MODERATE' ? 5 : 2);
    // v1.5: access difficulty adds time for gate access, narrow side yards, split beds
    const accessMin = accessDifficulty === 'DIFFICULT' ? 15 : accessDifficulty === 'MODERATE' ? 8 : 0;
    const osm = Math.max(25, 20 + Math.round(eb / 500) + Math.round(et * 1.5) + accessMin);
    const lpv = LABOR * ((osm + 10) / 60);
    // v1.6: material rates updated from SiteOne pricing audit (2× higher than original)
    const mps = { 6: 0.110, 9: 0.190, 12: 0.220 };
    const tst = [
      { n: 'Standard', v: 6, f: 50 },
      { n: 'Enhanced', v: 9, f: 65 },
      { n: 'Premium', v: 12, f: 80 },
    ];
    R.ts = [];
    R.tsMeta = { eb, et, bedAreaIsEstimated };
    tst.forEach((t, i) => {
      let mc = Math.max(t.v * 10, eb * mps[t.v]);
      let lc = lpv * t.v;
      let ann = Math.round((mc + lc) / 0.43 * 100) / 100;
      let mo = Math.round(ann / 12 * 100) / 100;
      if (mo < t.f) { mo = t.f; ann = t.f * 12; }
      const pa = Math.round(ann / t.v * 100) / 100;
      const rec = i === 1, dim = i !== 1;
      R.ts.push({ pa, v: t.v, ann, mo, name: t.n, recommended: rec, dimmed: dim });
    });
    wgServices.push({ name: 'Tree & Shrub (Enhanced)', mo: R.ts[1].mo });
  }

  /* ── PALM INJECTION ──────────────────────────────────────── */
  if (svcInjection) {
    hasRec = true;
    // v1.5: prefer manual injectable count — the 30% estimate is unreliable
    // (10 Washingtonia + 2 Canary Islands = 12 palms but only 2 injectable)
    let ip;
    let palmEstimated = false;
    if (Number(_injectablePalms) > 0) {
      ip = Number(_injectablePalms);
    } else {
      let ep = palmCount || (treeDensity === 'HEAVY' ? 6 : treeDensity === 'MODERATE' ? 5 : 3);
      ip = Math.max(1, Math.round(ep * 0.30));
      palmEstimated = true;
      fieldVerify.push('injectable palm count');
    }
    // v1.7: palm injection default is combo ($55/palm) for estimates, 2 apps/year
    const palmPerApp = 55;
    const inja = ip * palmPerApp * 2, injMo = Math.round(inja / 12 * 100) / 100;
    R.injection = { palms: ip, ann: inja, mo: injMo, estimated: palmEstimated, pricePerPalm: palmPerApp };
    wgServices.push({ name: 'Palm Injection', mo: injMo });
  }

  /* ── MOSQUITO ────────────────────────────────────────────── */
  if (svcMosquito && lotSqFt > 0) {
    hasRec = true;
    let sz = 'SMALL';
    if (lotSqFt >= 43560) sz = 'ACRE';
    else if (lotSqFt >= 21780) sz = 'HALF';
    else if (lotSqFt >= 14520) sz = 'THIRD';
    else if (lotSqFt >= 10890) sz = 'QUARTER';
    let pr = 1.0;
    if (treeDensity === 'HEAVY') pr += 0.15;
    else if (treeDensity === 'MODERATE') pr += 0.05;
    if (landscapeComplexity === 'COMPLEX') pr += 0.10;
    else if (landscapeComplexity === 'MODERATE') pr += 0.05;
    if (hasPool) pr += 0.05;
    if (nearWater) pr += 0.10;
    // v1.5: irrigation creates standing water in valve boxes, low spots, overflow areas
    if (hasIrrigation) pr += 0.08;
    if (sz === 'ACRE') pr += 0.15;
    else if (sz === 'HALF') pr += 0.05;
    // v1.7: pressure cap 1.80 (was 1.60 then 2.00; 2× doubles base price, too high)
    pr = Math.min(1.80, Math.round(pr * 100) / 100);
    const bp = {
      SMALL:   { b: 80, s: 90, g: 100, p: 110 },
      QUARTER: { b: 90, s: 100, g: 115, p: 125 },
      THIRD:   { b: 100, s: 110, g: 125, p: 135 },
      HALF:    { b: 110, s: 125, g: 145, p: 155 },
      ACRE:    { b: 140, s: 155, g: 180, p: 200 },
    };
    const b = bp[sz] || bp.SMALL;
    const mt = [
      { n: 'Bronze', pv: Math.round(b.b * pr), v: 12 },
      { n: 'Silver', pv: Math.round(b.s * pr), v: 12 },
      { n: 'Gold', pv: Math.round(b.g * pr), v: 15 },
      { n: 'Platinum', pv: Math.round(b.p * pr), v: 18 },
    ];
    let ri = 1;
    if (treeDensity === 'HEAVY') ri = 2;
    if (nearWater && ri < 2) ri++;
    R.mq = [];
    R.mqMeta = { pr, sz, ri };
    mt.forEach((t, i) => {
      const ann = t.pv * t.v;
      const mo = Math.round(ann / 12 * 100) / 100;
      const rec = i === ri, dim = i !== ri;
      R.mq.push({ pv: t.pv, v: t.v, ann, mo, n: t.n, recommended: rec, dimmed: dim });
    });
    wgServices.push({ name: 'Mosquito (' + R.mq[ri].n + ')', mo: R.mq[ri].mo });
  }

  /* ── TERMITE BAIT ────────────────────────────────────────── */
  if (svcTermiteBait) {
    hasRec = true;
    const fpEff = footprint > 0 ? footprint : 2500;
    let pm = (landscapeComplexity === 'MODERATE' || landscapeComplexity === 'COMPLEX') ? 1.35 : 1.25;
    const perim = Math.round(4 * Math.sqrt(fpEff) * pm);
    const sta = Math.max(8, Math.ceil(perim / 10));
    const ai = Math.round((sta * 14 + sta * 5.25 + sta * 0.75) * 1.75);
    const ti = Math.round((sta * 24 + sta * 5.25 + sta * 0.75) * 1.75);
    R.tmBait = { ai, ti, bmo: 35, pmo: 65, perim, sta };
    wgServices.push({ name: 'Termite Bait (Basic)', mo: 35 });
  }

  /* ── RODENT BAIT ─────────────────────────────────────────── */
  if (svcRodentBait) {
    hasRec = true;
    // v1.5: matrix classification — both footprint AND lot matter for rodent pressure
    // A 2,600sf home on a 40,000sf lot has very different pressure than 2,600sf on 10,000sf
    const fpEff = footprint > 0 ? footprint : 2500;
    let rodentScore = 0;
    if (fpEff >= 2500) rodentScore += 2; else if (fpEff >= 1800) rodentScore += 1;
    if (lotSqFt >= 20000) rodentScore += 2; else if (lotSqFt >= 12000) rodentScore += 1;
    if (nearWater) rodentScore += 1;
    if (treeDensity === 'HEAVY') rodentScore += 1;
    const rmo = rodentScore >= 3 ? 109 : rodentScore <= 1 ? 75 : 89;
    R.rodBaitMo = rmo;
    R.rodBaitSize = rodentScore >= 3 ? 'Large' : rodentScore <= 1 ? 'Small' : 'Medium';
    R.rodBaitScore = rodentScore;
  }

  /* ═══════════ ONE-TIME ═══════════ */
  let hasOT = false, otItems = [];

  /* ── One-Time Pest ───────────────────────────────────────── */
  if (svcOnetimePest) {
    hasOT = true;
    const fpEff = footprint > 0 ? footprint : 2500;
    const roachBackout = roachMod === 'GERMAN' ? 1.25 : roachMod === 'REGULAR' ? 1.10 : 1;
    let bpp = R.pest ? R.pest.pa / (R.pest.rOG > 0 ? roachBackout : 1) : 117;
    if (!R.pest) {
      let adj = 0;
      adj += interpolate(fpEff, [
        { at: 800, adj: -20 }, { at: 1200, adj: -12 }, { at: 1500, adj: -6 },
        { at: 2000, adj: 0 }, { at: 2500, adj: 12 }, { at: 3000, adj: 22 },
        { at: 4000, adj: 35 }, { at: 5500, adj: 50 },
      ]);
      if (shrubDensity === 'LIGHT') adj -= 5;
      else if (shrubDensity === 'HEAVY') adj += 25;
      if (hasPoolCage) adj += 22;
      else if (hasPool) adj += 5;
      adj += interpolate(lotSqFt, [
        { at: 3000, adj: -10 }, { at: 5000, adj: -5 }, { at: 7500, adj: 0 },
        { at: 10000, adj: 8 }, { at: 15000, adj: 18 }, { at: 25000, adj: 30 },
        { at: 50000, adj: 42 },
      ]);
      if (treeDensity === 'LIGHT') adj -= 3;
      else if (treeDensity === 'HEAVY') adj += 15;
      if (landscapeComplexity === 'COMPLEX') adj += 8;
      if (nearWater && nearWater !== 'NONE' && nearWater !== 'NO') adj += 2.5;
      if (hasLargeDriveway) adj += 2.5;
      if (indoor) adj += 10;
      bpp = Math.max(89, 117 + adj);
    }
    const fp = otP(Math.max(150, Math.round(bpp * 1.30)));
    otItems.push({ name: 'OT Pest', price: fp, detail: indoor ? 'Interior + exterior' : 'Exterior (+ interior add-on)' });
  }

  /* ── One-Time Lawn ───────────────────────────────────────── */
  if (svcOnetimeLawn && lotSqFt > 0) {
    hasOT = true;
    // v1.5: standalone fungicide fallback base raised — Headway G + liquid follow-up
    // is $80+ materials on a 6k sf lawn, $73 base was underpricing mid-size properties
    let enhPA = 55 * 12 / 9;
    if (R.lawn && R.lawn[2]) enhPA = R.lawn[2].pa;
    const isFungicide = otLawnType === 'FUNGICIDE';
    const standaloneFungBase = Math.max(enhPA, 95); // higher floor for standalone fungicide
    let bl = Math.max(85, Math.round((isFungicide && !R.lawn ? standaloneFungBase : enhPA) * 1.30));
    let tm = 1.0, tl = 'Fertilization';
    if (otLawnType === 'WEED') { tm = 1.15; tl = 'Weed Control'; }
    else if (otLawnType === 'PEST') { tm = 1.30; tl = 'Lawn Pest'; }
    else if (otLawnType === 'FUNGICIDE') { tm = 1.45; tl = 'Fungicide'; }
    const fp = otP(Math.max(85, Math.round(bl * tm)));
    otItems.push({ name: 'OT Lawn (' + tl + ')', price: fp, detail: 'Single visit', lawnType: tl });
  }

  /* ── One-Time Mosquito ───────────────────────────────────── */
  if (svcOnetimeMosquito && lotSqFt > 0) {
    hasOT = true;
    let p = 200;
    if (lotSqFt >= 43560) p = 350;
    else if (lotSqFt >= 21780) p = 300;
    else if (lotSqFt >= 14520) p = 275;
    else if (lotSqFt >= 10890) p = 250;
    const fp = otP(p);
    otItems.push({ name: 'OT Mosquito', price: fp, detail: 'Rain re-spray guarantee' });
  }

  /* ── Plugging ────────────────────────────────────────────── */
  if (svcPlugging && plugArea > 0) {
    hasOT = true;
    const cpp = 19.99 / 18, ir = 150;
    let ppsf, sl;
    if (plugSpacing == 6) { ppsf = 4; sl = '6" Premium'; }
    else if (plugSpacing == 9) { ppsf = 1.78; sl = '9" Standard'; }
    else { ppsf = 1; sl = '12" Economy'; }
    const tp = Math.ceil(plugArea * ppsf), tr = Math.ceil(tp / 18);
    const fp = otP(Math.max(250, Math.round((tp * cpp + (tp / ir) * LABOR) / (1 - 0.45))));
    const ps = Math.round(fp / plugArea * 100) / 100;
    otItems.push({ name: 'Plugging', price: fp, detail: plugArea.toLocaleString() + ' sf | ' + tp.toLocaleString() + ' plugs | $' + ps + '/sf', spacing: sl, plugArea, plugSpacing, warn6: plugSpacing == 6 });
  }

  /* ── Top Dressing ────────────────────────────────────────── */
  const lawnEst = R.lawn ? Math.round(lotSqFt * 0.55 * (R.lawn[2] ? 0.65 : 0.55)) : Math.round(lotSqFt * 0.35);
  if (svcTopdress && lawnEst > 0) {
    hasOT = true;
    const lk = lawnEst / 1000;
    const e8 = otP(Math.max(250, Math.round((lk * 1.04 * 4.09 + lk * 2.62 + LABOR * (lawnEst / 130 + 30) / 60) / 0.40)));
    const e4 = otP(Math.max(350, Math.round((lk * 2.08 * 4.09 + lk * 5.24 + LABOR * (lawnEst / 130 * 1.5 + 45) / 60) / 0.40)));
    R.td = e8;
    otItems.push({ name: 'Top Dressing', price: e8, detail: 'St. Augustine standard', depth: '1/8"' });
    R.tdTiers = [
      { name: '1/8" Depth', price: e8, detail: 'St. Augustine standard' },
      { name: '1/4" Depth', price: e4, detail: 'Bermuda / leveling — 2x material' },
    ];
  }

  /* ── Dethatching ─────────────────────────────────────────── */
  if (svcDethatch && lawnEst > 0) {
    hasOT = true;
    const dt = lawnEst / 100 + lawnEst / 200 + 30;
    const dc = LABOR * (dt / 60) + lawnEst / 1000 * 2.10;
    const sp = otP(Math.max(150, Math.round(dc / 0.40)));
    R.dth = sp;
    otItems.push({ name: 'Dethatching', price: sp, detail: 'One-time service' });
  }

  /* ── Trenching ───────────────────────────────────────────── */
  if (svcTrenching && footprint > 0) {
    hasOT = true;
    let pm = (landscapeComplexity === 'MODERATE' || landscapeComplexity === 'COMPLEX') ? 1.35 : 1.25;
    const perim = Math.round(4 * Math.sqrt(footprint) * pm);
    let cp = 0.25;
    if (hasPoolCage) cp = 0.35;
    else if (hasPool) cp = 0.30;
    if (hasLargeDriveway) cp += 0.05;
    // v1.5: raised cap from 0.50 to 0.60 — full cage + 3-car garage can hit 55-60%
    cp = Math.min(0.60, cp);
    const dl = Math.round(perim * (1 - cp)), cl = Math.round(perim * cp);
    const fp = otP(Math.max(600, dl * 10 + cl * 14));
    R.trench = { price: fp, ren: 325, dl, cl };
    otItems.push({ name: 'Trenching', price: fp, detail: dl + ' LF dirt + ' + cl + ' LF concrete' });
  }

  /* ── Bora-Care ───────────────────────────────────────────── */
  if (svcBoracare && bcSqft > 0) {
    hasOT = true;
    const BC_GAL = 91.98, BC_COV = 275, BC_EQUIP = 17.50;
    const gal = Math.max(3, Math.ceil(bcSqft / BC_COV));
    // v1.5: raised labor cap from 6 to 10 hrs — 4,500+ sf attics are multi-day in SWFL heat
    const isMultiDay = bcSqft > 4500;
    const lhr = isMultiDay
      ? Math.min(10, Math.max(6, 1.5 + bcSqft / 800))  // more aggressive rate for large attics
      : Math.min(6, Math.max(2, 1.5 + bcSqft / 1000));
    const cost = gal * BC_GAL + lhr * LABOR + BC_EQUIP;
    const fp = otP(Math.round(cost / 0.45));
    const detail = '~' + bcSqft.toLocaleString() + ' sf | ' + gal + ' gal | ' + lhr.toFixed(1) + ' hrs' + (isMultiDay ? ' (multi-day)' : '');
    otItems.push({ name: 'Bora-Care', price: fp, detail, atticIsEstimated, bcSqft, gal, lhr, isMultiDay });
  }

  /* ── Pre-Slab Termidor ───────────────────────────────────── */
  if (svcPreslab && psSqft > 0) {
    hasOT = true;
    const PS_BTL = 174.72, PS_COV = 1250, PS_EQUIP = 15;
    const btl = Math.max(1, Math.ceil(psSqft / PS_COV));
    const lhr = Math.min(5, Math.max(1, 0.5 + psSqft / 1500));
    const cost = btl * PS_BTL + lhr * LABOR + PS_EQUIP;
    let price = Math.round(cost / 0.45);
    const vol = preslabVolume;
    if (vol === '10') price = Math.round(price * 0.85);
    else if (vol === '5') price = Math.round(price * 0.90);
    const warrAdd = preslabWarranty === 'EXTENDED' ? 200 : 0;
    const fp = otP(price) + warrAdd;
    otItems.push({ name: 'Pre-Slab', price: fp, detail: psSqft.toLocaleString() + ' sf | ' + btl + ' bottles' + (vol !== 'NONE' ? ' (vol disc)' : ''), psSqft, btl, volDisc: vol !== 'NONE', basePrice: otP(price), warrAdd });
  }

  /* ── Foam Drill ──────────────────────────────────────────── */
  if (svcFoam) {
    hasOT = true;
    const FM_CAN = 39.08, FM_BITS = 8;
    const ft = {
      '5':  { c: 1, l: 1, n: 'Spot (1–5)' },
      '10': { c: 2, l: 1.5, n: 'Moderate (6–10)' },
      '15': { c: 3, l: 2, n: 'Extensive (11–15)' },
      '20': { c: 4, l: 3, n: 'Full Perimeter' },
    };
    const t = ft[String(fmPts)] || ft['5'];
    const cost = t.c * FM_CAN + t.l * LABOR + FM_BITS;
    const fp = otP(Math.max(250, Math.round(cost / 0.45)));
    otItems.push({ name: 'Foam Drill', price: fp, detail: t.c + ' cans | ~$' + Math.round(fp / fmPts) + '/point', tierName: t.n });
  }

  /* ── Rodent Trapping ─────────────────────────────────────── */
  if (svcRodentTrap) {
    hasOT = true;
    let p = 350;
    p += interpolate(footprint, [
      { at: 800, adj: -25 }, { at: 1500, adj: -10 }, { at: 2000, adj: 0 },
      { at: 2500, adj: 20 }, { at: 3000, adj: 40 }, { at: 4000, adj: 65 },
    ]);
    p += interpolate(lotSqFt, [
      { at: 5000, adj: 0 }, { at: 10000, adj: 10 },
      { at: 15000, adj: 20 }, { at: 25000, adj: 35 },
    ]);
    const fp = otP(Math.max(350, p));
    otItems.push({ name: 'Trapping', price: fp, detail: 'Setup + check visits' });
  }

  /* ── German Roach Initial (from pest roach modifier) ────── */
  if (roachMod === 'GERMAN') {
    hasOT = true;
    const fp = otP(100);
    otItems.push({ name: 'German Roach', price: fp, detail: 'One-time setup' });
  }

  /* ═══════════ SPECIALTY ═══════════ */
  let specItems = [];

  /* ── Flea ────────────────────────────────────────────────── */
  if (svcFlea) {
    let fi = 225, ff = 125;
    fi += interpolate(footprint, [
      { at: 800, adj: -25 }, { at: 1200, adj: -15 }, { at: 1500, adj: -5 },
      { at: 2000, adj: 0 }, { at: 2500, adj: 15 }, { at: 3000, adj: 25 },
      { at: 4000, adj: 40 },
    ]);
    ff += interpolate(footprint, [
      { at: 800, adj: -15 }, { at: 1200, adj: -10 }, { at: 1500, adj: -3 },
      { at: 2000, adj: 0 }, { at: 2500, adj: 8 }, { at: 3000, adj: 15 },
      { at: 4000, adj: 25 },
    ]);
    fi += interpolate(lotSqFt, [
      { at: 3000, adj: -15 }, { at: 5000, adj: -5 }, { at: 7500, adj: 0 },
      { at: 10000, adj: 10 }, { at: 15000, adj: 20 }, { at: 25000, adj: 35 },
    ]);
    ff += interpolate(lotSqFt, [
      { at: 3000, adj: -8 }, { at: 5000, adj: -3 }, { at: 7500, adj: 0 },
      { at: 10000, adj: 5 }, { at: 15000, adj: 12 }, { at: 25000, adj: 20 },
    ]);
    if (treeDensity === 'HEAVY') { fi += 20; ff += 10; }
    else if (treeDensity === 'MODERATE') { fi += 10; ff += 5; }
    if (landscapeComplexity === 'COMPLEX') { fi += 15; ff += 10; }
    else if (landscapeComplexity === 'MODERATE') { fi += 5; ff += 5; }
    fi = Math.max(185, fi);
    ff = Math.max(95, ff);
    specItems.push({ name: 'Flea (2-visit)', price: otP(fi + ff), det: '$' + fi + ' + $' + ff });
  }

  /* ── Wasp ────────────────────────────────────────────────── */
  if (svcWasp) {
    let wp = 150;
    wp += interpolate(treeNum, [{ at: 0, adj: 0 }, { at: 1, adj: 10 }, { at: 2, adj: 25 }]);
    if (landscapeComplexity === 'COMPLEX') wp += 15;
    else if (landscapeComplexity === 'MODERATE') wp += 5;
    wp += interpolate(lotSqFt, [
      { at: 5000, adj: 0 }, { at: 10000, adj: 5 },
      { at: 15000, adj: 15 }, { at: 25000, adj: 25 },
    ]);
    wp = Math.max(150, wp);
    if (R.pest) {
      specItems.push({ name: 'Wasp/Bee', price: 0, det: 'Included on ' + R.pest.label + ' program', onProg: true });
    } else {
      specItems.push({ name: 'Wasp/Bee', price: otP(wp), det: 'Standalone removal' });
    }
  }

  /* ── Roach (standalone specialty) ────────────────────────── */
  if (svcRoach) {
    const rt = roachType;
    if (rt === 'REGULAR') {
      let bpp = R.pest ? R.pest.pa : 117;
      specItems.push({ name: 'Regular Roach', price: otP(Math.max(150, Math.round(bpp * 1.15 * 1.30))), det: 'Enhanced treatment' });
    } else {
      let gp = 450 + interpolate(footprint, [
        { at: 800, adj: -40 }, { at: 1200, adj: -20 }, { at: 1500, adj: -10 },
        { at: 2000, adj: 0 }, { at: 2500, adj: 25 }, { at: 3000, adj: 50 },
        { at: 4000, adj: 85 },
      ]);
      specItems.push({ name: 'German Roach (3-visit)', price: otP(Math.max(400, gp)), det: 'Gel+IGR+monitoring' });
    }
  }

  /* ── Bed Bug ─────────────────────────────────────────────── */
  if (svcBedbug) {
    const rm = bedbugRooms, meth = bedbugMethod;
    if (meth !== 'HEAT') {
      const lv1 = 45 + Math.max(0, (rm - 1) * 30) + 30 + DRIVE;
      const lv2 = 25 + Math.max(0, (rm - 1) * 20) + DRIVE;
      const mpr = 50.42;
      let cp = Math.round((mpr * rm + LABOR * (lv1 / 60) + mpr * rm * 0.5 + LABOR * (lv2 / 60)) / 0.35 * 100) / 100;
      const fl = 400 + (rm - 1) * 250;
      if (cp < fl) cp = fl;
      if (footprint > 2500) cp = Math.round(cp * 1.10);
      else if (footprint > 1800) cp = Math.round(cp * 1.05);
      specItems.push({ name: 'Bed Bug Chemical', price: otP(cp), det: rm + ' room' + (rm > 1 ? 's' : '') + ', 2 visits' });
    }
    if (meth !== 'CHEMICAL') {
      let hpr = rm === 1 ? 1000 : rm === 2 ? 850 : 750;
      let hp = hpr * rm;
      // v1.5: in-house heat adds equipment cost (heaters, fans, monitoring)
      // Subcontract rate already includes equipment in the per-room price
      if (bedbugEquipment === 'INHOUSE') {
        const equipCost = 150 + (rm - 1) * 75; // heater rental/depreciation + fans + monitors
        hp += equipCost;
      }
      if (footprint > 2500) hp = Math.round(hp * 1.10);
      else if (footprint < 1200) hp = Math.round(hp * 0.95);
      const fp = otP(hp);
      specItems.push({ name: 'Bed Bug Heat', price: fp, det: rm + ' room' + (rm > 1 ? 's' : '') + ' — ' + fmtInt(fp / rm) + '/room' + (bedbugEquipment === 'INHOUSE' ? ' (in-house)' : '') });
    }
  }

  /* ── Exclusion ───────────────────────────────────────────── */
  if (svcExclusion && (exS + exM + exA) > 0) {
    const sc = exS * 37.50 + exM * 75 + exA * 150;
    let ep = Math.max(150, Math.round(sc));
    let insp = exW ? 0 : 85;
    const tp = otP(ep) + insp;
    let tl = 'Basic';
    if (exA > 0) tl = 'Advanced (Roof)';
    else if (exM > 0) tl = 'Moderate';
    specItems.push({ name: 'Rodent Exclusion', price: tp, det: tl + ' — ' + (exS + exM + exA) + ' points' + (insp > 0 ? ' + $85 inspect' : '') + (exW ? ' (waived)' : '') });
  }

  /* ═══════════ WAVEGUARD TOTALS ═══════════ */
  let ac = 0, ra = 0;
  // Track per-line revenue for margin check
  const lineItems = [];
  if (R.lawn) { ac++; ra += R.lawn[2].ann; lineItems.push({ name: 'Lawn Care', ann: R.lawn[2].ann }); }
  if (R.pest) { ac++; ra += R.pest.ann; lineItems.push({ name: 'Pest Control', ann: R.pest.ann }); }
  if (R.ts) { ac++; ra += R.ts[1].ann; lineItems.push({ name: 'Tree & Shrub', ann: R.ts[1].ann }); }
  if (R.injection) { ac++; ra += R.injection.ann; lineItems.push({ name: 'Palm Injection', ann: R.injection.ann }); }
  if (R.mq) {
    const ri = treeDensity === 'HEAVY' ? 2 : 1;
    if (R.mq[ri]) { ac++; ra += R.mq[ri].ann; lineItems.push({ name: 'Mosquito', ann: R.mq[ri].ann }); }
  }
  if (R.tmBait) { ac++; ra += 35 * 12; lineItems.push({ name: 'Termite Bait', ann: 420 }); }

  let wt = 'Bronze', wd = 0;
  if (ac >= 4) { wt = 'Platinum'; wd = 0.18; }
  else if (ac === 3) { wt = 'Gold'; wd = 0.15; }
  else if (ac === 2) { wt = 'Silver'; wd = 0.10; }
  else if (ac === 1) { wt = 'Bronze'; wd = 0; }
  const da = Math.round(ra * wd * 100) / 100;
  const ad = Math.round((ra - da) * 100) / 100;
  const mm = Math.round(ad / 12 * 100) / 100;

  // Margin floor check - flag any line that drops below 35% margin at current tier discount
  // Loaded labor rate ~$35/hr, typical service 45-60 min = ~$30-35 labor + $10-15 materials = ~$45 COGS floor
  const MARGIN_FLOOR = 0.35;
  const marginWarnings = [];
  if (wd > 0) {
    lineItems.forEach(li => {
      const discountedAnn = li.ann * (1 - wd);
      // Estimate COGS at ~55% of pre-discount (conservative: labor + materials + drive)
      const estimatedCOGS = li.ann * 0.55;
      const margin = (discountedAnn - estimatedCOGS) / discountedAnn;
      if (margin < MARGIN_FLOOR) {
        marginWarnings.push({
          service: li.name,
          preDiscount: Math.round(li.ann),
          afterDiscount: Math.round(discountedAnn),
          estimatedMargin: Math.round(margin * 100),
          tier: wt,
        });
      }
    });
  }

  let ot = 0;
  otItems.forEach(i => ot += i.price);
  specItems.forEach(s => { if (!s.onProg) ot += s.price; });
  let tmInstall = R.tmBait ? R.tmBait.ti : 0;
  ot = Math.round(ot * 100) / 100;

  const rba = R.rodBaitMo ? R.rodBaitMo * 12 : 0;
  const totalOT = ot + tmInstall;
  const y1 = Math.round((ad + rba + totalOT) * 100) / 100;
  const y2 = Math.round((ad + rba + (R.trench ? 325 : 0)) * 100) / 100;
  const y2mo = Math.round(y2 / 12 * 100) / 100;

  return {
    property: {
      type: propertyType,
      homeSqFt,
      lotSqFt,
      stories,
      footprint,
      pool: hasPool,
      poolCage: hasPoolCage,
      driveway: hasLargeDriveway,
      shrubs: shrubDensity,
      trees: treeDensity,
      complexity: landscapeComplexity,
      nearWater,
    },
    recurring: {
      services: wgServices,
      monthlyTotal: mm,
      annualBeforeDiscount: ra,
      annualAfterDiscount: ad,
      waveGuardTier: wt,
      discount: wd,
      savings: da,
      rodentBaitMo: R.rodBaitMo || 0,
      serviceCount: ac,
      // Tier commitment: if customer cancels services and drops below tier threshold,
      // downstream billing should reconcile to the new tier rate retroactively for that period.
      // tierServiceMin: minimum services required to maintain this tier
      tierServiceMin: wt === 'Platinum' ? 4 : wt === 'Gold' ? 3 : wt === 'Silver' ? 2 : 1,
      marginWarnings, // any lines below 35% margin at this tier discount
    },
    oneTime: {
      items: otItems,
      specItems: specItems.filter(s => !s.onProg && s.price > 0).map(s => ({ name: s.name, price: s.price })),
      tmInstall,
      total: totalOT,
      otSubtotal: ot,
    },
    totals: { year1: y1, year2: y2, year2mo },
    results: R,
    specItems, // full array including onProg items for display
    fieldVerify,
    urgency,
    urgLabel,
    urgMult,
    isRecurringCustomer: isRC,
    hasRecurring: hasRec || ac > 0,
    hasOneTime: hasOT,
    modifiers,
  };
}
