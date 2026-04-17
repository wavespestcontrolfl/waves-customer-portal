// ============================================================
// v2-legacy-mapper.js
//
// Remaps v2 engine output to the v1-shaped envelope EstimatePage
// consumes (`R.lawn[]`, `R.pestTiers[]`, etc). Extracted from
// property-lookup-v2.js during Session 6 harness hardening. Will be
// retired alongside v2 in Session 11 when v1 emits the full shape
// natively.
//
// Behavior-preserving extraction. Do not refactor, reorder, or
// "clean up" — byte-identical to the route's inline logic.
// ============================================================

function mapV2ToLegacyShape(v2, selectedServices) {
  // ── Build v1-compatible "results" (R) object from v2 ──
  const R = {};
  const rec = v2.recurring || {};
  const wg = v2.waveguard || {};
  const totals = v2.totals || {};

  // Lawn → R.lawn[], R.lawnMeta
  if (rec.lawn) {
    const l = rec.lawn;
    R.lawn = (l.tiers || []).map((t, i) => ({
      pa: t.perApp, v: t.visits, ann: t.annual, mo: t.monthly,
      name: t.label?.replace('/yr', '') || ['Basic','Standard','Enhanced','Premium'][i] || `${t.visits}x`,
      recommended: !!t.recommended, dimmed: !t.recommended,
      hasLandscape: t.visits >= 12,
    }));
    R.lawnMeta = { lsf: l.turfSf || 0, sc: 0, tf: 0, oa: 0 };
  }

  // Pest → R.pestTiers[], R.pest, R.pestRoachMod
  if (rec.pest) {
    const p = rec.pest;
    R.pestTiers = (p.tiers || []).map(t => ({
      pa: t.perApp, apps: t.freq, ann: t.annual, mo: t.monthly,
      init: p.initialFee || 0, rOG: p.roachAdj || 0,
      label: t.label, recommended: !!t.recommended, dimmed: !t.recommended,
    }));
    const sel = p.selected || p.tiers?.find(t => t.recommended) || p.tiers?.[0] || {};
    R.pest = {
      pa: sel.perApp || 0, apps: sel.freq || 4, ann: sel.annual || 0, mo: sel.monthly || 0,
      init: p.initialFee || 0, rOG: p.roachAdj || 0, label: sel.label || 'Quarterly',
    };
    R.pestRoachMod = p.roachModifier || 'NONE';
  }

  // Tree & Shrub → R.ts[], R.tsMeta, R.injection
  if (rec.treeShrub) {
    const ts = rec.treeShrub;
    R.ts = (ts.tiers || []).map((t, i) => ({
      pa: t.perApp, v: t.visits, ann: t.annual, mo: t.monthly,
      name: t.label?.replace('/yr', '') || ['Standard','Enhanced'][i] || `${t.visits}x`,
      recommended: !!t.recommended, dimmed: !t.recommended,
    }));
    R.tsMeta = { eb: ts.bedArea || 0, et: ts.treeCount || 0, bedAreaIsEstimated: false };
    if (ts.injection && ts.palmCount > 0) {
      R.injection = { palms: ts.injection.palms, ann: ts.injection.annual, mo: ts.injection.monthly };
    }
  }

  // Mosquito → R.mq[], R.mqMeta
  if (rec.mosquito) {
    const mq = rec.mosquito;
    let ri = 1;
    R.mq = (mq.tiers || []).map((t, i) => {
      if (t.recommended) ri = i;
      return { pv: t.perVisit, v: t.visits, ann: t.annual, mo: t.monthly, n: t.name, recommended: !!t.recommended, dimmed: !t.recommended };
    });
    R.mqMeta = { pr: mq.pressure || 1, sz: mq.lotSize || 'SMALL', ri };
  }

  // Termite Bait → R.tmBait
  if (rec.termiteBait) {
    const tb = rec.termiteBait;
    R.tmBait = {
      ai: tb.advance?.install || 0, ti: tb.trelona?.install || 0,
      bmo: tb.advance?.basicMo || 35, pmo: tb.trelona?.premierMo || 65,
      perim: tb.perimeter || 0, sta: tb.stations || 0,
    };
  }

  // Rodent Bait → R.rodBaitMo, R.rodBaitSize
  if (rec.rodentBait) {
    const rb = rec.rodentBait;
    const recTier = rb.recommended || (rb.tiers || []).find(t => t.recommended) || rb.tiers?.[0];
    R.rodBaitMo = recTier?.moLow || 0;
    R.rodBaitSize = rb.stations >= 6 ? 'Large' : rb.stations <= 4 ? 'Small' : 'Medium';
  }

  // One-time items from v2
  const otItems = (totals.oneTimeItems || []).map(i => ({ name: i.name, price: i.price, detail: '' }));
  const specItems = (totals.specialtyItems || []).map(i => ({ name: i.name, price: i.price, det: '', onProg: false }));

  // One-time service details from v2.oneTime
  const ot = v2.oneTime || {};
  const v1OtItems = [];
  Object.values(ot).forEach(item => {
    if (!item || typeof item !== 'object') return;
    if (item.tiers) {
      // Top dressing, etc. with tiers
      const rec = item.tiers.find(t => t.recommended) || item.tiers[0];
      if (rec) v1OtItems.push({ name: item.name || item.service || 'Service', price: rec.price || 0, detail: rec.detail || '', tierName: rec.name });
      if (item.name === 'Top Dressing' || item.service === 'Top Dressing') {
        R.tdTiers = item.tiers.map(t => ({ name: t.name, detail: t.detail || '', price: t.price }));
      }
    } else if (item.price) {
      v1OtItems.push({
        name: item.name || item.service || 'Service', price: item.price,
        detail: item.detail || '',
        spacing: item.spacing, warn6: item.warn6,
        lawnType: item.lawnType, tierName: item.tierName,
        atticIsEstimated: item.atticIsEstimated,
        basePrice: item.basePrice, warrAdd: item.warrAdd,
      });
      if (item.name === 'Trenching') R.trench = true;
    }
  });

  // Specialty items from v2.specialty
  const v1SpecItems = [];
  const spec = v2.specialty || {};
  Object.values(spec).forEach(item => {
    if (!item || typeof item !== 'object') return;
    if (item.methods) {
      item.methods.forEach(m => v1SpecItems.push({ name: `${item.name} (${m.method})`, price: m.price, det: m.detail || '', onProg: false }));
    } else if (item.includedOnProgram) {
      v1SpecItems.push({ name: item.name, price: 0, det: `Included on ${R.pest?.label || 'pest'} program`, onProg: true });
    } else if (item.price > 0) {
      v1SpecItems.push({ name: item.name, price: item.price, det: item.detail || '', onProg: false });
    }
  });

  const serviceCount = wg.serviceCount || 0;
  const tmInstall = totals.oneTimeItems?.find(i => i.name?.includes('Trelona'))?.price || 0;
  const oneTimeTotal = totals.oneTimeTotal || 0;

  const mapped = {
    property: v2.property,
    fieldVerify: v2.fieldVerify || [],
    notes: v2.notes || [],
    urgency: v2.urgency,
    recurringCustomer: v2.recurringCustomer,
    isRecurringCustomer: v2.recurringCustomer,
    hasRecurring: serviceCount > 0,
    hasOneTime: v1OtItems.length > 0,
    recurring: {
      serviceCount,
      tier: wg.tier || 'Bronze',
      waveGuardTier: wg.tier || 'Bronze',
      discount: wg.discountPct || 0,
      annualBeforeDiscount: wg.annualBeforeDiscount || 0,
      grandTotal: totals.recurringMonthly || 0,
      monthlyTotal: wg.monthlyAfterDiscount || 0,
      annualAfterDiscount: wg.annualAfterDiscount || 0,
      savings: wg.savings || 0,
      rodentBaitMo: totals.rodentBaitMonthly || 0,
      services: (wg.services || []).map(s => ({ name: s.name, mo: s.monthly || s.mo || 0, monthly: s.monthly || s.mo || 0 })),
    },
    oneTime: {
      items: v1OtItems,
      specItems: v1SpecItems.filter(s => !s.onProg && s.price > 0).map(s => ({ name: s.name, price: s.price })),
      total: oneTimeTotal,
      tmInstall,
      otSubtotal: oneTimeTotal - tmInstall,
    },
    totals: {
      year1: totals.year1 || 0,
      year2: totals.year2 || 0,
      year2mo: totals.year2Monthly || 0,
      manualDiscount: totals.manualDiscount || null,
    },
    manualDiscount: totals.manualDiscount || null,
    results: R,
    specItems: v1SpecItems,
  };

  return mapped;
}

module.exports = { mapV2ToLegacyShape };
