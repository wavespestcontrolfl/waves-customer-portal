/**
 * Plain-language "What we applied today" sentence for the report snapshot
 * hero (owner 2026-07-21: the summary card must actually summarize the
 * tech-chosen solutions — the structured product cards live far below).
 * Deterministic: built from the treatment products the builders already
 * classified. Product names are fine here — the Products Applied section
 * names them too; the no-product-names rule governs AI free-text only.
 */

const METHOD_PHRASES = {
  soil_drench: 'soil drench',
  foliar_spray: 'foliar spray',
  trunk_injection: 'trunk injection',
  granular_broadcast: 'granular application',
  broadcast_spray: 'broadcast application',
  spot_treatment: 'spot treatment',
  perimeter_spray: 'perimeter application',
  bait_placement: 'bait placement',
};

function isSupportProduct(p = {}) {
  // Mirrors the closeout derivation's support set (surfactants, wetting
  // agents, humectants, PGRs): these make NO treatment claim — a PGR-only
  // visit must not publish "Today we applied paclobutrazol..." beside a
  // derived-empty treatments_completed (codex P2 2026-07-22).
  return /surfactant|adjuvant|wetting|humectant|growth\s*regulator|\bpgr\b|paclobutrazol|trinexapac|prohexadione|primo\s*maxx|anuew|shortstop|moisture\s*manager|hydretain/i
    .test(`${p.name || ''} ${p.activeIngredient || ''} ${p.kind || ''}`);
}

function buildTreatmentSummary(treatment, { noTiming = false, categoryOnly = false } = {}) {
  const products = (treatment && Array.isArray(treatment.products)) ? treatment.products : [];
  if (!products.length) return null;
  const support = products.filter(isSupportProduct);
  const main = products.filter((p) => !isSupportProduct(p));
  if (!main.length) return null;

  // Active ingredient, not brand name (owner 2026-07-21 — brand names live
  // on the product cards; the narrative speaks in actives). Strip the label
  // percentage ("Dinotefuran 20%" → "dinotefuran"); fall back to the product
  // name when no active is recorded. Word-wise lowercase: element symbols and
  // short acronyms keep their case ("Iron + N" must not become "iron + n";
  // "Fe/Mg/Mn/S" and "Mn" keep proper-case symbols — codex P3 #3197 r1), and
  // anything carrying digits ("0-0-25") is left untouched. A token counts as
  // symbol notation when EVERY alphabetic segment is element-shaped (capital
  // + optional lowercase letter) — "Iron" (4 letters) still lowercases.
  const isSymbolToken = (w) => {
    const segments = String(w).split(/[^A-Za-z]+/).filter(Boolean);
    return segments.length > 0 && segments.every((seg) => /^[A-Z][a-z]?$/.test(seg));
  };
  const smartLower = (s) => String(s).split(/\s+/).map((w) => (
    /\d/.test(w) || (w.length <= 3 && /^[A-Z]+$/.test(w)) || isSymbolToken(w) ? w : w.toLowerCase()
  )).join(' ');
  // A combination pre-emergent + fertilizer names its analysis in one of two
  // shapes. The legacy catalog string carries it after the active
  // ("prodiamine 0.43% + 15-0-15"): the percentage strip below would drop it
  // and the report would name only the herbicide, so a bare N-P-K segment is
  // pulled out first. The v13 catalog migration creates the same rows with the
  // active alone ("Prodiamine" / "Dithiopyr") and the analysis only in the
  // product name ("LESCO Stonewall 0.43% 15-0-15 ..."): for a pre-emergent
  // whose active carries no analysis, read it from the name. A string with no
  // percentage active ("24-0-11", "Nitrogen 20-0-0 + micros") is untouched.
  const NPK_SEGMENT = /^\d{1,2}-\d{1,2}-\d{1,2}$/;
  const NPK_IN_NAME = /(?:^|[^\d-])(\d{1,2}-\d{1,2}-\d{1,2})(?![\d-])/;
  const activeName = (p) => {
    const raw = String(p.activeIngredient || '').trim();
    const segments = raw.split(/\s*\+\s*/);
    const fertilizer = segments.find((s) => NPK_SEGMENT.test(s));
    const others = segments.filter((s) => !NPK_SEGMENT.test(s)).join(' + ');
    const combined = fertilizer && /\d\s*%/.test(others);
    const active = (combined ? others : raw).replace(/\s*\d+(\.\d+)?\s*%.*$/, '').trim();
    if (!active) return p.name;
    if (combined) return `${smartLower(active)} with ${fertilizer} fertilizer`;
    if (p.kind === 'pre_emergent' && !fertilizer && !/\d{1,2}-\d{1,2}-\d{1,2}/.test(raw)) {
      const fromName = NPK_IN_NAME.exec(String(p.name || ''));
      if (fromName) return `${smartLower(active)} with ${fromName[1]} fertilizer`;
    }
    return smartLower(active);
  };
  // Every product applied the same way → say the method ONCE after the list.
  // Four "(broadcast application)" parentheticals in one sentence read as
  // machine output (owner 2026-08-04). Mixed methods keep the per-item tag.
  const methodOf = (p) => METHOD_PHRASES[String(p.method || '').toLowerCase()] || null;
  const sharedMethod = main.length > 1 && methodOf(main[0])
    && main.every((p) => methodOf(p) === methodOf(main[0]))
    ? methodOf(main[0]) : null;
  const names = main.map((p) => {
    const method = sharedMethod ? null : methodOf(p);
    return `${activeName(p)}${method ? ` (${method})` : ''}`;
  });
  let list = (names.length === 1
    ? names[0]
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)
    + (sharedMethod ? ` (all applied as a ${sharedMethod})` : '');
  if (categoryOnly) {
    // GATE_LAWN_REPORT_COPY_FIXES (owner 2026-10-08): no active ingredient or product name in a
    // sentence, only the category words from the Visit Summary phrase table; names stay on the
    // product cards. A method is said only when every product shares it.
    const phrases = require('./lawn-visit-summary').appliedCategoryPhrases(main);
    const everyMethod = methodOf(main[0]) && main.every((p) => methodOf(p) === methodOf(main[0])) ? methodOf(main[0]) : null;
    const joined = phrases.length <= 1 ? phrases.join('') : `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}`;
    list = joined + (everyMethod ? (main.length > 1 ? ` (all applied as a ${everyMethod})` : ` (${everyMethod})`) : '');
  }
  const targets = [...new Set(
    main.flatMap((p) => (Array.isArray(p.targets) ? p.targets : []).map((t) => String(t || '').trim().toLowerCase()).filter(Boolean)),
  )].slice(0, 3);

  const targetList = targets.length === 1
    ? targets[0]
    : `${targets.slice(0, -1).join(', ')} and ${targets[targets.length - 1]}`;
  let out = `Today we applied ${list}`;
  // Targets are what the products are chosen to CONTROL — not a claim that the
  // pest was observed. "…activity we found" contradicted routine-visit summaries
  // ("no specific concerns observed") on the same report (audit 2026-07-28).
  if (targets.length) out += `, targeting ${targetList}`;
  // Only TRUE surfactants/adjuvants earn the coating sentence — humectants
  // and PGRs are support products but not surfactants (codex P2 r15).
  const hasSurfactant = support.some((p) => /surfactant|adjuvant|wetting/i.test(`${p.name || ''} ${p.activeIngredient || ''}`));
  out += hasSurfactant
    ? ', with a surfactant added so the treatment coats the foliage evenly.'
    : '.';
  if (main.some((p) => p.kind === 'systemic')) {
    // noTiming (lawn under GATE_LAWN_REPORT_COPY_V6): result timing reaches
    // the customer only as an owner-approved "What to expect" sentence.
    out += noTiming
      ? ' The systemic products are absorbed by the plants and keep working after the visit.'
      : ' The systemic products are absorbed by the plants and keep working for several weeks after the visit.';
  }
  return out;
}

module.exports = { buildTreatmentSummary, isSupportProduct, METHOD_PHRASES };
