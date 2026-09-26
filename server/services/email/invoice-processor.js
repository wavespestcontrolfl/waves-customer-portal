const Anthropic = require('@anthropic-ai/sdk');
const db = require('../../models/db');
const gmailClient = require('./gmail-client');
const logger = require('../logger');
const MODELS = require('../../config/models');
const { anthropicMaxTokens, anthropicEffortConfig } = require('../llm/anthropic-wire');
// First TEXT block of a Message — a thinking block leads the content on
// always-thinking models (Opus 5.5, Fable), so content[0] is not the answer.
const { anthropicText } = require('../llm/call');
const { etDateString, validCalendarDate } = require('../../utils/datetime-et');
const { taxPeriodFor } = require('../../utils/tax-period');
const { ledgerCall, ledgerCallRejected } = require('../llm-dispatch-metrics');

const anthropic = new Anthropic();

// A reply of {"total":"unknown",...} is a non-null, truthy string that slips
// past a bare `== null` check, and then wins `amount = parsedInvoice?.total
// || parseFloat(...) || 0` below (the string "unknown" is truthy) — no
// crash, `amount > 0` is just false on a NaN-ish comparison, so the expense
// is silently skipped ("no_amount") while the call is recorded a success
// (Codex r10 on #4884). `total`, when present, must be usable as a number —
// a plain finite number, or a strict numeric string (the only string shape
// `amount > 0` and the numeric `expenses.amount` column downstream actually
// coerce correctly).
function isUsableInvoiceTotal(total) {
  if (total == null) return true;
  if (typeof total === 'number') return Number.isFinite(total);
  return typeof total === 'string' && /^-?\d+(\.\d+)?$/.test(total.trim());
}

// The one read of the extraction: everything downstream uses these values,
// never the raw reply. A present field that is off the prompt's contract is
// dropped to null (so the classifier's own figure is used instead) and marks
// the answer degraded: an invalid invoice_date used to become today's date
// (wrong expense_date / tax_year), and an object invoice_number was written
// into the expense description as "#[object Object]" (Codex-class gap on
// #4884). A zero or negative total is a real value (e.g. a credit memo) that
// simply creates no expense. Returns { invoice, degraded }; invoice is null
// when the reply is not an object.
const INVOICE_NUMBER_MAX = 64;
function readParsedInvoice(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { invoice: null, degraded: true };
  let degraded = false;
  const invoice = { ...raw };
  const present = (v) => v !== undefined && v !== null;

  invoice.total = null;
  if (present(raw.total)) {
    if (isUsableInvoiceTotal(raw.total)) invoice.total = Number(raw.total);
    else degraded = true;
  }
  invoice.invoice_number = null;
  if (present(raw.invoice_number)) {
    const n = typeof raw.invoice_number === 'string' || (typeof raw.invoice_number === 'number' && Number.isFinite(raw.invoice_number))
      ? String(raw.invoice_number).trim() : '';
    // A real invoice number is short; an OCR run-on long enough to push the
    // expense description past its varchar(300) failed the insert after the
    // call was accepted (Codex r19 on #4884).
    if (n && n.length <= INVOICE_NUMBER_MAX) invoice.invoice_number = n;
    else degraded = true;
  }
  invoice.invoice_date = null;
  if (present(raw.invoice_date)) {
    // The shared calendar check (the same one taxPeriodFor applies): a hand-
    // rolled month/day check let years 0000-0099 through, which Date.UTC
    // remaps to 19xx, and taxPeriodFor then returned null and the tax-period
    // destructuring threw (Codex r20 on #4884).
    const date = typeof raw.invoice_date === 'string' ? validCalendarDate(raw.invoice_date.trim()) : null;
    if (date) invoice.invoice_date = date;
    else degraded = true;
  }
  invoice.line_items = [];
  if (present(raw.line_items)) {
    if (Array.isArray(raw.line_items)) {
      invoice.line_items = raw.line_items.filter((l) => l && typeof l === 'object' && !Array.isArray(l));
      if (invoice.line_items.length !== raw.line_items.length) degraded = true;
    } else degraded = true;
  }
  // Neither a total nor an invoice number: the extraction answered nothing.
  if (invoice.total === null && !invoice.invoice_number) degraded = true;
  return { invoice, degraded };
}

function parseClaudeJson(text) {
  try {
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

async function processVendorInvoice(email, classification) {
  const domain = email.from_address?.split('@')[1];
  const vendor = domain ? await db('vendor_email_domains').where('domain', domain).first() : null;
  const vendorName = vendor?.vendor_name || classification.extracted?.vendor_name || 'Unknown Vendor';
  const expenseCategory = vendor?.expense_category || 'Uncategorized';

  // Check for PDF attachment
  const attachments = await db('email_attachments').where({ email_id: email.id });
  const pdfAttachment = attachments.find(a =>
    a.mime_type === 'application/pdf' ||
    a.filename?.toLowerCase().endsWith('.pdf')
  );

  let parsedInvoice = null;

  // If PDF exists, download and parse with Claude Vision
  if (pdfAttachment) {
    try {
      const attachmentData = await gmailClient.getAttachment(email.gmail_id, pdfAttachment.gmail_attachment_id);

      // Verify real PDF by magic bytes (%PDF) — filename/MIME can be spoofed
      if (
        !Buffer.isBuffer(attachmentData) ||
        attachmentData.length < 4 ||
        attachmentData.slice(0, 4).toString('ascii') !== '%PDF'
      ) {
        logger.warn(`[invoice-processor] Attachment ${pdfAttachment.id} claimed PDF but magic bytes mismatched — skipping parse`);
        throw new Error('Attachment is not a valid PDF');
      }

      await db('email_attachments').where({ id: pdfAttachment.id }).update({
        is_invoice: true,
      });

      const parseResponse = await ledgerCall('anthropic', MODELS.FLAGSHIP, () => anthropic.messages.create({
        model: MODELS.FLAGSHIP,
        ...anthropicEffortConfig(MODELS.FLAGSHIP),
        max_tokens: anthropicMaxTokens(MODELS.FLAGSHIP, 1024),
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: attachmentData.toString('base64') },
            },
            {
              type: 'text',
              text: `Extract invoice details from this PDF. Respond ONLY in JSON:
{
  "invoice_number": "string",
  "invoice_date": "YYYY-MM-DD",
  "due_date": "YYYY-MM-DD or null",
  "vendor_name": "string",
  "subtotal": number,
  "tax": number,
  "total": number,
  "payment_terms": "NET 30, etc.",
  "line_items": [
    { "description": "string", "quantity": number, "unit_price": number, "total": number, "product_name": "if identifiable" }
  ]
}`,
            },
          ],
        }],
      }), { laneId: 'invoice_pdf' });

      const rawInvoice = parseClaudeJson(anthropicText(parseResponse));
      if (!rawInvoice) ledgerCallRejected(parseResponse, 'invalid_json');
      else {
        const read = readParsedInvoice(rawInvoice);
        if (read.degraded) ledgerCallRejected(parseResponse, 'schema_invalid');
        parsedInvoice = read.invoice;
      }

      if (parsedInvoice) {
        await db('email_attachments').where({ id: pdfAttachment.id }).update({
          extracted_data: JSON.stringify(parsedInvoice),
        });
      }
    } catch (err) {
      logger.warn(`[invoice-processor] PDF parsing failed for ${email.id}: ${err.message}`);
    }
  }

  // Create expense record
  // `??`, not `||`: a parsed total of 0 (a zero-total invoice or credit memo)
  // is the extraction's answer, not a missing one — `||` fell through to the
  // classifier's amount and created an expense for it (Codex r18 on #4884).
  const amount = parsedInvoice?.total ?? (parseFloat(classification.extracted?.invoice_amount) || 0);
  const invoiceNumber = parsedInvoice?.invoice_number || classification.extracted?.invoice_number;
  const rawInvoiceDate = parsedInvoice?.invoice_date || classification.extracted?.invoice_date;
  const parsedDate = rawInvoiceDate ? new Date(rawInvoiceDate) : null;
  const invoiceDateValid = parsedDate && !Number.isNaN(parsedDate.getTime());
  // The classifier's own date is not calendar-checked upstream: a date
  // taxPeriodFor cannot place (e.g. year 0012) falls back to today — date and
  // tax period together — instead of throwing before the email outcome is
  // recorded (Codex r20 on #4884).
  const candidateDate = invoiceDateValid ? parsedDate.toISOString().split('T')[0] : null;
  const invoiceDate = candidateDate && taxPeriodFor(candidateDate) ? candidateDate : etDateString();
  const { tax_year: taxYear, quarter } = taxPeriodFor(invoiceDate);

  if (amount > 0) {
    try {
      const { autoCategorizeExpense, categoryDeductibleAmount } = require('../expense-categorizer');
      // ONLY a deterministic vendor-domain mapping auto-sets the tax category.
      // AI categorization here would run on UNTRUSTED emailed invoice text
      // (prompt-injectable, and its pick flows straight into the P&L / tax
      // export), so its result is stored as a SUGGESTION only — the expense
      // lands UNCATEGORIZED for the operator to confirm via the Expenses tab's
      // (operator-triggered) auto-categorize. Full deductible amount until then.
      const categoryRow = await db('expense_categories').whereILike('name', `%${expenseCategory}%`).first();

      let aiSuggestionNote = '';
      if (!categoryRow) {
        try {
          const ai = await autoCategorizeExpense(vendorName, (parsedInvoice ? parsedInvoice.line_items.map(l => (typeof l.description === 'string' ? l.description : '')).filter(Boolean).join('; ') : '') || email.subject, amount);
          if (ai?.categoryName) aiSuggestionNote = ` AI-suggested category: ${ai.categoryName} (unconfirmed).`;
        } catch (err) {
          logger.warn(`[invoice-processor] AI categorization failed for ${email.id}: ${err.message}`);
        }
      }

      // Server-owned partial-deduction policy — only for a DETERMINISTIC
      // (vendor-domain) category match. Uncategorized stays fully deductible
      // until the operator confirms a category.
      let deductibleAmount = amount;
      if (categoryRow?.name) {
        const partial = categoryDeductibleAmount(categoryRow.name, amount);
        if (partial !== null) deductibleAmount = partial;
      }

      const [expense] = await db('expenses').insert({
        // Column limits (description varchar 300, vendor_name varchar 200): the
        // vendor name and the classifier's own invoice number are not bounded
        // upstream, so clip here rather than fail the insert.
        description: `${vendorName} Invoice${invoiceNumber ? ` #${invoiceNumber}` : ''} — via email`.slice(0, 300),
        amount,
        tax_deductible_amount: deductibleAmount,
        category_id: categoryRow?.id || null,
        vendor_name: String(vendorName).slice(0, 200),
        expense_date: invoiceDate,
        tax_year: taxYear,
        quarter,
        payment_method: 'invoice',
        notes: `Auto-imported from email. Subject: "${email.subject}". Pending review.${aiSuggestionNote}`,
      }).returning('*');

      await db('emails').where({ id: email.id }).update({
        expense_id: expense.id,
        auto_action: `expense_created:${amount}`,
        updated_at: new Date(),
      });

      logger.info(`[invoice-processor] Expense created: ${vendorName} $${amount} (#${invoiceNumber || 'N/A'})`);
    } catch (err) {
      logger.error(`[invoice-processor] Expense creation failed: ${err.message}`);
      await db('emails').where({ id: email.id }).update({
        auto_action: `invoice_detected:${amount}:expense_failed`,
        updated_at: new Date(),
      });
    }
  } else {
    await db('emails').where({ id: email.id }).update({
      auto_action: 'invoice_detected:no_amount',
      updated_at: new Date(),
    });
  }
}

module.exports = { processVendorInvoice, isUsableInvoiceTotal, readParsedInvoice };
