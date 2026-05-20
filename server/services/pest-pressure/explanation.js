/**
 * Customer-facing summary copy resolved from {label, trend, dataCompleteness}.
 *
 * Keeps phrasing identical to the product spec so admin-facing tests and
 * customer-facing snapshot tests can both assert the same strings.
 */

const COPY = Object.freeze({
  insufficient: 'Pest Pressure will appear once enough service data is available.',
  first_marker:
    'This is your first Pest Pressure score. Future reports will compare this number against prior visits to show whether pest activity is improving, stable, or increasing.',
  improving: 'Pest pressure is improving compared with the previous service period.',
  stable_low: 'Pest pressure remains low. No significant activity was found during this service period.',
  stable_other: 'Pest pressure is stable compared with the previous service period.',
  increasing:
    'Pest pressure increased since the previous service period. This may be due to reported sightings, technician findings, re-service activity, recurring issue areas, or property risk factors.',
  significant_increase:
    'Pest pressure increased significantly since the previous service period. This may be due to reported sightings, technician findings, re-service activity, recurring issue areas, or property risk factors.',
});

function isLowOrVeryLow(labelKey) {
  return labelKey === 'very_low' || labelKey === 'low';
}

function resolveCustomerSummary({ trend, label, dataCompleteness }) {
  if (dataCompleteness === 'insufficient' || trend === 'insufficient_data') {
    return COPY.insufficient;
  }
  if (trend === 'first_marker') return COPY.first_marker;
  if (trend === 'improving') return COPY.improving;
  if (trend === 'stable') {
    return isLowOrVeryLow(label && label.key) ? COPY.stable_low : COPY.stable_other;
  }
  if (trend === 'increasing') return COPY.increasing;
  if (trend === 'significant_increase') return COPY.significant_increase;
  return null;
}

module.exports = { COPY, resolveCustomerSummary };
