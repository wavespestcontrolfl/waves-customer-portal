const { launchBrowser } = require('../service-report/pdf-puppeteer');
const { escapeHtml, hash, reject } = require('../staff-document-source');
const { withDocumentPdfCapacity } = require('./estimate-doc-pdf');
const { etDateString, formatETTime } = require('../../utils/datetime-et');

function evidenceTime(value) {
  const date = new Date(value);
  return `${etDateString(date)} at ${formatETTime(date)} Eastern`;
}

async function renderStaffDocumentPdf(detail, { acknowledgment = null, record = null } = {}) {
  return withDocumentPdfCapacity(() => renderStaffDocument(detail, { acknowledgment, record }));
}

async function renderStaffDocument(detail, { acknowledgment, record }) {
  const { version, rendered } = detail;
  if (version.content_snapshot && hash(version.content_snapshot) !== version.content_hash) reject('Document integrity check failed.', 409);
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.abort());
    const clauses = rendered.sections.map(section => `<section><h2>${section.number}. ${escapeHtml(section.title)}</h2>${section.html}${rendered.metadata.citations.filter(c => c.anchor === section.id).map(c => `<p class="citation">${escapeHtml(c.label)} — ${escapeHtml(c.url)} (verified ${escapeHtml(c.verified_on)}, review ${escapeHtml(c.review_on)})</p>`).join('')}</section>`).join('');
    const signature = acknowledgment ? `<section><h2>Signed acknowledgment</h2><p>${escapeHtml(acknowledgment.statement)}</p><p>${escapeHtml(acknowledgment.signed_name)} · ${escapeHtml(evidenceTime(acknowledgment.acknowledged_at))}</p><p>Staff ID: ${escapeHtml(acknowledgment.technician_id)}<br>Acknowledgment: ${escapeHtml(acknowledgment.id)}</p></section>` : '';
    const recordFields = rendered.metadata.fields.map(field => `<p><strong>${escapeHtml(field.label)}${field.required ? ' (required)' : ''}</strong><br>${escapeHtml(record?.answers[field.id] ?? '________________________________')}</p>`).join('');
    const checklist = record && rendered.kind === 'procedure' ? rendered.sections.map(section => `<p>${record.completed_steps.includes(section.id) ? '[x]' : '[ ]'} ${section.number}. ${escapeHtml(section.title)}</p>`).join('') : '';
    const recordEvidence = record ? `<section><h2>${record.completed_at ? 'Completed record' : 'Open record — incomplete'}</h2><p>Record: ${record.id}<br>Owner ID: ${record.owner_id}<br>Due: ${evidenceTime(record.due_at)}<br>Completed: ${record.completed_at ? evidenceTime(record.completed_at) : 'Not completed'}</p>${checklist}</section>` : '';
    const status = version.content_hash ? `Version ${version.version_number} · Effective ${evidenceTime(version.effective_at)}` : `DRAFT — NOT ISSUED · Version ${version.version_number}`;
    const previewDate = detail.preview_effective_at ? `<p>Wording preview for ${evidenceTime(detail.preview_effective_at)}</p>` : '';
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>body{font:14px/1.55 Arial;color:#18181b}h1{font-size:26px}h2{font-size:18px;break-after:avoid}p,li{orphans:3;widows:3}.citation{font-size:12px;overflow-wrap:anywhere;color:#52525b}section{margin-bottom:24px}a{color:#18181b}</style></head><body><p>Waves Pest Control</p><h1>${escapeHtml(rendered.title)}</h1><p>${escapeHtml(status)}</p>${previewDate}<p>Owner role: ${escapeHtml(rendered.metadata.owner_role || 'Unassigned')} · Review: ${escapeHtml(rendered.metadata.review_on || 'Unscheduled')}</p>${clauses}${recordEvidence}${recordFields}${signature}</body></html>`);
    return await page.pdf({ format: 'Letter', printBackground: true,
      margin: { top: '0.55in', right: '0.6in', bottom: '0.8in', left: '0.6in' }, displayHeaderFooter: true,
      headerTemplate: '<div></div>', footerTemplate: `<div style="font:8px Arial;width:100%;text-align:center">Waves Pest Control · v${version.version_number} · <span class="pageNumber"></span>/<span class="totalPages"></span><br>SHA-256: ${version.content_hash || 'DRAFT — no issued hash'}</div>` });
  } finally { await browser.close(); }
}
module.exports = { renderStaffDocumentPdf };
