// ============================================================
// v1-legacy-mapper.js
//
// Remaps v1 generateEstimate output `{summary, lineItems, waveGuard, ...}`
// to the legacy envelope that EstimatePage consumes (`R.lawn[]`,
// `R.pestTiers[]`, `recurring.services[]`, etc).
//
// Mirrors the shape emitted by v2-legacy-mapper.js, so swapping the
// engine at the `/calculate-estimate` adapter (Session 11a) doesn't
// change what the UI receives. Deletable as a unit in Session 11b
// when EstimatePage migrates off the legacy shape.
// ============================================================

const RECURRING_SERVICES = new Set([
  'pest_control', 'lawn_care', 'tree_shrub', 'palm_injection',
  'mosquito', 'termite_bait', 'rodent_bait',
]);

const ONE_TIME_SERVICES = new Set([
  'one_time_pest', 'one_time_lawn', 'one_time_mosquito',
  'top_dressing', 'dethatching', 'plugging', 'trenching',
  // Session 11a Step 2b-3: auto-fire from recurring pest roachModifier='GERMAN'.
  // Mirrors v2-legacy-mapper treating oneTime.germanRoachInitial as a one-time item.
  'german_roach_initial',
  // Auto-fired by estimate-engine when recurring pest carries roachType !== 'none'.
  // Surfaces in the customer-facing estimate's first-visit-fees stack.
  'pest_initial_roach',
]);

const CAP = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

const SERVICE_LABEL = {
  one_time_pest: 'One-Time Pest',
  one_time_lawn: 'One-Time Lawn',
  one_time_mosquito: 'One-Time Mosquito',
  top_dressing: 'Top Dressing',
  dethatching: 'Dethatching',
  plugging: 'Plugging',
  trenching: 'Trenching',
  bora_care: 'Bora-Care',
  pre_slab_termidor: 'Pre-Slab Termidor',
  bed_bug_chemical: 'Bed Bug (Chemical)',
  bed_bug_heat: 'Bed Bug (Heat)',
  bed_bug: 'Bed Bug',
  wdo: 'WDO Inspection',
  flea: 'Flea Treatment',
  german_roach: 'German Roach',
  german_roach_initial: 'German Roach Initial (3-Visit)',
  pest_initial_roach: 'Initial Roach Knockdown',
  stinging: 'Stinging Insect',
  exclusion: 'Exclusion',
  rodent_trapping: 'Rodent Trapping',
  rodent_guarantee: 'Rodent Guarantee',
  foam_drill: 'Foam Drill',
  rodent_plugging: 'Rodent Plugging',
  termite_foam: 'Termite Foam',
  stinging_v2: 'Stinging Insect',
  exclusion_v2: 'Exclusion',
  rodent_guarantee_combo: 'Rodent Guarantee',
};

const labelFor = svc => SERVICE_LABEL[svc] || svc;

function mapV1ToLegacyShape(v1Result) {
  const R = {};
  const lineItems = v1Result.lineItems || [];
  const wg = v1Result.waveGuard || {};
  const summary = v1Result.summary || {};

  const pestLI = lineItems.find(l => l.service === 'pest_control');
  const lawnLI = lineItems.find(l => l.service === 'lawn_care');
  const tsLI = lineItems.find(l => l.service === 'tree_shrub');
  const palmLI = lineItems.find(l => l.service === 'palm_injection');
  const mqLI = lineItems.find(l => l.service === 'mosquito');
  const tbLI = lineItems.find(l => l.service === 'termite_bait');
  const rbLI = lineItems.find(l => l.service === 'rodent_bait');

  // Pest → R.pest, R.pestTiers
  if (pestLI) {
    R.pestTiers = (pestLI.tiers || []).map(t => ({
      pa: t.perApp, apps: t.freq, ann: t.annual, mo: t.monthly,
      init: pestLI.initialFee || 0, rOG: pestLI.roachAddOn || 0,
      label: t.label, recommended: !!t.recommended, dimmed: !t.recommended,
    }));
    const sel = (pestLI.tiers || []).find(t => t.recommended) || (pestLI.tiers || [])[0] || {};
    R.pest = {
      pa: sel.perApp ?? pestLI.perApp,
      apps: sel.freq ?? pestLI.visitsPerYear,
      ann: sel.annual ?? pestLI.annual,
      mo: sel.monthly ?? pestLI.monthly,
      init: pestLI.initialFee || 0,
      rOG: pestLI.roachAddOn || 0,
      label: sel.label || 'Quarterly',
    };
    // Session 11a Step 2b-3: uppercase to match v2-legacy-mapper output.
    // pestLI.roachType is lowercase (german/regular/none) per service-pricing.
    R.pestRoachMod = (pestLI.roachType || 'none').toUpperCase();
  }

  // Lawn → R.lawn, R.lawnMeta
  // Name convention: "{visits}x" to match v2-legacy-mapper output.
  if (lawnLI) {
    R.lawn = (lawnLI.tiers || []).map(t => ({
      pa: t.perApp, v: t.visits, ann: t.annual, mo: t.monthly,
      name: `${t.visits}x`,
      recommended: !!t.recommended, dimmed: !t.recommended,
      hasLandscape: t.visits >= 12,
    }));
    R.lawnMeta = { lsf: lawnLI.lawnSqFt || 0, sc: 0, tf: 0, oa: 0 };
  }

  // Tree & Shrub → R.ts, R.tsMeta
  if (tsLI) {
    R.ts = [{
      pa: tsLI.perApp, v: tsLI.frequency, ann: tsLI.annual, mo: tsLI.monthly,
      name: tsLI.tier === 'enhanced' ? 'Enhanced' : 'Standard',
      recommended: true, dimmed: false,
    }];
    R.tsMeta = {
      eb: tsLI.bedArea || 0,
      et: tsLI.treeCount || 0,
      bedAreaIsEstimated: false,
    };
  }

  // Palm Injection → R.injection
  if (palmLI) {
    R.injection = {
      palms: palmLI.palmCount,
      ann: palmLI.annual,
      mo: palmLI.monthly,
    };
  }

  // Mosquito → R.mq, R.mqMeta
  if (mqLI) {
    let ri = 1;
    R.mq = (mqLI.tiers || []).map((t, i) => {
      if (t.recommended) ri = i;
      return {
        pv: t.perVisit, v: t.visits, ann: t.annual, mo: t.monthly,
        n: t.name,
        recommended: !!t.recommended, dimmed: !t.recommended,
      };
    });
    R.mqMeta = {
      pr: mqLI.pressureMultiplier || 1,
      sz: mqLI.lotCategory || 'SMALL',
      ri,
    };
  }

  // Termite Bait → R.tmBait
  // v1 only emits the selected system's price (trelona OR advance), so the
  // opposite system falls back to defaults matching v2-legacy-mapper.
  if (tbLI) {
    const installPrice = tbLI.installation?.price || 0;
    const monMonthly = tbLI.monitoring?.monthly || 0;
    R.tmBait = {
      ai: tbLI.system === 'advance' ? installPrice : 0,
      ti: tbLI.system === 'trelona' ? installPrice : 0,
      bmo: tbLI.monitoringTier === 'basic' ? monMonthly : 35,
      pmo: tbLI.monitoringTier === 'premier' ? monMonthly : 65,
      perim: tbLI.perimeter || 0,
      sta: tbLI.stations || 0,
    };
  }

  // Rodent Bait → R.rodBaitMo, R.rodBaitSize
  if (rbLI) {
    R.rodBaitMo = rbLI.monthly || 0;
    const sz = (rbLI.size || '').toLowerCase();
    R.rodBaitSize = sz === 'small' ? 'Small' : sz === 'large' ? 'Large' : 'Medium';
  }

  // Recurring services[] — pre-discount monthlies, matching v2-legacy-mapper
  // convention (see v2-legacy-mapper.js:159). Order matches v2's wg.services:
  // lawn → pest → tree_shrub → mosquito → termite_bait.
  const services = [];
  const svcAdd = (name, li) => {
    if (!li) return;
    const mo = li.monthly || 0;
    services.push({ name, mo, monthly: mo });
  };
  svcAdd('Lawn Care', lawnLI);
  svcAdd('Pest Control', pestLI);
  svcAdd('Tree & Shrub', tsLI);
  svcAdd('Mosquito', mqLI);
  svcAdd('Termite Bait', tbLI);

  // One-time + specialty split
  const v1OtItems = [];
  const v1SpecItems = [];
  lineItems.forEach(li => {
    if (RECURRING_SERVICES.has(li.service)) return;
    // Prefer the engine's own label when present (e.g. pest_initial_roach
    // emits 'Initial Native Roach Knockdown' vs 'Initial German Roach
    // Knockdown' — SERVICE_LABEL flattens both to a generic name and would
    // drop the species distinction). Fall back to the SERVICE_LABEL map for
    // legacy services that don't set a label themselves.
    const name = li.label || labelFor(li.service);
    const price = li.price || 0;
    const detail = li.detail || '';
    if (ONE_TIME_SERVICES.has(li.service)) {
      // Preserve `service` on the mapped item so consumers can match by
      // canonical key (e.g. estimate-public's findInitialRoachItem) without
      // depending on display labels that may be re-translated downstream.
      const item = { service: li.service, name, price, detail };
      if (li.spacing !== undefined) item.spacing = li.spacing;
      if (li.lawnType !== undefined) item.lawnType = li.lawnType;
      if (li.tierName !== undefined) item.tierName = li.tierName;
      v1OtItems.push(item);
      if (li.service === 'trenching') R.trench = true;
    } else {
      v1SpecItems.push({
        service: li.service, name, price, det: detail,
        onProg: !!li.includedOnProgram,
      });
    }
  });

  // Termite installation → one-time items
  let tmInstall = 0;
  if (tbLI && (tbLI.installation?.price || 0) > 0) {
    tmInstall = tbLI.installation.price;
    v1OtItems.push({
      name: `${CAP(tbLI.system)} Installation`,
      price: tmInstall,
      detail: `${tbLI.stations} stations`,
    });
  }

  // v2 convention: WaveGuard Membership ($99 initial fee) counts in
  // oneTime.total but NOT in oneTime.items[]. Match that.
  const membershipFee = pestLI?.initialFee || 0;

  const oneTimeItemsMoney = v1OtItems.reduce((s, i) => s + (i.price || 0), 0);
  const specialtyMoney = v1SpecItems
    .filter(s => !s.onProg)
    .reduce((s, i) => s + (i.price || 0), 0);
  const oneTimeTotal = oneTimeItemsMoney + specialtyMoney + membershipFee;

  const waveGuardTier = CAP(wg.tier || 'bronze');
  const recurringMonthly = summary.recurringMonthlyAfterDiscount || 0;
  const recurringAnnual = summary.recurringAnnualAfterDiscount || 0;
  const rodentBaitMonthly = rbLI ? (rbLI.monthly || 0) : 0;
  const rodentBaitAnnual = rodentBaitMonthly * 12;

  // year1: recurring year + one-time items + specialty + membership.
  // v1's summary.year1Total doesn't include membership — we fix it here
  // to match v2's year1 convention.
  const year1 = Math.round((recurringAnnual + oneTimeTotal) * 100) / 100;
  const year2 = Math.round(recurringAnnual * 100) / 100;

  // Project v1 features back onto flat v2-shape keys so EstimatePage's
  // client-side modifiers fallback (which predates Session 11a and reads
  // `p.poolCage === 'YES'`, `p.shrubDensity`, `p.hasLargeDriveway`, etc.)
  // renders correctly without touching the engine output shape.
  const vp = v1Result.property || {};
  const vf = vp.features || {};
  const upper = v => (v ? String(v).toUpperCase() : '');
  const legacyProperty = {
    ...vp,
    pool: vf.pool ? 'YES' : 'NO',
    poolCage: vf.poolCage ? 'YES' : 'NO',
    hasLargeDriveway: !!vf.largeDriveway,
    shrubDensity: upper(vf.shrubs),
    treeDensity: upper(vf.trees),
    landscapeComplexity: upper(vf.complexity),
  };

  return {
    property: legacyProperty,
    fieldVerify: [],
    notes: v1Result.notes || [],
    urgency: { mult: 1, label: '' },
    recurringCustomer: false,
    isRecurringCustomer: false,
    hasRecurring: services.length > 0,
    hasOneTime: v1OtItems.length > 0,
    recurring: {
      serviceCount: wg.qualifyingCount || 0,
      tier: waveGuardTier,
      waveGuardTier,
      discount: wg.discount || 0,
      annualBeforeDiscount: summary.recurringAnnualBeforeDiscount || 0,
      grandTotal: recurringMonthly,
      monthlyTotal: recurringMonthly,
      annualAfterDiscount: recurringAnnual,
      savings: Math.round((summary.waveGuardSavings || 0) * 100) / 100,
      rodentBaitMo: rodentBaitMonthly,
      services,
    },
    oneTime: {
      items: v1OtItems,
      specItems: v1SpecItems
        .filter(s => !s.onProg && s.price > 0)
        .map(s => ({ name: s.name, price: s.price })),
      total: oneTimeTotal,
      tmInstall,
      // Kept out of items[] by legacy v2 convention, but surfaced
      // explicitly so the customer-facing estimate can render it as
      // its own line with the "waived with annual prepay" note.
      membershipFee,
      otSubtotal: oneTimeTotal - tmInstall,
    },
    totals: {
      year1,
      year2,
      year2mo: summary.year2Monthly || recurringMonthly,
      manualDiscount: summary.manualDiscount || null,
    },
    manualDiscount: summary.manualDiscount || null,
    results: R,
    specItems: v1SpecItems,
  };
}

module.exports = { mapV1ToLegacyShape };
