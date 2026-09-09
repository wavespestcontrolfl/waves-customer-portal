const { createHash } = require('node:crypto');
const Joi = require('joi');
const { escape: escapeEntities } = require('entities');
const { parseETDateTime } = require('../utils/datetime-et');
const { renderDocumentText } = require('./document-template-library');

const anchor = Joi.string().pattern(/^[a-z][a-z0-9-]{1,79}$/);
const date = Joi.string().isoDate().pattern(/^\d{4}-\d{2}-\d{2}$/);
const field = Joi.object({
  id: anchor.required(), label: Joi.string().max(180).required(),
  type: Joi.string().valid('text', 'textarea', 'date', 'checkbox').required(),
  required: Joi.boolean().required(),
});
const sourceSchema = Joi.object({
  title: Joi.string().trim().max(180).required(),
  body: Joi.string().max(80000).required(),
  metadata: Joi.object({
    owner_role: Joi.string().trim().max(120).allow(null).required(),
    review_on: date.allow(null).required(),
    citations: Joi.array().max(60).items(Joi.object({
      anchor: anchor.required(), label: Joi.string().max(240).required(),
      url: Joi.string().uri({ scheme: ['https'] }).max(1000).required(),
      verified_on: date.required(), review_on: date.required(),
    })).required(),
    fields: Joi.array().items(field).max(40).unique('id').required(),
  }).required(),
});
const policySchema = Joi.object({
  pay_frequency: Joi.string().valid('weekly', 'biweekly', 'semi-monthly', 'monthly').required(),
  pay_schedule: Joi.string().trim().max(500).required(),
  pto_accrual: Joi.array().min(1).max(20).items(Joi.object({
    after_years: Joi.number().min(0).max(60).required(),
    hours_per_year: Joi.number().min(0).max(2080).required(),
  })).unique('after_years').required(),
  paid_holidays: Joi.array().max(30).items(Joi.string().trim().max(100)).unique().required(),
  unpaid_holidays: Joi.array().max(30).items(Joi.string().trim().max(100)).unique().required(),
  equipment_deduction_terms: Joi.string().trim().max(4000).required(),
}).custom((values, helpers) => {
  if (/\[DECISION:|\{\{/.test(JSON.stringify(values))) return helpers.message('Resolve placeholders before issuing shared policy values.');
  return values;
});

function reject(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function validate(schema, input) {
  const { value, error } = schema.validate(input, { convert: false, abortEarly: true });
  if (error) reject(error.details[0].message);
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}
function hash(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function escapeHtml(value) {
  return escapeEntities(String(value));
}

// Deliberately bounded Markdown: clauses, paragraphs, bullets, emphasis and
// HTTPS links. No raw HTML, executable MDX, images, embeds or remote resources.
function inline(value) {
  return escapeHtml(value)
    .replace(/\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
}

function sections(markdown) {
  const result = [];
  for (const block of markdown.trim().split(/\n(?=## )/)) {
    const match = /^## (.+?) \{#([a-z][a-z0-9-]{1,79})\}\n([\s\S]*)$/.exec(block);
    if (!match) reject('Each clause must start with ## Title {#stable-anchor}, followed by its text.');
    const [, title, id, body] = match;
    if (result.some(section => section.id === id)) reject(`Duplicate clause anchor: ${id}`);
    const html = body.trim().split(/\n\s*\n/).map(paragraph => {
      const lines = paragraph.split('\n');
      if (lines.every(line => line.startsWith('- '))) return `<ul>${lines.map(line => `<li>${inline(line.slice(2))}</li>`).join('')}</ul>`;
      return `<p>${inline(paragraph).replace(/\n/g, '<br>')}</p>`;
    }).join('\n');
    result.push({ id, number: result.length + 1, title, text: body.trim(), html });
  }
  if (result.length > 80) reject('Use at most 80 clauses per document.');
  return result;
}

function policyContext(values) {
  if (!values) return {};
  return { policy: {
    ...values,
    pto_accrual: values.pto_accrual.map(row => `${row.after_years} years of service: ${row.hours_per_year} hours per year`).join('; '),
    paid_holidays: values.paid_holidays.join(', ') || 'None',
    unpaid_holidays: values.unpaid_holidays.join(', ') || 'None',
  } };
}

function renderSource(source, policyValues) {
  const context = policyContext(policyValues);
  const rendered = renderDocumentText(source.body, context);
  const title = renderDocumentText(source.title, context);
  const used = [...new Set([...rendered.usedVariables, ...title.usedVariables])].sort();
  const clauses = sections(rendered.rendered);
  const unknown = used.filter(key => !/^policy\.(pay_frequency|pay_schedule|pto_accrual|paid_holidays|unpaid_holidays|equipment_deduction_terms)$/.test(key));
  if (unknown.length) reject(`Unsupported policy binding: ${unknown.join(', ')}`);
  for (const citation of source.metadata.citations) {
    if (!clauses.some(clause => clause.id === citation.anchor)) reject(`Citation has no matching clause: ${citation.anchor}`);
  }
  return {
    title: title.rendered, body: rendered.rendered, sections: clauses,
    metadata: source.metadata, used_variables: used,
    unresolved: [...new Set([...rendered.unresolvedVariables, ...title.unresolvedVariables,
      ...(`${title.rendered}\n${rendered.rendered}`.match(/\[DECISION:[^\]]+\]/g) || [])])],
  };
}

function checkRelease(source, rendered, effectiveAt) {
  if (!source.metadata.owner_role || !source.metadata.review_on) reject('Choose a document owner role and next-review date before issuing.');
  if (rendered.unresolved.length) reject(`Resolve before issuing: ${rendered.unresolved.join('; ')}`);
  const start = new Date(effectiveAt).getTime();
  const review = parseETDateTime(`${source.metadata.review_on}T23:59:59`).getTime();
  if (review <= start || review - start > 366 * 86400000) reject('Next review must be after the effective date and within one year.');
  for (const citation of source.metadata.citations) {
    const verified = parseETDateTime(`${citation.verified_on}T00:00:00`).getTime();
    const due = parseETDateTime(`${citation.review_on}T23:59:59`).getTime();
    // Compare civil date distances independently of the Eastern DST offset.
    const reviewDays = (Date.parse(citation.review_on) - Date.parse(citation.verified_on)) / 86400000;
    if (verified > Date.now() || due <= start || due <= verified || reviewDays > 90 || review > due) {
      reject('Verify each citation and schedule the document review within its 90-day citation review cycle.');
    }
  }
}

module.exports = { sourceSchema, policySchema, validate, reject, hash, escapeHtml, sections, renderSource, checkRelease };
