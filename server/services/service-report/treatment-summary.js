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

function buildTreatmentSummary(treatment) {
  const products = (treatment && Array.isArray(treatment.products)) ? treatment.products : [];
  if (!products.length) return null;
  const support = products.filter(isSupportProduct);
  const main = products.filter((p) => !isSupportProduct(p));
  if (!main.length) return null;

  // Active ingredient, not brand name (owner 2026-07-21 — brand names live
  // on the product cards; the narrative speaks in actives). Strip the label
  // percentage ("Dinotefuran 20%" → "dinotefuran"); fall back to the product
  // name when no active is recorded. Word-wise lowercase: element symbols and
  // short acronyms keep their case ("Iron + N" must not become "iron + n"),
  // and anything carrying digits ("0-0-25") is left untouched.
  const smartLower = (s) => String(s).split(/\s+/).map((w) => (
    /\d/.test(w) || (w.length <= 3 && /^[A-Z]+$/.test(w)) ? w : w.toLowerCase()
  )).join(' ');
  const activeName = (p) => {
    const active = String(p.activeIngredient || '').replace(/\s*\d+(\.\d+)?\s*%.*$/, '').trim();
    return active ? smartLower(active) : p.name;
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
  const list = (names.length === 1
    ? names[0]
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)
    + (sharedMethod ? ` (all applied as a ${sharedMethod})` : '');
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
    out += ' The systemic products are absorbed by the plants and keep working for several weeks after the visit.';
  }
  return out;
}

module.exports = { buildTreatmentSummary, METHOD_PHRASES };
