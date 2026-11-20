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
 * proves a row only when it passes that record's copy screen
 * (noteRecordCopyViolations: the complete customer-copy screen and any time
 * figure), as that record's report lists do (report-data
 * buildProtocolPayload). There every text field a customer reads passes the
 * same screen before it proves anything: a row whose title fails it is left
 * out, and a detail or a recommendation that fails it is left out of its row
 * (screenedFinding). A row whose only text is then the stock detail is the
 * picked label alone, so it stands only as a screened label does. The stored
 * "no activity" row of the pest, mosquito, termite and rodent lines is one of
 * those: its fixed detail ("were clear") fails the screen, so the row has no
 * text left and is not shown beside a note, as the render adds no such row
 * there (report-data).
 */
const { STRUCTURED_OBSERVATION_FINDING_DETAIL } = require('../../../shared/service-completion-observations');

// A row the findings pipeline wrote: a detail or a recommendation with
// visible text. A value of spaces is no text.
function findingHasOwnText(row) {
  return Boolean(String(row?.detail || '').trim() || String(row?.recommendation || '').trim());
}

// A row whose only text is the stock detail that completion writes for a
// picked form label (complete-scheduled-service.js; report-data gives an
// older bare label row the same detail).
function stockDetailOnly(row) {
  return String(row?.detail || '').trim() === STRUCTURED_OBSERVATION_FINDING_DETAIL
    && !String(row?.recommendation || '').trim();
}

// On a record that carries the technician's own note: the row with each
// text field a customer reads screened, or null when its title fails.
function screenedFinding(row, noteRecordCopyViolations) {
  if (noteRecordCopyViolations(String(row?.title || '').trim()).length) return null;
  const keep = (value) => (String(value || '').trim() && noteRecordCopyViolations(String(value)).length ? null : value);
  return { ...row, detail: keep(row?.detail), recommendation: keep(row?.recommendation) };
}

const titleKey = (row) => String(row?.title || '').trim().toLowerCase();

function provenFindingRows(rows, structuredNotes) {
  let notes = structuredNotes;
  if (typeof notes === 'string') {
    try { notes = JSON.parse(notes); } catch { notes = null; }
  }
  // Required here, not at load: technician-report-copy reaches this module
  // through premium-experience.
  const { carriesReportNote, noteRecordCopyViolations } = require('./technician-report-copy');
  const screened = carriesReportNote(structuredNotes);
  const labels = notes && typeof notes === 'object' && Array.isArray(notes.formObservations) ? notes.formObservations : [];
  const formTitles = new Set(labels.filter((label) => typeof label === 'string')
    .map((label) => label.trim())
    .filter((label) => !screened || !noteRecordCopyViolations(label).length)
    .map((label) => label.toLowerCase()));
  const list = Array.isArray(rows) ? rows : [];
  if (!screened) return list.filter((row) => findingHasOwnText(row) || formTitles.has(titleKey(row)));
  return list.map((row) => screenedFinding(row, noteRecordCopyViolations)).filter((row) => {
    if (!row) return false;
    if (stockDetailOnly(row)) return formTitles.has(titleKey(row));
    return findingHasOwnText(row) || formTitles.has(titleKey(row));
  });
}

module.exports = { provenFindingRows, findingHasOwnText };
