/**
 * Banking Export — OFX + CSV generators
 * server/services/banking-export.js
 *
 * Generates bank-compatible export files from Stripe payout data.
 * OFX 1.0 format for Capital One / QuickBooks import.
 * CSV for spreadsheet analysis.
 */

const logger = require('./logger');


// ═══════════════════════════════════════════════════════════════
// OFX EXPORT
// ═══════════════════════════════════════════════════════════════

/**
 * Generate OFX 1.0 (SGML) format for bank import.
 * Each payout becomes a STMTTRN CREDIT entry.
 *
 * @param {Array} payouts — stripe_payouts rows
 * @param {string} startDate — YYYY-MM-DD
 * @param {string} endDate — YYYY-MM-DD
 * @returns {{ content: string, filename: string, content_type: string }}
 */
function generateOFX(payouts, startDate, endDate) {
  try {
    const dtStart = formatOFXDate(startDate);
    const dtEnd = formatOFXDate(endDate);
    const dtServer = formatOFXDate(new Date().toISOString().split('T')[0]);

    // Calculate ledger balance from payouts
    const ledgerBal = payouts.reduce((s, p) => s + parseFloat(p.amount || 0), 0);

    let ofx = '';

    // OFX header (SGML, not XML — for broadest compatibility)
    ofx += 'OFXHEADER:100\n';
    ofx += 'DATA:OFXSGML\n';
    ofx += 'VERSION:102\n';
    ofx += 'SECURITY:NONE\n';
    ofx += 'ENCODING:USASCII\n';
    ofx += 'CHARSET:1252\n';
    ofx += 'COMPRESSION:NONE\n';
    ofx += 'OLDFILEUID:NONE\n';
    ofx += 'NEWFILEUID:NONE\n';
    ofx += '\n';

    // OFX body
    ofx += '<OFX>\n';
    ofx += '<SIGNONMSGSRSV1>\n';
    ofx += '<SONRS>\n';
    ofx += '<STATUS><CODE>0<SEVERITY>INFO</STATUS>\n';
    ofx += `<DTSERVER>${dtServer}\n`;
    ofx += '<LANGUAGE>ENG\n';
    ofx += '</SONRS>\n';
    ofx += '</SIGNONMSGSRSV1>\n';

    ofx += '<BANKMSGSRSV1>\n';
    ofx += '<STMTTRNRS>\n';
    ofx += '<TRNUID>0\n';
    ofx += '<STATUS><CODE>0<SEVERITY>INFO</STATUS>\n';

    ofx += '<STMTRS>\n';
    ofx += '<CURDEF>USD\n';
    ofx += '<BANKACCTFROM>\n';
    ofx += '<BANKID>STRIPE\n';
    ofx += '<ACCTID>WAVES_PEST_CONTROL\n';
    ofx += '<ACCTTYPE>CHECKING\n';
    ofx += '</BANKACCTFROM>\n';

    ofx += '<BANKTRANLIST>\n';
    ofx += `<DTSTART>${dtStart}\n`;
    ofx += `<DTEND>${dtEnd}\n`;

    // Each payout as a transaction
    for (const p of payouts) {
      const amount = parseFloat(p.amount || 0);
      const arrivalDate = formatOFXDate(
        p.arrival_date
          ? new Date(p.arrival_date).toISOString().split('T')[0]
          : new Date(p.created_at).toISOString().split('T')[0]
      );

      const txnCount = p.transaction_count || 0;
      const feeTotal = parseFloat(p.fee_total || 0);
      const memo = `Stripe payout: ${txnCount} txn${txnCount !== 1 ? 's' : ''}, $${feeTotal.toFixed(2)} fees`;

      ofx += '<STMTTRN>\n';
      ofx += `<TRNTYPE>${amount < 0 ? 'DEBIT' : 'CREDIT'}\n`;
      ofx += `<DTPOSTED>${arrivalDate}\n`;
      ofx += `<TRNAMT>${amount.toFixed(2)}\n`;
      ofx += `<FITID>${sgmlEscape(p.stripe_payout_id)}\n`;
      ofx += '<NAME>Stripe Payout\n';
      ofx += `<MEMO>${sgmlEscape(memo)}\n`;
      ofx += '</STMTTRN>\n';
    }

    ofx += '</BANKTRANLIST>\n';

    ofx += '<LEDGERBAL>\n';
    ofx += `<BALAMT>${ledgerBal.toFixed(2)}\n`;
    ofx += `<DTASOF>${dtEnd}\n`;
    ofx += '</LEDGERBAL>\n';

    ofx += '</STMTRS>\n';
    ofx += '</STMTTRNRS>\n';
    ofx += '</BANKMSGSRSV1>\n';
    ofx += '</OFX>\n';

    const filename = `waves-payouts-${startDate}-to-${endDate}.ofx`;

    return {
      content: ofx,
      filename,
      content_type: 'application/x-ofx',
      payout_count: payouts.length,
      total_amount: Math.round(ledgerBal * 100) / 100,
    };
  } catch (err) {
    logger.error('[banking-export] OFX generation failed:', err);
    throw err;
  }
}


// ═══════════════════════════════════════════════════════════════
// CSV EXPORT
// ═══════════════════════════════════════════════════════════════

/**
 * Generate CSV with payout summary rows + transaction detail section.
 *
 * @param {Array} payouts — stripe_payouts rows
 * @param {Array} transactions — stripe_payout_transactions rows
 * @returns {{ content: string, filename: string, content_type: string }}
 */
function generateCSV(payouts, transactions) {
  try {
    const rows = [];

    // ── Payout Summary Section ──────────────────────────────────
    rows.push('=== PAYOUT SUMMARY ===');
    rows.push([
      'Payout ID', 'Amount', 'Fees', 'Net', 'Status', 'Arrival Date',
      'Method', 'Transactions', 'Bank', 'Reconciled',
    ].join(','));

    for (const p of payouts) {
      const amount = parseFloat(p.amount || 0);
      const fees = parseFloat(p.fee_total || 0);
      const net = amount - fees;
      const arrivalDate = p.arrival_date
        ? new Date(p.arrival_date).toISOString().split('T')[0]
        : '';

      rows.push([
        csvEscape(p.stripe_payout_id),
        amount.toFixed(2),
        fees.toFixed(2),
        net.toFixed(2),
        csvEscape(p.status),
        arrivalDate,
        csvEscape(p.method || ''),
        p.transaction_count || 0,
        csvEscape(p.bank_name || ''),
        p.reconciled ? 'Yes' : 'No',
      ].join(','));
    }

    // Totals row
    const totalAmount = payouts.reduce((s, p) => s + parseFloat(p.amount || 0), 0);
    const totalFees = payouts.reduce((s, p) => s + parseFloat(p.fee_total || 0), 0);
    rows.push([
      'TOTAL',
      totalAmount.toFixed(2),
      totalFees.toFixed(2),
      (totalAmount - totalFees).toFixed(2),
      '', '', '', payouts.reduce((s, p) => s + (p.transaction_count || 0), 0),
      '', '',
    ].join(','));

    // ── Transaction Detail Section ──────────────────────────────
    if (transactions && transactions.length > 0) {
      rows.push('');
      rows.push('=== TRANSACTION DETAILS ===');
      rows.push([
        'Txn ID', 'Payout ID', 'Type', 'Amount', 'Fee', 'Net',
        'Customer', 'Description', 'Date',
      ].join(','));

      for (const t of transactions) {
        rows.push([
          csvEscape(t.stripe_txn_id || ''),
          csvEscape(t.payout_id || ''),
          csvEscape(t.type || ''),
          parseFloat(t.amount || 0).toFixed(2),
          parseFloat(t.fee || 0).toFixed(2),
          parseFloat(t.net || 0).toFixed(2),
          csvEscape(t.customer_name || ''),
          csvEscape(t.description || ''),
          t.created_at_stripe ? new Date(t.created_at_stripe).toISOString().split('T')[0] : '',
        ].join(','));
      }
    }

    const content = rows.join('\n');
    const now = new Date().toISOString().split('T')[0];
    const filename = `waves-payouts-export-${now}.csv`;

    return {
      content,
      filename,
      content_type: 'text/csv',
      payout_count: payouts.length,
      transaction_count: transactions ? transactions.length : 0,
      total_amount: Math.round(totalAmount * 100) / 100,
    };
  } catch (err) {
    logger.error('[banking-export] CSV generation failed:', err);
    throw err;
  }
}


// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

/**
 * Format a YYYY-MM-DD date string to OFX date format (YYYYMMDD).
 */
function formatOFXDate(dateStr) {
  return dateStr.replace(/-/g, '');
}

/**
 * Escape SGML entities for OFX element values. OFX 1.x is SGML-based, so
 * unescaped < > & in memos/names can break bank-side parsers.
 */
function sgmlEscape(val) {
  if (val == null) return '';
  return String(val).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Escape a value for CSV (wrap in quotes if it contains commas or quotes).
 */
function csvEscape(val) {
  if (val == null) return '';
  let str = String(val);
  // Neutralize spreadsheet formula injection: prepend apostrophe when a cell
  // starts with a formula-trigger character. Excel/Sheets/Numbers all respect this.
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}


module.exports = { generateOFX, generateCSV };
