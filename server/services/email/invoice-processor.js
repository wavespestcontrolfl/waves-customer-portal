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
  const n = typeof total === 'number' ? total
    : (typeof total === 'string' && /^-?\d+(\.\d+)?$/.test(total.trim()) ? Number(total) : NaN);
  // expenses.amount is decimal(12,2): a larger total (or a digit run that
  // converts to Infinity) failed the expense insert after acceptance (Codex r21).
  return Number.isFinite(n) && Math.abs(n) < 1e10;
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

// The sender's domain and each parent domain down to two labels, most
// specific first: receipts come from subdomains (mail.anthropic.com,
// ec.siteone.com) while vendor_email_domains lists the company domain. An
// exact-only match left 334 Anthropic receipts as "Unknown Vendor".
// Only LEADING labels are dropped, so anthropic.com.evil.example never
// becomes anthropic.com.
function senderDomainCandidates(address) {
  const domain = String(address || '').split('@')[1]?.trim().toLowerCase().replace(/\.$/, '');
  if (!domain) return [];
  const labels = domain.split('.').filter(Boolean);
  const out = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join('.'));
  return out;
}

async function vendorForSender(address) {
  const candidates = senderDomainCandidates(address);
  if (!candidates.length) return null;
  const rows = await db('vendor_email_domains').whereIn('domain', candidates);
  return candidates.map((d) => rows.find((r) => String(r.domain).toLowerCase() === d)).find(Boolean) || null;
}

// The 2026-04-14 seed labelled vendor_email_domains with names no expense
// category has, so whereILike found nothing and every mapped vendor landed
// uncategorized. Read the old labels as the Schedule C categories the
// expense categorizer's own rules name (chemicals and supplies -> Supplies;
// software, SaaS, hosting -> Software & Technology). An admin's own label
// passes through unchanged. No data is rewritten.
const LEGACY_VENDOR_CATEGORY = Object.freeze({
  'products & chemicals': 'Supplies',
  'software & services': 'Software & Technology',
  'hosting & infrastructure': 'Software & Technology',
});
function realCategoryName(label) {
  if (typeof label !== 'string' || !label.trim()) return null;
  return LEGACY_VENDOR_CATEGORY[label.trim().toLowerCase()] || label.trim();
}

// A usable display name from the parsed invoice or the classifier, else null.
function nameOrNull(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return s && !/^(unknown|n\/a|null|none|string)$/i.test(s) ? s : null;
}

// Same vendor + invoice number + amount already booked: the same receipt
// mailed twice (two inboxes, a forward, a re-send). Without an invoice
// number, or with no known vendor ("Unknown Vendor" groups unrelated
// senders), there is nothing safe to match on, so no row is a duplicate.
// The description is compared WHOLE (the exact string the insert below
// writes), so invoice 12 never matches invoice 12-A or 112.
// A description over the 300-character column is clipped, and two clipped
// descriptions can be equal for different invoices, so no duplicate check
// runs on one (nor on a vendor name over its 200-character column).
function fullExpenseDescription(vendorName, invoiceNumber) {
  return `${vendorName} Invoice${invoiceNumber ? ` #${invoiceNumber}` : ''} — via email`;
}
function expenseDescription(vendorName, invoiceNumber) {
  return fullExpenseDescription(vendorName, invoiceNumber).slice(0, 300);
}

// Only a plain string or finite number up to INVOICE_NUMBER_MAX characters
// can identify a receipt: the classifier's value is untyped, and an object
// would stringify to "[object Object]" for every invoice.
function scalarInvoiceNumber(n) {
  const s = typeof n === 'string' || (typeof n === 'number' && Number.isFinite(n)) ? String(n).trim() : '';
  // A placeholder ("unknown", "N/A", "string", "-") is no identifier.
  if (!s || s.length > INVOICE_NUMBER_MAX || /^(unknown|n\/?a|null|none|string|tbd|-+|0+)$/i.test(s)) return null;
  return s;
}
// Only a name from the domain mapping or printed on the invoice identifies
// the merchant. A classifier guess or a sender display name can be a
// platform or a forwarder shared by unrelated merchants, so those never
// drive a duplicate match.
const DEDUPE_SOURCES = new Set(['mapping', 'invoice']);

// The date must come from the invoice or the classifier: the today fallback
// is the processing day, so a mailbox backfill would compare unrelated
// historical receipts under one date.
function duplicateKey(vendorName, invoiceNumber, vendorSource, dateFromInvoice) {
  if (!dateFromInvoice || !DEDUPE_SOURCES.has(vendorSource) || !scalarInvoiceNumber(invoiceNumber)) return null;
  if (fullExpenseDescription(vendorName, invoiceNumber).length > 300 || String(vendorName).length > 200) return null;
  return `expense-dup:${String(vendorName).toLowerCase()}:${invoiceNumber}`;
}

// The invoice date is part of the identity: a vendor that reuses an invoice
// number for the same amount on a later date is a new expense, not a copy.
async function findDuplicateExpense(conn, vendorName, invoiceNumber, amount, invoiceDate) {
  return conn('expenses')
    .where({ vendor_name: String(vendorName).slice(0, 200), expense_date: invoiceDate, description: expenseDescription(vendorName, invoiceNumber) })
    // expenses.amount is decimal(12,2): let Postgres round the new amount
    // exactly as the insert will, rather than a float approximation in JS.
    .whereRaw('amount = round(?::numeric, 2)', [String(amount)])
    .first('id');
}

// With no parsed invoice the subject is the only signal of what the email
// is. These say money did NOT leave the business (a failed or declined
// payment, a payout received, a renewal reminder, a bill still due), and the
// classifier still prints an amount for them, so they are never booked.
const NOT_A_CHARGE_SUBJECT = /\b(unsuccessful|not successful|failed|declined|did ?n[o']t go through|(could|can)(not|n't| not) (be )?(process(ed)?|charged?|recharged?|completed?|collect(ed)?)|unable to (process|charge|collect|complete)|problem with your payment|payment (issue|problem)|payout|will (be )?renew(ed|s)?|renewal notice|invoice due|payment due|past due|action required)\b/i;

// The same email delivered twice (to two inboxes, or re-sent): an expense
// already linked to an email from the same sender, received in the same
// second, with the same subject and the same body, for the same amount.
// Nothing weaker counts: separate receipts can share a sender, a second and
// an amount, and a missed copy only costs a review, while a wrong match
// silently drops a real expense. Emails with attachments are never matched
// here (two PDF invoices can share one email template); they rely on the
// invoice-number check. The description (vendor + invoice number) must also
// match, so a different invoice number never matches.
async function findSameNoticeExpense(conn, emailId, amount, description) {
  const me = await conn('emails').where({ id: emailId }).first('from_address', 'received_at', 'subject', 'has_attachments');
  if (!me?.from_address || !me?.received_at || !me?.subject || me.has_attachments) return null;
  return conn('expenses as x')
    .join('emails as e', 'e.expense_id', 'x.id')
    .where('e.from_address', me.from_address)
    .where('e.subject', me.subject)
    .where('x.description', description)
    .whereRaw('coalesce(e.has_attachments, false) = false')
    .whereNot('e.id', emailId)
    // Same second, not the same instant: Gmail keeps milliseconds.
    .whereRaw("date_trunc('second', e.received_at) = date_trunc('second', ?::timestamptz)", [me.received_at])
    .whereRaw("md5(coalesce(e.body_text, '') || coalesce(e.body_html, '')) = (select md5(coalesce(body_text, '') || coalesce(body_html, '')) from emails where id = ?)", [emailId])
    .whereRaw('x.amount = round(?::numeric, 2)', [String(amount)])
    .first('x.id');
}

// The classifier returns the amount as printed ("$10.06", "1,234.50 USD").
// parseFloat read "$10.06" as NaN, so every such receipt was skipped as
// "no_amount" (2026-10-05: 96 receipts, about $1,476, mostly Twilio, OpenAI,
// Google). Accept one money figure with an optional $ and USD and thousands
// commas; anything else is no amount.
function classifierAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value < 1e10 ? value : null;
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(?:USD\s*)?\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?\s*(?:USD)?$/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, '') + (m[2] || ''));
  // expenses.amount is decimal(12,2): the same ceiling isUsableInvoiceTotal applies.
  return Number.isFinite(n) && n < 1e10 ? n : null;
}

// Booking phase: the AI category suggestion (outside any transaction), then
// the duplicate check and the insert under one advisory lock. Logs carry ids
// only: the vendor name can be a person's display name.
async function bookExpense(email, { vendorName, vendorSource, expenseCategory, parsedInvoice, amount, invoiceNumber, invoiceDate, dateFromInvoice, taxYear, quarter }) {
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

    // Duplicate check and insert run under one advisory lock per vendor +
    // invoice number, so two copies of a receipt processed at the same
    // time cannot both insert. The AI suggestion above stays outside the
    // transaction: no lock is held across a model call.
    const key = duplicateKey(vendorName, invoiceNumber, vendorSource, dateFromInvoice);
    const outcome = await db.transaction(async (trx) => {
      // A reprocessed email (reclassify, replay) that already booked an
      // expense keeps it: no second row, no orphaned first one.
      const current = await trx('emails').where({ id: email.id }).forUpdate().first('expense_id');
      // Only a link to a row that still exists counts: an expense an admin
      // deleted leaves a stale id, and that email books again.
      if (current?.expense_id && await trx('expenses').where({ id: current.expense_id }).first('id')) {
        return { alreadyBooked: current.expense_id };
      }
      // Every receipt runs it, whatever the amount source, so the match does not
      // depend on which copy is processed first; the per-sender lock covers
      // two copies processed at once.
      await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`expense-notice:${String(email.from_address || '').toLowerCase()}`]);
      const copy = await findSameNoticeExpense(trx, email.id, amount, expenseDescription(vendorName, invoiceNumber));
      if (copy) {
        await trx('emails').where({ id: email.id }).update({
          expense_id: copy.id,
          auto_action: `expense_duplicate:${amount}`,
          updated_at: new Date(),
        });
        return { duplicateOf: copy.id };
      }
      if (key) {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [key]);
        const duplicate = await findDuplicateExpense(trx, vendorName, invoiceNumber, amount, invoiceDate);
        if (duplicate) {
          await trx('emails').where({ id: email.id }).update({
            expense_id: duplicate.id,
            auto_action: `expense_duplicate:${amount}`,
            updated_at: new Date(),
          });
          return { duplicateOf: duplicate.id };
        }
      }
      const [created] = await trx('expenses').insert({
        // Column limits (description varchar 300, vendor_name varchar 200): the
        // vendor name and the classifier's own invoice number are not bounded
        // upstream, so clip here rather than fail the insert.
        description: expenseDescription(vendorName, invoiceNumber),
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
      await trx('emails').where({ id: email.id }).update({
        expense_id: created.id,
        auto_action: `expense_created:${amount}`,
        updated_at: new Date(),
      });
      return { expense: created };
    });

    if (outcome.alreadyBooked) {
      logger.info(`[invoice-processor] Email ${email.id} already booked expense ${outcome.alreadyBooked}`);
    } else if (outcome.duplicateOf) {
      logger.info(`[invoice-processor] Email ${email.id} is a duplicate of expense ${outcome.duplicateOf}`);
    } else {
      logger.info(`[invoice-processor] Expense ${outcome.expense.id} created from email ${email.id}`);
    }
  } catch (err) {
    logger.error(`[invoice-processor] Expense creation failed: ${err.message}`);
    await db('emails').where({ id: email.id }).update({
      auto_action: `invoice_detected:${amount}:expense_failed`,
      updated_at: new Date(),
    });
  }
}

async function processVendorInvoice(email, classification) {
  const vendor = await vendorForSender(email.from_address);
  const expenseCategory = realCategoryName(vendor?.expense_category) || 'Uncategorized';

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

      const parseResponse = await ledgerCall('anthropic', MODELS.ROUTINE, () => anthropic.messages.create({
        model: MODELS.ROUTINE,
        ...anthropicEffortConfig(MODELS.ROUTINE, MODELS.ROUTINE_EFFORT),
        max_tokens: anthropicMaxTokens(MODELS.ROUTINE, 1024),
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
    { "description": "string", "quantity": number, "unit_price": number, "total": number, "uom": "the line's unit of measure exactly as printed (EA, CS, ...) or null", "product_name": "if identifiable" }
  ]
}`,
            },
          ],
        }],
      }), { laneId: 'invoice_pdf' });

      // A refusal's text is the model's explanation, never invoice data.
      const refused = parseResponse?.stop_reason === 'refusal';
      const rawInvoice = refused ? null : parseClaudeJson(anthropicText(parseResponse));
      if (!rawInvoice) ledgerCallRejected(parseResponse, refused ? 'refusal' : 'invalid_json');
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

  // Vendor name: the domain mapping (deterministic), else the name printed on
  // the invoice, else the classifier's, else the sender's display name (an
  // HTML-only receipt has no parsed invoice), else "Unknown Vendor". Only a label:
  // the tax category below still comes from the domain mapping alone.
  const [vendorName, vendorSource] = [
    [vendor?.vendor_name, 'mapping'],
    [nameOrNull(parsedInvoice?.vendor_name), 'invoice'],
    [nameOrNull(classification.extracted?.vendor_name), 'classifier'],
    [nameOrNull(email.from_name), 'sender'],
  ].find(([name]) => name) || ['Unknown Vendor', 'unknown'];

  // Create expense record
  // `??`, not `||`: a parsed total of 0 (a zero-total invoice or credit memo)
  // is the extraction's answer, not a missing one — `||` fell through to the
  // classifier's amount and created an expense for it (Codex r18 on #4884).
  const amount = parsedInvoice?.total ?? (classifierAmount(classification.extracted?.invoice_amount) || 0);
  // The subject guard follows where the AMOUNT came from: a parsed PDF with
  // no total also falls back to the classifier.
  const amountFromClassifier = parsedInvoice?.total == null;
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

  if (amount > 0 && amountFromClassifier && NOT_A_CHARGE_SUBJECT.test(String(email.subject || '').replace(/[\u2018\u2019\u02BC]/g, "'"))) {
    await db('emails').where({ id: email.id }).update({
      auto_action: 'invoice_detected:not_a_charge',
      updated_at: new Date(),
    });
  } else if (amount > 0) {
    await bookExpense(email, {
      vendorName, vendorSource, expenseCategory, parsedInvoice, amount, invoiceNumber, invoiceDate,
      dateFromInvoice: invoiceDate === candidateDate, taxYear, quarter,
    });
  } else {
    await db('emails').where({ id: email.id }).update({
      auto_action: 'invoice_detected:no_amount',
      updated_at: new Date(),
    });
  }
}

module.exports = { processVendorInvoice, isUsableInvoiceTotal, readParsedInvoice, senderDomainCandidates, classifierAmount, NOT_A_CHARGE_SUBJECT };
