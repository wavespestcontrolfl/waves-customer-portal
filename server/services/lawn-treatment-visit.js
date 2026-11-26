'use strict';

// One JS answer to "does this visit apply product to the lawn". It reads the lawn row of the prep-guide config through the
// sender's own JS matcher (prepConfigMatches), which a test holds to the lawn prep email's SQL match (upcomingFamilyVisits): a "lawn" service
// type, minus dethatching, plugging and top dressing (no product), and minus an inspection-only or assessment-only name.
// A grouped stop passes every member's service type, one at a time: one lawn treatment member is enough, and a
// second member's name ("Termite Inspection") never cancels the lawn member.

function isLawnTreatmentServiceType(serviceType) {
  // Required here, not at the top: prep-guide-sender loads the messaging stack, and this file is read by the
  // reminder scan and the public appointment route.
  const { PREP_CONFIG, prepConfigMatches } = require('./prep-guide-sender');
  return prepConfigMatches(PREP_CONFIG.lawn, serviceType);
}

function isLawnTreatmentVisit(serviceTypes) {
  return [].concat(serviceTypes).some((serviceType) => isLawnTreatmentServiceType(serviceType));
}

module.exports = { isLawnTreatmentServiceType, isLawnTreatmentVisit };
