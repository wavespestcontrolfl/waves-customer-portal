import React from 'react';
import { POISON_CONTROL_PHONE_DISPLAY, POISON_CONTROL_PHONE_TEL } from '../../constants/business';

// Project types whose visit can leave a product on the property, and the
// recorded findings that prove this one did — the project report carries
// the Poison Control line only on that evidence (Codex r1 on #5032: an
// inspection-only, deferred or heat-only visit of a treatment type applied
// nothing). Positive evidence only, so an option added later never claims
// an application until it is listed here; PoisonControlCopy.test.js pins
// every value to the server registry (server/services/project-types.js).
// A rule without `values` is free text: any real entry counts.
// `true`: the visit itself is the evidence — rodent bait stations hold
// rodenticide whatever was serviced (owner 2026-09-26). Termite bait
// stations, inspections, exclusion/trapping and the WDO / pre-construction
// paper documents never carry the line.
export const PROJECT_APPLICATION_EVIDENCE = {
  termite_treatment: [
    { field: 'products_used' },
    { field: 'epa_registration' },
    { field: 'treatment_method', values: ['Spot treatment', 'Liquid perimeter', 'Trenching', 'Rodding', 'Foam / void injection', 'Drill-and-inject', 'Wood treatment'] },
  ],
  one_time_pest_treatment: [
    { field: 'products_used' },
    { field: 'work_completed', values: ['Exterior perimeter application', 'Interior crack & crevice application', 'Targeted spot treatment', 'Bait placement', 'Insect growth regulator applied', 'Dust applied to labeled voids', 'Nest treated', 'Individual mound treatment', 'Broadcast lawn application'] },
  ],
  one_time_lawn_treatment: [
    { field: 'work_completed', values: ['Fertilizer applied', 'Weed control applied', 'Insect control applied', 'Disease control applied', 'Iron / micronutrients applied', 'Biostimulant applied', 'Soil amendment applied', 'Wetting agent applied', 'Spot treatment completed'] },
  ],
  flea: [
    { field: 'treatment_completed', values: ['Exterior flea treatment', 'Interior flea treatment', 'Growth regulator', 'Crack / crevice treatment', 'Lawn treatment', 'Pet resting area treatment', 'Limited treatment'] },
  ],
  cockroach: [
    { field: 'work_completed', values: ['Bait placement', 'Insect growth regulator', 'Crack & crevice treatment', 'Dust application', 'Flush-out treatment', 'Exterior perimeter treatment'] },
  ],
  german_roach_knockdown: [
    { field: 'treatment_completed', values: ['Gel bait', 'Insect growth regulator', 'Crack & crevice treatment', 'Dust application', 'Appliance-area treatment', 'Cabinet hinge treatment', 'Plumbing penetration treatment'] },
  ],
  palmetto_roach_knockdown: [
    { field: 'treatment_completed', values: ['Interior crack & crevice', 'Exterior perimeter treatment', 'Garage treatment', 'Attic / void treatment', 'Drain / moisture area treatment', 'Bait placement', 'Dust application'] },
  ],
  bed_bug: [
    { field: 'treatment_method', values: ['Hybrid heat + chemical treatment', 'Chemical / IPM treatment', 'Targeted follow-up treatment', 'Chemical only', 'Chemical + heat', 'Steam + chemical'] },
    { field: 'work_completed', values: ['Crack & crevice treatment', 'Mattress / box spring treatment', 'Bed frame treatment', 'Baseboard treatment', 'Furniture treatment', 'Dust application'] },
  ],
  mosquito_event: [
    { field: 'treatment_completed', values: ['Barrier treatment', 'Adulticide treatment', 'Larvicide applied', 'Resting-site treatment'] },
  ],
  palm_injection: [
    { field: 'work_completed', values: ['Palm fertilizer applied', 'Liquid micronutrient treatment', 'Soil drench', 'Insect treatment', 'Disease treatment', 'Palm injection completed', 'Soil acidifier applied'] },
  ],
  tree_shrub: [
    { field: 'treatments_completed', values: ['Fertilizer', 'Palm fertilizer', 'Micronutrients', 'Insect treatment', 'Disease / fungicide treatment', 'Horticultural oil', 'Soil drench', 'Foliar treatment', 'Pre-emergent bed treatment', 'Weed spot treatment', 'Soil amendment / acidifier'] },
  ],
  rodent_bait_station: true,
  rodent_sanitation: [
    { field: 'sanitation_work_completed', values: ['Disinfected / sanitized affected areas'] },
  ],
};

// Chips are stored comma-joined (multi-selects as arrays); a free-text
// "None" / "N/A" is not an entry.
function findingAnswers(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  return list.map((v) => String(v ?? '').trim()).filter((v) => v && !/^(none|n\/?a|-+)$/i.test(v));
}

function findingsShowApplication(rules, findings) {
  if (!findings || typeof findings !== 'object') return false;
  return rules.some(({ field, values }) => {
    const answers = findingAnswers(findings[field]);
    if (!values) return answers.length > 0;
    const wanted = new Set(values.map((v) => v.toLowerCase()));
    return answers.some((answer) => wanted.has(answer.toLowerCase()));
  });
}

// The visit or its follow-up (bed bug) recorded an application.
export function projectAppliedProduct(projectType, findings, followupFindings) {
  const rules = PROJECT_APPLICATION_EVIDENCE[projectType];
  if (rules === true) return true;
  if (!Array.isArray(rules)) return false;
  return findingsShowApplication(rules, findings) || findingsShowApplication(rules, followupFindings);
}

// F.S. 482.2265(1)(b): a customer may ask for the ID card number of the
// person applying the pesticide — owner 2026-09-26: print it instead, in
// the same block as Poison Control. The server withholds a blank number or
// one that had expired by the service date, so null means "don't print".
export function applicatorIdLine(technicianName, fdacsId) {
  const id = String(fdacsId || '').trim();
  if (!id) return null;
  const name = String(technicianName || '').trim();
  return name ? `Applicator: ${name} · FDACS ID card #${id}` : `Applicator FDACS ID card #${id}`;
}

// One Poison Control sentence for every report surface that records a
// product application — the glass service report, its PDF document and the
// treatment project reports. Each surface supplies its own label and
// styling; the wording and the tap-to-call link live only here.
//
// Compliance copy rules (AGENTS.md): no "safe" claim and no re-entry
// figure — this only says who to call. listsProducts is true only where the
// same page prints the product names, so the "keep this report handy" line
// never points at a list that isn't there.
export default function PoisonControlCopy({ listsProducts = false, linkStyle }) {
  return (
    <>
      If someone swallows, breathes in, or gets a product on their skin or in their eyes, call
      Poison Control at{' '}
      <a href={POISON_CONTROL_PHONE_TEL} style={linkStyle}>{POISON_CONTROL_PHONE_DISPLAY}</a>
      {' '}— free and confidential, 24/7.
      {listsProducts ? ' Keep this report handy when you call; it names each product applied.' : ''}
      {' '}In a medical emergency, call 911.
    </>
  );
}
