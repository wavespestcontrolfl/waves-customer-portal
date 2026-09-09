const photo = (data, zone) => ({ data, mimeType: 'image/jpeg', ...(zone ? { zone } : {}) });
const sig = (level, confidence = 'moderate', evidence = 'seen') => ({ level, evidence, confidence });
const finding = (overrides = {}) => ({
  finding_id: 'F1', name: 'Irregular browning along the driveway edge', confidence: 'moderate', severity: 'moderate',
  spread_risk: 'moderate', estimated_area_affected: 'one section', urgency: 'follow_up', photo_refs: [1, 2, 9, 1],
  zone: 'FRONT', observed_evidence: ['tan patch photo 1'], inferred_context: [], negative_evidence: ['no lesions seen'],
  confirmation_step: 'float test', can_determine: true, cannot_determine_reason: '', customer_wording: 'One edge is stressed.',
  ...overrides,
});
const answer = (overrides = {}) => ({
  photo_quality: [{ photo: 1, quality: 'adequate', issue: '' }, { photo: 2, quality: 'poor', issue: 'blurred' }, { photo: 7, quality: 'adequate', issue: '' }],
  grass_type: 'st_augustine',
  findings: [finding(), finding({ finding_id: 'F2', name: 'Chinch bug damage', confidence: 'low' })],
  severities: {
    fungal_activity: sig('minor'), insect_damage: sig('unknown', 'unknown', ''), drought_stress: sig('moderate'),
    mechanical_damage: sig('none'), thatch_visibility: sig('moderate'), overwatering_signal: sig('yes', 'high', 'mushrooms photo 2'),
  },
  scores: { turf_density: { determinable: true, value: 72 }, weed_coverage: { determinable: true, value: 15 }, color_health: { determinable: false, value: 0 } },
  observations: 'Dense turf with one dry edge; photos were adequate.',
  ...overrides,
});

const complete = (severities, scores) => ({ status: 'complete', observations: 'obs', severities, scores });
const sev = (levels) => Object.fromEntries(Object.entries(levels).map(([key, level]) => [key, sig(level)]));

module.exports = { photo, sig, finding, answer, complete, sev };
