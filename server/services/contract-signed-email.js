// Post-sign "executed copy" email: when a document-library contract is
// signed, email the customer their signed branded PDF as a record. Signing
// consumes the single-use share token, so the customer can no longer
// re-download via the link — this email is their copy.
//
// Scope: document_template contracts only. Autopay authorizations have their
// own confirmation email (PaymentLifecycleEmail.sendAutopayEnabled), so they
// are intentionally skipped here to avoid a duplicate message.
const db = require('../models/db');
const logger = require('./logger');
const sendgrid = require('./sendgrid-mail');
const { wrapEmail, plainText } = require('./email-template');
const { buildContractPDFBuffer } = require('./pdf/contract-pdf');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function firstName(customer = {}) {
  return String(customer.first_name || '').trim() || 'there';
}

function safeFilename(s) {
  return String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60) || 'waves-agreement';
}

function formatSignedDate(d) {
  if (!d) return '—';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    timeZone: 'America/New_York',
  });
}

// Pure-ish builder (only async because it renders the PDF). Returns the
// SendGrid-ready payload so it can be unit-tested without network/db.
async function buildSignedCopyEmail(contract, customer = {}) {
  const title = contract.title || 'Waves Agreement';
  const signedOn = formatSignedDate(contract.signed_at);
  const signedBy = contract.signed_name || customer.first_name || '—';

  const pdf = await buildContractPDFBuffer(contract, customer, { signed: true });

  const html = wrapEmail({
    preheader: `Your signed copy of ${title}`,
    heading: 'Your signed copy',
    intro: `Hi ${escapeHtml(firstName(customer))}, thank you for signing <strong>${escapeHtml(title)}</strong>. A signed copy is attached to this email for your records.`,
    lines: [
      ['Document', escapeHtml(title)],
      ['Signed by', escapeHtml(signedBy)],
      ['Signed on', escapeHtml(signedOn), true],
    ],
  });

  const text = plainText([
    `Hi ${firstName(customer)},`,
    '',
    `Thank you for signing ${title}. A signed copy is attached to this email for your records.`,
    '',
    `Document: ${title}`,
    `Signed by: ${signedBy}`,
    `Signed on: ${signedOn}`,
    '',
    `Questions? Reply to this email or call ${WAVES_SUPPORT_PHONE_DISPLAY}.`,
  ]);

  return {
    subject: `Your signed copy: ${title}`,
    html,
    text,
    attachments: [{
      filename: `${safeFilename(title)}.pdf`,
      content: pdf.toString('base64'),
      type: 'application/pdf',
      disposition: 'attachment',
    }],
  };
}

// Fire-and-forget orchestration called from the public sign route after a
// successful signature commit. Never throws into the request path.
async function sendSignedContractCopy(contractId) {
  const contract = await db('customer_contracts as cc')
    .leftJoin('document_templates as dt', 'cc.document_template_id', 'dt.id')
    .select('cc.*', 'dt.requires_signature as document_template_requires_signature')
    .where('cc.id', contractId)
    .first();

  if (!contract || contract.status !== 'signed') return { ok: false, skipped: 'not_signed' };
  if (contract.contract_type !== 'document_template') return { ok: false, skipped: 'not_document_template' };

  const customer = await db('customers')
    .where({ id: contract.customer_id })
    .first('first_name', 'last_name', 'company_name', 'email');

  const to = contract.recipient_email || customer?.email;
  if (!to) return { ok: false, skipped: 'no_recipient_email' };
  if (!sendgrid.isConfigured()) return { ok: false, skipped: 'sendgrid_unconfigured' };

  const payload = await buildSignedCopyEmail(contract, customer || {});
  const result = await sendgrid.sendOne({
    to,
    fromEmail: 'contact@wavespestcontrol.com',
    fromName: 'Waves Pest Control',
    replyTo: 'contact@wavespestcontrol.com',
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
    categories: ['document_signed_copy'],
    asmGroupId: sendgrid.serviceGroupId(),
    attachments: payload.attachments,
  });
  return { ok: true, providerMessageId: result?.messageId || null };
}

module.exports = {
  buildSignedCopyEmail,
  sendSignedContractCopy,
};
