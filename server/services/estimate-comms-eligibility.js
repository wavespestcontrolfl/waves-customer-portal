/**
 * The ONE rule for "may this estimate receive automated follow-up
 * communication?" — shared by every automated estimate sender (codex round 6
 * on #5154: each sender had hand-rolled its own copy, and the new
 * email_template_automation lifecycle emitters missed it).
 *
 * Two durable, status-independent facts block ALL automated outreach about
 * an estimate:
 *  - archived_at: staff parked the estimate (manual archive, the
 *    converted-customer sweep) — its courtship is over, whatever `status`
 *    still reads (archiving an expired estimate leaves status 'expired');
 *  - estimate_data.noEngagementAutomation === true: the durable zero-comms
 *    opt-out stamped by publish-without-delivery lanes (report
 *    click-to-estimate, plan restart, website self-service publication),
 *    which promise the customer no automated follow-up at all.
 *
 * Status rules stay with each sender (an expiry email needs 'expired', an
 * engagement nudge needs an active status) — this is the part they share.
 *
 * Deliberately a LEAF module (no requires): the engagement engine and the
 * legacy follow-up sender require each other, which is why each of them
 * used to keep a local copy of the opt-out check; a dependency-free module
 * can be required by all of them with no cycle.
 */

// estimate_data arrives as a jsonb object (knex hydration) or a JSON string
// (raw / RETURNING paths); an unparseable blob reads as NOT opted out — the
// same fail-open every former copy used, so behavior is unchanged.
function estimateOptedOutOfEngagement(estimate) {
  try {
    const data = typeof estimate?.estimate_data === 'string'
      ? JSON.parse(estimate.estimate_data)
      : estimate?.estimate_data;
    return data?.noEngagementAutomation === true;
  } catch {
    return false;
  }
}

// Returns the reason automated follow-up is blocked for this estimate row,
// or null when it may receive it. The row must carry archived_at and
// estimate_data (select them).
function estimateFollowupBlockedReason(estimate) {
  if (!estimate) return 'estimate not found';
  if (estimate.archived_at) return 'estimate is archived';
  if (estimateOptedOutOfEngagement(estimate)) return 'estimate opted out of automated follow-up (noEngagementAutomation)';
  return null;
}

module.exports = {
  estimateOptedOutOfEngagement,
  estimateFollowupBlockedReason,
};
