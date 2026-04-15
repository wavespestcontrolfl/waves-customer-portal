// ============================================================
// modifiers.js — Property-driven pricing modifiers (ported from v2)
//
// Derives multiplicative / additive adjustments from an enriched property
// profile (year built, construction material, foundation, roof, water
// proximity, HOA, service zone) and exposes them to the service pricing
// functions. Keeps all the per-service math in service-pricing.js.
// ============================================================

// ── Year built → age-based pressure bump ─────────────────────
// Older homes = more entry points, harborage, termite history.
function pestAgeAdj(yearBuilt) {
  if (!yearBuilt) return 0;
  const age = new Date().getFullYear() - Number(yearBuilt);
  if (age >= 60) return 8;
  if (age >= 40) return 5;
  if (age >= 20) return 2;
  return 0;
}

// ── Construction material → termite + WDO multiplier ─────────
// Wood frame carries higher termite risk than block/ICF.
function constructionMult(material) {
  switch ((material || '').toUpperCase()) {
    case 'WOOD_FRAME': return 1.15;
    case 'STEEL_FRAME': return 0.95;
    case 'BLOCK':
    case 'CMU':
    case 'CONCRETE': return 1.0;
    case 'ICF': return 0.9;
    default: return 1.0;
  }
}

// ── Foundation → termite trenching difficulty ────────────────
// Crawlspace/raised require alternate treatment; slab is standard.
function foundationAdj(foundation) {
  switch ((foundation || '').toUpperCase()) {
    case 'CRAWLSPACE': return 150;
    case 'RAISED': return 100;
    case 'PIER_AND_BEAM': return 125;
    case 'SLAB':
    default: return 0;
  }
}

// ── Roof type → rodent bait station count ────────────────────
// Tile roofs provide nesting harborage for roof rats.
function rodentRoofAdj(roofType) {
  switch ((roofType || '').toUpperCase()) {
    case 'TILE': return 50;
    case 'METAL': return 20;
    case 'SHINGLE':
    default: return 0;
  }
}

// ── Water proximity → mosquito pressure multiplier ───────────
// Replaces v1's binary nearWater. 6-level graduated scale.
// levels: ADJACENT | CLOSE | NEAR | MODERATE | DISTANT | NONE
function mosquitoWaterMult(nearWater) {
  switch ((nearWater || '').toUpperCase()) {
    case 'ADJACENT': return 1.35;   // directly on waterfront
    case 'CLOSE':    return 1.20;   // <100 ft
    case 'NEAR':     return 1.10;   // 100-300 ft
    case 'MODERATE': return 1.05;   // 300-1000 ft
    case 'DISTANT':  return 1.02;   // >1000 ft but in watershed
    case 'NONE':
    default:         return 1.0;
  }
}

// ── Service zone → distance-based labor multiplier ───────────
// Zone A = local core, B = standard, C = reach, D = far
function zoneMultiplier(zone) {
  switch ((zone || 'A').toUpperCase()) {
    case 'A': return 1.0;
    case 'B': return 1.05;
    case 'C': return 1.12;
    case 'D': return 1.20;
    default:  return 1.0;
  }
}

// ── WDO inspection time (new construction vs old) ────────────
function wdoTimeMult(yearBuilt) {
  if (!yearBuilt) return 1.0;
  const age = new Date().getFullYear() - Number(yearBuilt);
  if (age >= 40) return 1.25;
  if (age >= 20) return 1.10;
  return 1.0;
}

// ── Master derivation — call once per estimate ───────────────
function deriveModifiers(profile = {}) {
  return {
    pestAgeAdj: pestAgeAdj(profile.yearBuilt),
    termiteConstructionMult: constructionMult(profile.constructionMaterial),
    termiteFoundationAdj: foundationAdj(profile.foundationType),
    wdoConstructionMult: constructionMult(profile.constructionMaterial),
    wdoFoundationAdj: foundationAdj(profile.foundationType),
    wdoTimeMult: wdoTimeMult(profile.yearBuilt),
    rodentRoofAdj: rodentRoofAdj(profile.roofType),
    mosquitoWaterMult: mosquitoWaterMult(profile.nearWater),
    zoneMult: zoneMultiplier(profile.serviceZone),
  };
}

// ── Field notes — surface structural flags to the tech ───────
function deriveNotes(profile = {}) {
  const notes = [];
  if (profile.foundationType === 'CRAWLSPACE' || profile.foundationType === 'RAISED') {
    notes.push({ type: 'STRUCTURE', priority: 'HIGH',
      text: `${profile.foundationType} foundation — termite trenching approach must be modified.` });
  }
  if ((profile.constructionMaterial || '').toUpperCase() === 'WOOD_FRAME') {
    notes.push({ type: 'STRUCTURE', priority: 'HIGH',
      text: 'Wood frame — elevated termite risk. Recommend Bora-Care + bait station monitoring.' });
  }
  if ((profile.roofType || '').toUpperCase() === 'TILE') {
    notes.push({ type: 'STRUCTURE', priority: 'MEDIUM',
      text: 'Tile roof — elevated roof rat risk. Barrel tiles provide nesting habitat.' });
  }
  if (profile.isHOA) {
    notes.push({ type: 'HOA', priority: 'MEDIUM',
      text: `HOA community${profile.hoaFee ? ` ($${profile.hoaFee}/mo)` : ''}. Verify chemical restrictions, insurance reqs, gate access.` });
  }
  if (profile.isRental) {
    notes.push({ type: 'OWNER', priority: 'MEDIUM',
      text: 'Rental / organization-owned. Confirm tenant authority or contact property manager.' });
  }
  if (profile.isNewHomeowner) {
    notes.push({ type: 'SALES', priority: 'HIGH',
      text: 'New homeowner — high bundle potential. Pitch WaveGuard Platinum.' });
  }
  return notes;
}

module.exports = {
  pestAgeAdj,
  constructionMult,
  foundationAdj,
  rodentRoofAdj,
  mosquitoWaterMult,
  zoneMultiplier,
  wdoTimeMult,
  deriveModifiers,
  deriveNotes,
};
