/**
 * Service-line inference for ad_service_attribution rows. Single source of truth
 * shared by the web lead path (routes/lead-webhook.js) and the call attribution
 * path (services/ads/call-attribution.js) so both populate service_line /
 * specific_service / service_bucket identically — otherwise /admin/ads
 * service-line ROI buckets phone leads differently from web leads.
 */
function inferServiceLine(interest) {
  const t = (interest || '').toLowerCase();
  if (t.includes('lawn') || t.includes('grass') || t.includes('turf')) return 'lawn';
  if (t.includes('mosquito')) return 'mosquito';
  if (t.includes('termite')) return 'termite';
  if (t.includes('rodent') || t.includes('rat') || t.includes('mouse')) return 'rodent';
  if (t.includes('tree') || t.includes('shrub')) return 'tree_shrub';
  if (t.includes('bed bug') || t.includes('exclusion') || t.includes('bora')) return 'specialty';
  return 'pest';
}

function inferSpecificService(interest) {
  const t = (interest || '').toLowerCase();
  if (t.includes('rodent exclusion') || t.includes('rat exclusion')) return 'rodent_exclusion';
  if (t.includes('bed bug')) return 'bed_bug';
  if (t.includes('termite trench')) return 'termite_trenching';
  if (t.includes('termite bait')) return 'termite_bait_station';
  if (t.includes('bora')) return 'bora_care';
  if (t.includes('mosquito')) return 'mosquito_program';
  if (t.includes('flea') || t.includes('tick')) return 'flea_tick';
  if (t.includes('cockroach') || t.includes('roach')) return 'cockroach';
  if (t.includes('wasp') || t.includes('bee')) return 'wasp_bee';
  if (t.includes('lawn plug')) return 'lawn_plugging';
  if (t.includes('top dress')) return 'top_dressing';
  if (t.includes('tree') || t.includes('shrub')) return 'tree_shrub_spray';
  if (t.includes('one-time') || t.includes('one time')) return 'one_time_pest';
  return 'quarterly_pest';
}

function inferServiceBucket(interest) {
  const specific = inferSpecificService(interest);
  const recurring = ['mosquito_program', 'termite_bait_station', 'rodent_bait_station', 'quarterly_pest'];
  const highTicket = ['rodent_exclusion', 'bed_bug', 'termite_trenching', 'bora_care', 'palm_injection'];
  const lawnSeasonal = ['lawn_plugging', 'top_dressing', 'dethatching', 'tree_shrub_spray'];
  if (recurring.includes(specific)) return 'recurring';
  if (highTicket.includes(specific)) return 'high_ticket_specialty';
  if (lawnSeasonal.includes(specific)) return 'lawn_seasonal';
  return 'one_time_entry';
}

module.exports = { inferServiceLine, inferSpecificService, inferServiceBucket };
