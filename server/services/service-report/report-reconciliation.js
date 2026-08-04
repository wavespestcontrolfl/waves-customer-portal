// Pre-submit reconciliation of the tech-reviewed AI report body against
// the FINAL typed trapping values (GATE_REPORT_RECONCILE_PROMPT).
//
// Every guard in activity-indicators exists because the tech can keep
// editing the typed fields after generating the AI body and nothing
// re-runs — at render time the guards then silently degrade the copy
// (deterministic fallback) or a missed pattern lets a stale number
// publish. This surfaces the SAME contradictions to the tech at submit
// time — "your report says 8 traps, you recorded 6: regenerate or
// confirm" — so the disagreement is resolved by a person before anything
// freezes, and the matcher stack becomes a backstop where a missed
// pattern costs nothing.
//
// Uses the exact functions the report pipeline uses (one source, per this
// lane's drift rule): a contradiction this misses is one the pipeline
// would have missed too, and every pattern fix upstream widens this
// prompt for free.
const { countContradictions, setupContradictions } = require('./activity-indicators');
const { technicianReportCustomerCopy } = require('./technician-report-copy');

const COUNT_MESSAGES = {
  trap_count_mismatch: (claimed, recorded) => (
    `Your report says ${claimed} traps; this visit records ${recorded}.`
  ),
  capture_count_mismatch: (claimed, recorded) => (
    `Your report says ${claimed} capture${claimed === '1' ? '' : 's'}; this visit records ${recorded}.`
  ),
};

/**
 * Contradictions between the parsed technician report body and the
 * submitted trapping section's typed values (empty when clean, when there
 * is no reviewed body, or when no trapping section is present).
 * Returns [{ kind, message }] with customer-support-quality wording — the
 * messages are shown verbatim to the tech in the completion prompt.
 */
function reportReconciliationIssues({
  technicianNotes, structuredFindings, primaryFindingsType = null, companionFindings,
}) {
  const report = technicianReportCustomerCopy(technicianNotes);
  if (!report || !report.body) return [];
  // rodent_trapping ONLY, matched by TYPE: wildlife_trapping shares the
  // traps_checked/captures field names, but the report pipeline never
  // admits the reviewed body for it (the wildlife gauge branch keeps
  // deterministic copy), so prompting on it would 409 over prose that
  // cannot reach the report (codex P2 on the reconciliation round). The
  // primary's type comes from the completion profile; companions carry
  // their own.
  const sections = [
    { type: primaryFindingsType, values: structuredFindings?.values },
    ...(Array.isArray(companionFindings) ? companionFindings : [])
      .map((entry) => ({ type: entry?.type, values: entry?.values })),
  ];
  const trapValues = sections.find((section) => section.type === 'rodent_trapping'
    && section.values && typeof section.values === 'object')?.values || null;
  if (!trapValues) return [];
  const issues = [];
  if (String(trapValues.trap_visit_type || '').trim() === 'Initial setup'
    && setupContradictions(report.body).length) {
    issues.push({
      kind: 'setup_claim',
      message: 'Your report describes checking existing traps or captures, but this visit is marked "Initial setup" — the traps go out today.',
    });
  }
  for (const found of countContradictions(report.body, {
    traps_checked: trapValues.traps_checked,
    captures: trapValues.captures,
  })) {
    const m = /^(\w+):claimed_(\d+)_recorded_(\d+)$/.exec(found);
    if (m && COUNT_MESSAGES[m[1]]) {
      issues.push({ kind: m[1], message: COUNT_MESSAGES[m[1]](m[2], m[3]) });
    }
  }
  return issues;
}

module.exports = { reportReconciliationIssues };
