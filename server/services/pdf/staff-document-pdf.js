const { launchBrowser } = require('../service-report/pdf-puppeteer');
const { escapeHtml, hash, reject } = require('../staff-document-source');
const { withDocumentPdfCapacity } = require('./estimate-doc-pdf');
const { PDF_COLORS: C, PDF_SPACE: S, PDF_TYPE: T } = require('./pdf-tokens');
const { etDateString, formatETTime } = require('../../utils/datetime-et');

function evidenceTime(value) {
  const date = new Date(value);
  return `${etDateString(date)} at ${formatETTime(date)} Eastern`;
}

function documentKind(detail) {
  const kind = detail.rendered.kind || detail.document?.staff_kind;
  return ({ policy: 'Policy', procedure: 'Procedure', form: 'Form' })[kind] || 'Staff document';
}

function headerTemplate(title) {
  return `<div style="box-sizing:border-box;width:100%;margin:0 .62in;padding:0 0 6px;border-bottom:2px solid ${C.navy};font-family:Arial,sans-serif;display:flex;justify-content:space-between;color:${C.navy}"><span style="font-size:${T.caption}pt;font-weight:700">Waves Pest Control</span><span style="max-width:68%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;font-size:${T.micro}pt;color:${C.muted}">Controlled staff document · ${escapeHtml(title)}</span></div>`;
}

function footerTemplate(version) {
  const versionNumber = escapeHtml(version.version_number ?? '—');
  const contentHash = escapeHtml(version.content_hash || 'DRAFT — no issued hash');
  return `<div style="box-sizing:border-box;width:100%;margin:0 .62in;padding:7px 0 0;border-top:1px solid ${C.rule};font:${T.micro}pt/1.2 Arial,sans-serif;color:${C.muted};display:flex"><span style="width:23%;font-weight:700;color:${C.navy}">Waves Pest Control · v${versionNumber}</span><span style="min-width:0;width:57%;padding:0 8px;text-align:center;overflow-wrap:anywhere">SHA-256: ${contentHash}</span><span style="width:20%;text-align:right;white-space:nowrap">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;
}

function clausesHtml(rendered) {
  return rendered.sections.map(section => {
    const citations = rendered.metadata.citations.filter(citation => citation.anchor === section.id).map(citation => `<div class="citation"><b>Reference</b><a href="${escapeHtml(citation.url)}">${escapeHtml(citation.label)}</a><span>${escapeHtml(citation.url)} · verified ${escapeHtml(citation.verified_on)} · review ${escapeHtml(citation.review_on)}</span></div>`).join('');
    return `<section class="clause"><h2><i>${escapeHtml(section.number)}</i>${escapeHtml(section.title)}</h2><div class="copy">${section.html}</div>${citations}</section>`;
  }).join('');
}

function checklistHtml(record, rendered) {
  if (!record || rendered.kind !== 'procedure') return '';
  const rows = rendered.sections.map(section => `<div><code>${record.completed_steps.includes(section.id) ? '[x]' : '[ ]'} ${escapeHtml(section.number)}. ${escapeHtml(section.title)}</code></div>`).join('');
  return `<div class="checklist"><b class="label">Clause checklist</b>${rows}</div>`;
}

function recordEvidenceHtml(record, rendered) {
  if (!record) return '';
  const status = record.completed_at ? 'Completed record' : 'Open record — incomplete';
  const completed = record.completed_at ? escapeHtml(evidenceTime(record.completed_at)) : 'Not completed';
  const recordHash = escapeHtml(record.content_hash || 'Not recorded');
  return `<section class="evidence"><h2>${status}</h2><div class="grid"><div><b>Record ID</b>${escapeHtml(record.id)}</div><div><b>Owner ID</b>${escapeHtml(record.owner_id)}</div><div><b>Due</b>${escapeHtml(evidenceTime(record.due_at))}</div><div><b>Completed</b>${completed}</div><div class="wide mono"><b>Recorded content SHA-256</b>${recordHash}</div></div>${checklistHtml(record, rendered)}</section>`;
}

function fieldsHtml(rendered, record) {
  if (!rendered.metadata.fields.length) return '';
  const fields = rendered.metadata.fields.map(field => {
    const answer = record?.answers?.[field.id];
    const blank = answer == null || answer === '';
    return `<div class="field"><b>${escapeHtml(field.label)}${field.required ? '<small>Required</small>' : ''}</b><div class="answer${blank ? ' blank' : ''}">${blank ? '&nbsp;' : escapeHtml(answer)}</div></div>`;
  }).join('');
  return `<section class="evidence fields"><h2>Form fields</h2>${fields}</section>`;
}

function signatureHtml(acknowledgment) {
  if (!acknowledgment) return '';
  const acknowledgedHash = escapeHtml(acknowledgment.content_hash || 'Not recorded');
  return `<section class="evidence signature"><h2>Signed acknowledgment</h2><p>${escapeHtml(acknowledgment.statement)}</p><div class="sign"><div><b>Signed by</b><strong>${escapeHtml(acknowledgment.signed_name)}</strong></div><div><b>Signed</b><strong>${escapeHtml(evidenceTime(acknowledgment.acknowledged_at))}</strong></div></div><div class="grid"><div><b>Staff ID</b>${escapeHtml(acknowledgment.technician_id)}</div><div><b>Acknowledgment ID</b>${escapeHtml(acknowledgment.id)}</div><div class="wide mono"><b>Acknowledged content SHA-256</b>${acknowledgedHash}</div></div></section>`;
}

function documentTiming(detail, issued) {
  if (issued && detail.version.effective_at) return evidenceTime(detail.version.effective_at);
  if (detail.preview_effective_at) return `Wording preview for ${evidenceTime(detail.preview_effective_at)}`;
  return 'Not scheduled';
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
    // References are print evidence, not resources. No document content may
    // cause a request during a server-side render.
    await page.route('**/*', route => route.abort());

    const issued = Boolean(version.content_hash);
    const kind = documentKind(detail);
    const timing = documentTiming(detail, issued);
    const documentKey = detail.document?.template_key ? `<div><b>Document key</b><strong>${escapeHtml(detail.document.template_key)}</strong></div>` : '';
    const clauses = clausesHtml(rendered);
    const recordEvidence = recordEvidenceHtml(record, rendered);
    const fields = fieldsHtml(rendered, record);
    const signature = signatureHtml(acknowledgment);

    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;background:${C.white};-webkit-print-color-adjust:exact;print-color-adjust:exact}html{padding:0}body{padding:0 0 0 ${S.sm}px;font:${T.body}pt/1.5 Arial,sans-serif;color:${C.body}}.accent{position:fixed;z-index:10;top:0;bottom:0;left:0;width:5px;background:${C.blue}}
.mast{margin-bottom:${S.lg}px;break-inside:avoid-page}.brand{display:flex;justify-content:space-between;align-items:flex-end;min-height:26px;padding-bottom:${S.sm}px;border-bottom:2px solid ${C.navy}}.brand strong{font-size:${T.h2}pt;color:${C.navy}}.brand span,.eyebrow,.label,.meta b,.grid b,.sign b,.citation b{display:block;color:${C.muted};font-size:${T.micro}pt;font-weight:700;letter-spacing:.55px;text-transform:uppercase}.brand span{letter-spacing:.8px}
.title{display:grid;grid-template-columns:minmax(0,1fr) 138px;gap:${S.lg}px;align-items:end;padding:${S.md}px 0 ${S.sm}px}.eyebrow{margin-bottom:${S.xxs}px}h1{margin:0;color:${C.navy};font-size:${T.h1}pt;line-height:1.12}.status{min-height:38px;padding:4px 0 4px ${S.sm}px;border-left:3px solid ${C.gold};text-align:right}.status b{display:block;color:${C.muted};font-size:${T.micro}pt;letter-spacing:.7px;text-transform:uppercase}.status strong{display:block;margin-top:3px;color:${C.navy};font-size:${T.caption}pt}.preview{margin-bottom:${S.sm}px;padding:${S.xs}px ${S.sm}px;border-left:3px solid ${C.gold};background:${C.warm};color:${C.navy};font-size:${T.caption}pt;font-weight:700}
.meta{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border:1px solid ${C.rule};border-radius:3px;overflow:hidden}.meta>div{min-height:47px;padding:${S.xs}px ${S.sm}px;border-right:1px solid ${C.rule};border-bottom:1px solid ${C.rule};overflow-wrap:anywhere}.meta>div:nth-child(3n){border-right:0}.meta strong{color:${C.navy};font-size:${T.caption}pt;line-height:1.3}.meta .hash{grid-column:1/-1;min-height:0;border:0}.meta .hash strong{font:400 ${T.caption}pt/1.3 "Courier New",monospace}
.clause{margin-bottom:${S.lg}px;break-inside:auto}h2{display:flex;gap:${S.xs}px;align-items:baseline;margin:0 0 ${S.sm}px;padding:7px ${S.sm}px;border-top:1px solid ${C.rule};border-bottom:1px solid ${C.rule};background:${C.soft};color:${C.navy};font-size:${T.lead}pt;line-height:1.3;break-after:avoid-page}h2 i{color:${C.blue};font-style:normal}.copy p,.copy ul{margin:0 0 ${S.sm}px}.copy p,.copy li{orphans:3;widows:3}.copy ul{padding-left:${S.lg}px}.copy li{margin-bottom:${S.xxs}px}.copy strong{color:${C.navy}}a{color:${C.navy};text-decoration-color:${C.gold};text-underline-offset:2px}
.citation{margin-top:${S.sm}px;padding:${S.xs}px ${S.sm}px;border-left:3px solid ${C.gold};background:${C.warm};font-size:${T.caption}pt;line-height:1.4;overflow-wrap:anywhere;break-inside:avoid-page}.citation a,.citation span{display:block}.citation span{margin-top:3px;color:${C.muted}}
.evidence{margin-top:${S.xl}px;break-inside:auto}.evidence h2{border-left:3px solid ${C.gold}}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border:1px solid ${C.rule};border-radius:3px;overflow:hidden;font-size:${T.caption}pt;break-inside:avoid-page}.grid>div{min-height:48px;padding:${S.xs}px ${S.sm}px;border-right:1px solid ${C.rule};border-bottom:1px solid ${C.rule};overflow-wrap:anywhere}.grid>div:nth-child(2n){border-right:0}.grid .wide{grid-column:1/-1;border:0}.mono{font-family:"Courier New",monospace}.mono b{font-family:Arial,sans-serif}
.checklist{margin-top:${S.sm}px}.checklist>div{padding:6px ${S.xs}px;border-bottom:1px solid ${C.rule};font-size:${T.caption}pt;break-inside:avoid-page}.checklist code{color:${C.navy};font-weight:700}.fields{border:1px solid ${C.rule};border-radius:3px}.fields h2{margin:0}.field{padding:${S.sm}px;border-bottom:1px solid ${C.rule};break-inside:auto}.field:last-child{border:0}.field>b{display:block;color:${C.navy};font-size:${T.caption}pt;break-after:avoid-page}.field small{margin-left:5px;color:${C.muted};font-size:${T.micro}pt;font-weight:400;letter-spacing:.4px;text-transform:uppercase}.answer{min-height:24px;padding:5px 0;border-bottom:1px solid ${C.rule};font-size:${T.body}pt;line-height:1.45;overflow-wrap:anywhere;white-space:pre-wrap;orphans:3;widows:3}.answer.blank{min-height:30px}
.signature p{margin:0 0 ${S.md}px;color:${C.navy};orphans:3;widows:3}.sign{display:grid;grid-template-columns:1fr 1fr;gap:${S.lg}px;margin-bottom:${S.sm}px;break-inside:avoid-page}.sign>div{min-height:48px;padding:${S.xs}px 0;border-bottom:1px solid ${C.navy}}.sign strong{display:block;color:${C.navy};font-size:${T.caption}pt;line-height:1.35}
</style></head><body><div class="accent"></div><header class="mast"><div class="brand"><strong>Waves Pest Control</strong><span>Controlled staff document</span></div><div class="title"><div><div class="eyebrow">${escapeHtml(kind)}</div><h1>${escapeHtml(rendered.title)}</h1></div><div class="status"><b>Document status</b><strong>${issued ? 'Issued controlled copy' : 'Draft — not issued'}</strong></div></div>${!issued ? `<div class="preview">${escapeHtml(timing)}</div>` : ''}<div class="meta"><div><b>Version</b><strong>${escapeHtml(version.version_number)}</strong></div><div><b>${issued ? 'Effective' : 'Preview'}</b><strong>${escapeHtml(timing)}</strong></div><div><b>Next review</b><strong>${escapeHtml(rendered.metadata.review_on || 'Unscheduled')}</strong></div><div><b>Document owner</b><strong>${escapeHtml(rendered.metadata.owner_role || 'Unassigned')}</strong></div><div><b>Document type</b><strong>${escapeHtml(kind)}</strong></div>${documentKey}<div class="hash"><b>Content SHA-256</b><strong>${escapeHtml(version.content_hash || 'DRAFT — no issued hash')}</strong></div></div></header><main>${clauses}${recordEvidence}${fields}${signature}</main></body></html>`);
    return await page.pdf({
      format: 'Letter', printBackground: true,
      margin: { top: '0.78in', right: '0.62in', bottom: '0.78in', left: '0.62in' }, displayHeaderFooter: true,
      headerTemplate: headerTemplate(rendered.title), footerTemplate: footerTemplate(version),
    });
  } finally {
    await browser.close();
  }
}

module.exports = { renderStaffDocumentPdf };
