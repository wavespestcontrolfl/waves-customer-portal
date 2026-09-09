/** Descriptive service-duration references from corroborated completions.
 * These never replace booked work durations or authorize a schedule move. */
const { etDateString } = require('../../utils/datetime-et');
const { finiteDate } = require('../../utils/service-duration-capture');
const { frozenCloseoutRequirements } = require('../service-closeout-requirements');

const MIN_REFERENCE_SAMPLES = 5;
const FREEZE_TOLERANCE_MS = 5 * 60000;

function percentile(values, quantile) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? null;
}

// The performance reader supplies only work in its requested past-day range.
function summarizeDurationReferences(rows, recordedTiming) {
  const excluded = {};
  const cohorts = new Map();
  for (const row of rows) {
    if (row.status !== 'completed') continue;
    const timing = recordedTiming(row);
    const identity = frozenCloseoutRequirements(row.completionNotes);
    const frozenAt = finiteDate(identity?.frozenAt);
    let reason = null;
    if (row.visit_id) reason = 'grouped_work';
    else if (row.is_callback || row.followup_included) reason = 'callback_or_included_followup';
    else if (timing.durationEvidence !== 'recorded_lifecycle_interval') reason = timing.durationEvidence;
    else if (typeof identity?.serviceId !== 'string' || !identity.serviceId.trim() || !frozenAt
      || identity.source === 'backfilled_from_live_catalog' || !timing.completion
      || Math.abs(frozenAt.getTime() - timing.completion.getTime()) > FREEZE_TOLERANCE_MS) reason = 'service_identity_not_frozen_at_completion';
    if (reason) {
      excluded[reason] = (excluded[reason] || 0) + 1;
      continue;
    }
    if (!cohorts.has(identity.serviceId)) cohorts.set(identity.serviceId, []);
    cohorts.get(identity.serviceId).push({ date: etDateString(timing.completion), minutes: timing.durationMinutes });
  }
  const byService = [...cohorts].map(([serviceId, observations]) => {
    const samples = observations.sort((a, b) => a.date.localeCompare(b.date));
    const minutes = samples.map(sample => sample.minutes);
    const dates = [...new Set(samples.map(sample => sample.date))];
    const enough = samples.length >= MIN_REFERENCE_SAMPLES;
    const errors = [];
    const earlier = [];
    // Each check uses only earlier service DAYS. Neither later work nor a
    // same-day completion can improve a prediction retrospectively.
    for (const date of dates) {
      const day = samples.filter(sample => sample.date === date).map(sample => sample.minutes);
      if (earlier.length >= MIN_REFERENCE_SAMPLES) {
        const reference = percentile(earlier, 0.8);
        errors.push(...day.map(actual => actual - reference));
      }
      earlier.push(...day);
    }
    return {
      serviceId, samples: samples.length, serviceDays: dates.length,
      firstDate: dates[0], lastDate: dates.at(-1),
      status: enough ? 'provisional_reference' : 'insufficient_samples',
      medianMinutes: enough ? percentile(minutes, 0.5) : null,
      p80Minutes: enough ? percentile(minutes, 0.8) : null,
      observedMinimumMinutes: Math.min(...minutes), observedMaximumMinutes: Math.max(...minutes),
      earlierDayEvaluation: {
        basis: 'p80_of_earlier_service_days', visits: errors.length,
        meanAbsoluteErrorMinutes: errors.length ? errors.reduce((sum, error) => sum + Math.abs(error), 0) / errors.length : null,
        overrunRate: errors.length ? errors.filter(error => error > 0).length / errors.length : null,
      },
    };
  }).sort((a, b) => a.serviceId.localeCompare(b.serviceId));
  return {
    basis: 'corroborated_lifecycle_with_service_identity_frozen_at_completion',
    minimumReferenceSamples: MIN_REFERENCE_SAMPLES,
    acceptedVisits: byService.reduce((sum, group) => sum + group.samples, 0),
    excluded, byService, automaticApplication: false,
    note: 'Service cohorts are not property-specific estimates. References remain provisional; booked durations and scheduling constraints are unchanged.',
  };
}

module.exports = { summarizeDurationReferences };
