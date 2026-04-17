const Anthropic = require('@anthropic-ai/sdk');
const db = require('../../models/db');
const gmailClient = require('./gmail-client');
const logger = require('../logger');
const MODELS = require('../../config/models');

const anthropic = new Anthropic();

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

      const parseResponse = await anthropic.messages.create({
        model: MODELS.FLAGSHIP,
        max_tokens: 1024,
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
      });

      parsedInvoice = parseClaudeJson(parseResponse.content[0].text);

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
  const amount = parsedInvoice?.total || parseFloat(classification.extracted?.invoice_amount) || 0;
  const invoiceNumber = parsedInvoice?.invoice_number || classification.extracted?.invoice_number;
  const rawInvoiceDate = parsedInvoice?.invoice_date || classification.extracted?.invoice_date;
  const parsedDate = rawInvoiceDate ? new Date(rawInvoiceDate) : null;
  const invoiceDateValid = parsedDate && !Number.isNaN(parsedDate.getTime());
  const invoiceDate = invoiceDateValid
    ? parsedDate.toISOString().split('T')[0]
    : new Date().toISOString().split('T')[0];
  const taxYear = (invoiceDateValid ? parsedDate : new Date()).getFullYear().toString();

  if (amount > 0) {
    try {
      const categoryRow = await db('expense_categories').whereILike('name', `%${expenseCategory}%`).first();

      const [expense] = await db('expenses').insert({
        description: `${vendorName} Invoice${invoiceNumber ? ` #${invoiceNumber}` : ''} — via email`,
        amount,
        tax_deductible_amount: amount,
        category_id: categoryRow?.id || null,
        vendor_name: vendorName,
        expense_date: invoiceDate,
        tax_year: taxYear,
        payment_method: 'invoice',
        notes: `Auto-imported from email. Subject: "${email.subject}". Pending review.`,
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

module.exports = { processVendorInvoice };
