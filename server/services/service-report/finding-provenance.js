/**
 * The service_findings rows a customer may see.
 *
 * Completion saves the form's free-text observations as rows with a bare
 * title (no detail, no recommendation), a [Found] line of the raw technician
 * note among them (complete-scheduled-service.js). Raw technician_notes
 * never egress (AGENTS.md; owner ruling 2026-07-16). A row is shown only when
 * the findings pipeline wrote it (a detail or a recommendation), or when its
 * title is a label the completion form's observations snapshot lists
 * (structured_notes.formObservations): older completions stored the picked
 * label bare, and report-data upgrades the same rows for the report's own
 * findings. The report document (ServiceReportDocument recordFindings), the
 * texting prompt (context-aggregator loadLatestVisitFindings) and the voice
 * relay (voice-agent/relay-visit.js) drop bare titles the same way. On a
 * record that carries the technician's own note (carriesReportNote), a label
 * proves a row only when it passes the complete customer-copy screen
 * (customerCopyViolations), as that record's report lists do (report-data
 * buildProtocolPayload).
 */
// A row the findings pipeline wrote: a detail or a recommendation with
// visible text. A value of spaces is no text.
function findingHasOwnText(row) {
  return Boolean(String(row?.detail || '').trim() || String(row?.recommendation || '').trim());
}

function provenFindingRows(rows, structuredNotes) {
  let notes = structuredNotes;
  if (typeof notes === 'string') {
    try { notes = JSON.parse(notes); } catch { notes = null; }
  }
  // Required here, not at load: technician-report-copy reaches this module
  // through premium-experience.
  const { carriesReportNote, customerCopyViolations } = require('./technician-report-copy');
  const screened = carriesReportNote(structuredNotes);
  const labels = notes && typeof notes === 'object' && Array.isArray(notes.formObservations) ? notes.formObservations : [];
  const formTitles = new Set(labels.filter((label) => typeof label === 'string')
    .map((label) => label.trim())
    .filter((label) => !screened || !customerCopyViolations(label).length)
    .map((label) => label.toLowerCase()));
  return (Array.isArray(rows) ? rows : []).filter((row) => findingHasOwnText(row)
    || formTitles.has(String(row?.title || '').trim().toLowerCase()));
}

module.exports = { provenFindingRows, findingHasOwnText };
