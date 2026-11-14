'use strict';

// One JS answer to "does this visit apply product to the lawn". It reads the lawn row of the prep-guide config, so it
// cannot drift from the lawn prep email's own SQL match (prep-guide-sender.js upcomingFamilyVisits): a "lawn" service
// type, minus dethatching, plugging and top dressing (no product), and minus an inspection-only or assessment-only name.
// A grouped stop passes every member's service type, one at a time: one lawn treatment member is enough, and a
// second member's name ("Termite Inspection") never cancels the lawn member.

function matchesPrepConfig(serviceType, { serviceKeywords, excludeKeywords = [] }) {
  const name = String(serviceType || '').toLowerCase();
  if (!name || !serviceKeywords.some((keyword) => name.includes(keyword))) return false;
  return !excludeKeywords.some((ex) => {
    if (typeof ex === 'string') return name.includes(ex);
    return name.includes(ex.keyword) && ![].concat(ex.unless).some((cue) => name.includes(cue));
  });
}

function isLawnTreatmentServiceType(serviceType) {
  // Required here, not at the top: prep-guide-sender loads the messaging stack, and this file is read by the
  // reminder scan and the public appointment route.
  const { PREP_CONFIG } = require('./prep-guide-sender');
  return matchesPrepConfig(serviceType, PREP_CONFIG.lawn);
}

function isLawnTreatmentVisit(serviceTypes) {
  return [].concat(serviceTypes).some((serviceType) => isLawnTreatmentServiceType(serviceType));
}

module.exports = { isLawnTreatmentServiceType, isLawnTreatmentVisit };
