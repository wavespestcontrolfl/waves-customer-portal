/**
 * Waves Pest Control — Estimate Calculation Engine v1.3
 * Ported from waves-estimator.html weCalculate() function.
 * Pure calculation — no DOM, no side effects.
 */

/* ── helpers ────────────────────────────────────────────────── */

export function interpolate(v, b) {
  if (v <= b[0].at) return b[0].adj;
  if (v >= b[b.length - 1].at) return b[b.length - 1].adj;
  for (let i = 1; i < b.length; i++) {
    if (v <= b[i].at) {
      const p = b[i - 1], c = b[i];
      return Math.round(p.adj + ((v - p.at) / (c.at - p.at)) * (c.adj - p.adj));
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
    { at: 800, adj: -20 }, { at: 1200, adj: -10 }, { at: 1500, adj: -4 },
    { at: 2000, adj: 0 }, { at: 2500, adj: 5 }, { at: 3000, adj: 11 },
    { at: 4000, adj: 20 }, { at: 5500, adj: 30 },
  ]);
  addMod('pest', `Footprint size: ${fpAdj >= 0 ? '+' : ''}$${fpAdj}/visit`, fpAdj, fpAdj > 0 ? 'up' : fpAdj < 0 ? 'down' : 'info');

  // Lot size impact — reduced from previous values
  const lotAdj = interpolate(lotSqFt, [
    { at: 3000, adj: -5 }, { at: 5000, adj: -3 }, { at: 7500, adj: 0 },
    { at: 10000, adj: 3 }, { at: 15000, adj: 8 }, { at: 25000, adj: 12 }, { at: 50000, adj: 15 },
  ]);
  addMod('pest', `Lot size: ${lotAdj >= 0 ? '+' : ''}$${lotAdj}/visit`, lotAdj, lotAdj > 0 ? 'up' : lotAdj < 0 ? 'down' : 'info');

  // Pool
  if (hasPoolCage) addMod('pest', 'Pool cage: +$22/visit', 22, 'up');
  else if (hasPool) addMod('pest', 'Pool: +$5/visit', 5, 'up');
  else addMod('pest', 'No pool: $0/visit', 0, 'info');

  // Shrubs
  if (shrubDensity === 'HEAVY') addMod('pest', 'Heavy shrubs: +$25/visit', 25, 'up');
  else if (shrubDensity === 'MODERATE') addMod('pest', 'Moderate shrubs: $0/visit', 0, 'info');
  else if (shrubDensity === 'LIGHT') addMod('pest', 'Light shrubs: -$5/visit', -5, 'down');

  // Trees
  if (treeDensity === 'HEAVY') addMod('pest', 'Heavy trees: +$15/visit', 15, 'up');
  else if (treeDensity === 'MODERATE') addMod('pest', 'Moderate trees: $0/visit', 0, 'info');
  else if (treeDensity === 'LIGHT') addMod('pest', 'Light trees: -$3/visit', -3, 'down');

  // Complexity
  if (landscapeComplexity === 'COMPLEX') addMod('pest', 'Complex landscape: +$8/visit', 8, 'up');
  else addMod('pest', `${landscapeComplexity || 'Simple'} landscape: $0/visit`, 0, 'info');

  // Water proximity — mosquito lot-size multiplier
  const waterAdj = (nearWater && nearWater !== 'NONE' && nearWater !== 'NO' && nearWater !== false) ? 15 : 0;
  if (waterAdj > 0) addMod('mosquito', `Near water (${String(nearWater).replace(/_/g, ' ')}): +$${waterAdj}/visit`, waterAdj, 'up');
  else addMod('mosquito', 'No water nearby: $0/visit', 0, 'info');

  // Driveway
  if (hasLargeDriveway) addMod('property', 'Large driveway: +$5/visit', 5, 'up');
  else addMod('property', 'Standard driveway: $0/visit', 0, 'info');

  // Urgency
  if (urgency === 'SOON') addMod('one-time', `Urgency (Soon): +25%`, 25, 'up');
  else if (urgency === 'URGENT') addMod('one-time', `Urgency (Emergency): +50%`, 50, 'up');
  else addMod('one-time', 'Routine service: $0 surcharge', 0, 'info');

  // Recurring customer
  if (isRC) addMod('one-time', 'Recurring customer: -15% one-time services', null, 'down');

  // Roach modifier
  if (roachMod === 'GERMAN' || roachMod === 'REGULAR') addMod('pest', `Roach modifier (${roachMod}): +15%/visit`, null, 'up');

  /* ═══════════ RECURRING ═══════════ */
  let hasRec = false;

  /* ── LAWN ────────────────────────────────────────────────── */
  if (svcLawn && lotSqFt > 0) {
    hasRec = true;
    let hs = 0.10;
    const pt = propertyType.toLowerCase();
    if (pt.includes('town') || pt.includes('duplex')) hs = 0.08;
    else if (pt.includes('condo')) hs = 0.15;
    else if (pt.includes('commercial')) hs = 0.20;
    if (hasLargeDriveway) hs += 0.05;
    if (hasPool) hs += 0.04;
    let oa = Math.max(0, Math.round(lotSqFt - homeSqFt - (lotSqFt * hs)));
    let sc = 0;
    if (hasPool) sc += 2;
    if (hasPoolCage) sc += 1;
    if (hasLargeDriveway) sc += 2;
    if (shrubDensity === 'MODERATE') sc += 1; else if (shrubDensity === 'HEAVY') sc += 2;
    if (treeDensity === 'MODERATE') sc += 1; else if (treeDensity === 'HEAVY') sc += 2;
    if (landscapeComplexity === 'MODERATE') sc += 1; else if (landscapeComplexity === 'COMPLEX') sc += 2;
    let tf = sc <= 1 ? 0.75 : sc <= 3 ? 0.65 : sc <= 5 ? 0.55 : sc <= 7 ? 0.45 : 0.35;
    const lsf = Math.round(oa * tf), lk = lsf / 1000, lpv = LABOR * (27.5 / 60);
    const tiers = [
      { name: 'Basic', v: 4, mk: 13.80, fl: 45 },
      { name: 'Standard', v: 6, mk: 21.37, fl: 55 },
      { name: 'Enhanced', v: 9, mk: 34.74, fl: 55 },
      { name: 'Premium', v: 12, mk: 38.12, fl: 55, w: true },
    ];
    R.lawn = [];
    tiers.forEach((t, i) => {
      let mc = lk * t.mk, lc = lpv * t.v;
      if (t.w) { mc += 30; lc += LABOR * (15 / 60) * 3; }
      let ann = Math.round((mc + lc) / 0.43 * 100) / 100;
      let mo = Math.round(ann / 12 * 100) / 100;
      if (mo < t.fl) { mo = t.fl; ann = t.fl * 12; }
      const pa = Math.round(ann / t.v * 100) / 100;
      const rec = i === 2, dim = i !== 2;
      R.lawn.push({ pa, v: t.v, ann, mo, name: t.name, recommended: rec, dimmed: dim, hasLandscape: !!t.w });
    });
    wgServices.push({ name: 'Lawn (Enhanced)', mo: R.lawn[2].mo });
    R.lawnMeta = { lsf, sc, tf, oa };
  }

  /* ── PEST — multi-frequency ──────────────────────────────── */
  if (svcPest && footprint > 0) {
    hasRec = true;
    let adj = 0;
    adj += interpolate(footprint, [
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
    let pp = Math.max(89, 117 + adj), rOG = 0;
    if (roachMod === 'REGULAR' || roachMod === 'GERMAN') rOG = Math.round(pp * 0.15 * 100) / 100;
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
      const init = Math.round(pp * 0.85 * 100) / 100;
      R.pestTiers.push({ pa: perApp, apps: ft.f, ann, mo, init, rOG, label: ft.label, recommended: ft.rec, dimmed: !ft.rec });
      if (ft.f === pestFreq) {
        R.pest = { pa: perApp, apps: ft.f, ann, mo, init, rOG, label: ft.label };
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
      eb = Math.min(8000, Math.round(lotSqFt * bp));
      fieldVerify.push('bed area');
    }
    let et = treeCount || (treeDensity === 'HEAVY' ? 12 : treeDensity === 'MODERATE' ? 5 : 2);
    const osm = Math.max(25, 20 + Math.round(eb / 500) + Math.round(et * 1.5));
    const lpv = LABOR * ((osm + 10) / 60);
    const mps = { 6: 220.60 / 3500, 9: 364.10 / 3500, 12: 413.60 / 3500 };
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
    let ep = palmCount || (treeDensity === 'HEAVY' ? 6 : treeDensity === 'MODERATE' ? 5 : 3);
    let ip = Math.max(1, Math.round(ep * 0.30));
    const inja = ip * 35 * 3, injMo = Math.round(inja / 12 * 100) / 100;
    R.injection = { palms: ip, ann: inja, mo: injMo };
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
    if (sz === 'ACRE') pr += 0.15;
    else if (sz === 'HALF') pr += 0.05;
    pr = Math.min(1.50, Math.round(pr * 100) / 100);
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
      { n: 'Platinum', pv: Math.round(b.p * pr), v: 17 },
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
  if (svcTermiteBait && footprint > 0) {
    hasRec = true;
    let pm = (landscapeComplexity === 'MODERATE' || landscapeComplexity === 'COMPLEX') ? 1.35 : 1.25;
    const perim = Math.round(4 * Math.sqrt(footprint) * pm);
    const sta = Math.max(8, Math.ceil(perim / 10));
    const ai = Math.round((sta * 14 + sta * 5.25 + sta * 0.75) * 1.45);
    const ti = Math.round((sta * 24 + sta * 5.25 + sta * 0.75) * 1.45);
    R.tmBait = { ai, ti, bmo: 35, pmo: 65, perim, sta };
    wgServices.push({ name: 'Termite Bait (Basic)', mo: 35 });
  }

  /* ── RODENT BAIT ─────────────────────────────────────────── */
  if (svcRodentBait && footprint > 0) {
    hasRec = true;
    const lg = footprint > 2500 || lotSqFt > 15000;
    const sm = footprint < 1500 && lotSqFt < 8000;
    const rmo = lg ? 109 : sm ? 75 : 89;
    R.rodBaitMo = rmo;
    R.rodBaitSize = lg ? 'Large' : sm ? 'Small' : 'Medium';
  }

  /* ═══════════ ONE-TIME ═══════════ */
  let hasOT = false, otItems = [];

  /* ── One-Time Pest ───────────────────────────────────────── */
  if (svcOnetimePest && footprint > 0) {
    hasOT = true;
    let bpp = R.pest ? R.pest.pa / (R.pest.rOG > 0 ? (1 + 0.15) : 1) : 117;
    if (!R.pest) {
      let adj = 0;
      adj += interpolate(footprint, [
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
      bpp = Math.max(89, 117 + adj);
    }
    const fp = otP(Math.max(150, Math.round(bpp * 1.30)));
    otItems.push({ name: 'OT Pest', price: fp, detail: 'Interior + exterior' });
  }

  /* ── One-Time Lawn ───────────────────────────────────────── */
  if (svcOnetimeLawn && lotSqFt > 0) {
    hasOT = true;
    let enhPA = 55 * 12 / 9;
    if (R.lawn && R.lawn[2]) enhPA = R.lawn[2].pa;
    let bl = Math.max(85, Math.round(enhPA * 1.30));
    let tm = 1.0, tl = 'Fertilization';
    if (otLawnType === 'WEED') { tm = 1.12; tl = 'Weed Control'; }
    else if (otLawnType === 'PEST') { tm = 1.30; tl = 'Lawn Pest'; }
    else if (otLawnType === 'FUNGICIDE') { tm = 1.38; tl = 'Fungicide'; }
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
    cp = Math.min(0.50, cp);
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
    const lhr = Math.min(6, Math.max(2, 1.5 + bcSqft / 1000));
    const cost = gal * BC_GAL + lhr * LABOR + BC_EQUIP;
    const fp = otP(Math.round(cost / 0.45));
    otItems.push({ name: 'Bora-Care', price: fp, detail: '~' + bcSqft.toLocaleString() + ' sf | ' + gal + ' gal | ' + lhr.toFixed(1) + ' hrs', atticIsEstimated, bcSqft, gal, lhr });
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
      if (footprint > 2500) hp = Math.round(hp * 1.10);
      else if (footprint < 1200) hp = Math.round(hp * 0.95);
      const fp = otP(hp);
      specItems.push({ name: 'Bed Bug Heat', price: fp, det: rm + ' room' + (rm > 1 ? 's' : '') + ' — ' + fmtInt(fp / rm) + '/room' });
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
  if (R.lawn) { ac++; ra += R.lawn[2].ann; }
  if (R.pest) { ac++; ra += R.pest.ann; }
  if (R.ts) { ac++; ra += R.ts[1].ann; }
  if (R.injection) { ac++; ra += R.injection.ann; }
  if (R.mq) {
    const ri = treeDensity === 'HEAVY' ? 2 : 1;
    if (R.mq[ri]) { ac++; ra += R.mq[ri].ann; }
  }
  if (R.tmBait) { ac++; ra += 35 * 12; }

  let wt = 'Bronze', wd = 0;
  if (ac >= 4) { wt = 'Platinum'; wd = 0.20; }
  else if (ac === 3) { wt = 'Gold'; wd = 0.15; }
  else if (ac === 2) { wt = 'Silver'; wd = 0.10; }
  else if (ac === 1) { wt = 'Bronze'; wd = 0; }
  const da = Math.round(ra * wd * 100) / 100;
  const ad = Math.round((ra - da) * 100) / 100;
  const mm = Math.round(ad / 12 * 100) / 100;

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
