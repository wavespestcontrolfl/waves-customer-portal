/**
 * Public automation-step preview.
 *
 * GET /api/public/automation-preview/:stepId/:token
 *
 * Renders the step's HTML body with sample values for {{first_name}} /
 * {{last_name}} / {{email}} so the operator can share a bookmarkable
 * link (e.g. with Virginia) to review an automation step before it
 * goes live. Access is gated by the per-step preview_token — not
 * guessable from the step id alone.
 *
 * No customer data is ever shown here. The rendered body only reflects
 * whatever the operator has authored in the editor.
 */

const express = require('express');
const router = express.Router();
const db = require('../models/db');

const SAMPLE = { first_name: 'Friend', last_name: 'Neighbor', email: 'neighbor@example.com' };

function fill(s) {
  if (!s) return '';
  return String(s)
    .replace(/\{\{\s*first_name\s*\}\}/g, SAMPLE.first_name)
    .replace(/\{\{\s*last_name\s*\}\}/g, SAMPLE.last_name)
    .replace(/\{\{\s*email\s*\}\}/g, SAMPLE.email)
    .replace(/\{first_name\}/g, SAMPLE.first_name)
    .replace(/\{last_name\}/g, SAMPLE.last_name);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

router.get('/:stepId/:token', async (req, res) => {
  try {
    const { stepId, token } = req.params;
    const step = await db('automation_steps').where({ id: stepId, preview_token: token }).first();
    if (!step) return res.status(404).type('html').send(notFoundPage());

    const template = await db('automation_templates').where({ key: step.template_key }).first();

    const subject = fill(step.subject);
    const previewText = fill(step.preview_text);
    const body = fill(step.html_body || '<p><em>(This step has no HTML body yet.)</em></p>');

    const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Preview — ${escapeHtml(subject || template?.name || 'Automation step')}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; color: #18181b; -webkit-font-smoothing: antialiased; }
  .meta { max-width: 720px; margin: 24px auto 0; padding: 0 20px; font-size: 13px; color: #71717a; }
  .meta-row { display: flex; gap: 10px; padding: 6px 0; border-bottom: 1px solid #e4e4e7; }
  .meta-row:last-child { border-bottom: none; }
  .meta-key { min-width: 90px; color: #a1a1aa; text-transform: uppercase; letter-spacing: 0.04em; font-size: 11px; font-weight: 500; }
  .meta-val { color: #27272a; }
  .banner { max-width: 720px; margin: 12px auto 0; padding: 10px 14px 10px 16px; border-left: 3px solid #18181b; background: #fff; font-size: 12px; color: #52525b; border-radius: 0 4px 4px 0; }
  .doc { max-width: 720px; margin: 20px auto 40px; padding: 28px 32px; background: #fff; border: 1px solid #e4e4e7; border-radius: 6px; line-height: 1.55; font-size: 15px; }
  .doc h1 { font-size: 24px; line-height: 1.2; margin: 0 0 12px; }
  .doc h2 { font-size: 18px; line-height: 1.25; margin: 20px 0 10px; }
  .doc h3 { font-size: 16px; margin: 16px 0 8px; }
  .doc p { margin: 0 0 14px; }
  .doc ul, .doc ol { margin: 0 0 14px 22px; padding: 0; }
  .doc li { margin-bottom: 6px; }
  .doc a { color: #18181b; text-decoration: underline; }
  .doc strong { font-weight: 600; }
</style>
</head>
<body>
<div class="meta">
  <div class="meta-row"><div class="meta-key">Automation</div><div class="meta-val">${escapeHtml(template?.name || step.template_key)}</div></div>
  <div class="meta-row"><div class="meta-key">Step</div><div class="meta-val">${step.step_order + 1} · fires ${step.delay_hours || 0}h ${step.step_order === 0 ? 'after enroll' : 'after previous step'}</div></div>
  <div class="meta-row"><div class="meta-key">Subject</div><div class="meta-val">${escapeHtml(subject) || '<span style="color:#a1a1aa">(no subject)</span>'}</div></div>
  ${previewText ? `<div class="meta-row"><div class="meta-key">Preview</div><div class="meta-val">${escapeHtml(previewText)}</div></div>` : ''}
</div>
<div class="banner">Preview only. Sample values shown in place of <code>{{first_name}}</code>. Real recipients see their own name.</div>
<div class="doc">${body}</div>
</body>
</html>`;

    res.type('html').send(doc);
  } catch (err) {
    res.status(500).type('html').send('<h1>Server error</h1>');
  }
});

function notFoundPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Preview not found</title><style>body{font-family:-apple-system,sans-serif;padding:40px;color:#52525b;text-align:center;}</style></head><body><h2>Preview not found</h2><p>This preview link is invalid or has been rotated.</p></body></html>`;
}

module.exports = router;
