/**
 * Third-party report-copy recipients for a WDO inspection.
 *
 * The FDACS-13645 prints "Report Sent to Requestor and to:" from
 * findings.report_sent_to — a delivery CLAIM on a legal filing — but nothing
 * ever emailed those parties, even though the realtor/title company is the
 * actual consumer of a WDO in a real-estate closing. Any email addresses the
 * tech typed into that line get a REPORT-ONLY copy (FDACS PDF + report link;
 * never the invoice or pay link).
 *
 * Conservative by design: max 3 recipients, lowercased + deduped, and
 * anything in `excludeEmails` (the customer recipient, billing contact)
 * is skipped so nobody gets a duplicate.
 */

const MAX_REPORT_COPY_RECIPIENTS = 3;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

function wdoReportCopyEmails(findings = {}, excludeEmails = []) {
  const text = String(findings?.report_sent_to || '');
  if (!text.trim()) return [];
  const matches = text.match(EMAIL_PATTERN) || [];
  const seen = new Set(
    excludeEmails.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean),
  );
  const out = [];
  for (const match of matches) {
    const email = match.toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    out.push(email);
    if (out.length >= MAX_REPORT_COPY_RECIPIENTS) break;
  }
  return out;
}

module.exports = { wdoReportCopyEmails, MAX_REPORT_COPY_RECIPIENTS };
