/**
 * CSV Generator helpers for Tax Center exports
 * Each function takes an array of data objects and returns a CSV string.
 */

function esc(val) {
  if (val == null) return '';
  let s = String(val);
  // Prevent CSV formula injection (Excel executes cells starting with = + - @ \t \r)
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function row(vals) {
  return vals.map(esc).join(',');
}

function transactionsToCSV(payments) {
  const headers = ['Date', 'Type', 'Customer', 'Description', 'Amount', 'Status', 'Processor', 'Payment Method', 'Last Four', 'Refund Amount', 'Transaction ID'];
  const lines = [row(headers)];
  for (const p of payments) {
    lines.push(row([
      p.date || p.payment_date || p.created_at || '',
      p.type || p.payment_type || '',
      p.customer_name || p.customer || '',
      p.description || p.memo || '',
      p.amount != null ? parseFloat(p.amount).toFixed(2) : '',
      p.status || '',
      p.processor || p.source || '',
      p.payment_method || p.method || '',
      p.last_four || p.last4 || '',
      p.refund_amount != null ? parseFloat(p.refund_amount).toFixed(2) : '',
      p.transaction_id || p.external_id || '',
    ]));
  }
  return lines.join('\n');
}

function expensesToCSV(expenses) {
  const headers = ['Date', 'Schedule C Line', 'Category', 'Vendor', 'Description', 'Amount', 'Payment Method', 'Has Receipt'];
  const lines = [row(headers)];
  for (const e of expenses) {
    lines.push(row([
      e.expense_date || e.date || '',
      e.irs_line || e.schedule_c_line || '',
      e.category_name || e.category || '',
      e.vendor_name || e.vendor || '',
      e.description || '',
      e.amount != null ? parseFloat(e.amount).toFixed(2) : '',
      e.payment_method || '',
      e.has_receipt ? 'Yes' : 'No',
    ]));
  }
  return lines.join('\n');
}

function mileageToCSV(trips) {
  const headers = ['Date', 'Start Location', 'End Location', 'Business Miles', 'Purpose', 'IRS Rate', 'Deduction Amount'];
  const lines = [row(headers)];
  for (const t of trips) {
    lines.push(row([
      t.trip_date || t.date || '',
      t.start_address || t.start_location || '',
      t.end_address || t.end_location || '',
      t.distance_miles != null ? parseFloat(t.distance_miles).toFixed(1) : '',
      t.purpose || 'business',
      t.irs_rate != null ? parseFloat(t.irs_rate).toFixed(2) : '',
      t.deduction_amount != null ? parseFloat(t.deduction_amount).toFixed(2) : '',
    ]));
  }
  return lines.join('\n');
}

function depreciationToCSV(equipment) {
  const headers = ['Asset Name', 'Category', 'Purchase Date', 'Cost Basis', 'Method', 'Useful Life', 'Annual Depreciation', 'Accumulated', 'Book Value', 'Section 179'];
  const lines = [row(headers)];
  for (const e of equipment) {
    lines.push(row([
      e.name || '',
      e.asset_category || e.category || '',
      e.purchase_date || '',
      e.purchase_cost != null ? parseFloat(e.purchase_cost).toFixed(2) : '',
      e.depreciation_method || '',
      e.useful_life_years != null ? `${e.useful_life_years} yrs` : '',
      e.annual_depreciation != null ? parseFloat(e.annual_depreciation).toFixed(2) : '',
      e.accumulated_depreciation != null ? parseFloat(e.accumulated_depreciation).toFixed(2) : '',
      e.current_book_value != null ? parseFloat(e.current_book_value).toFixed(2) : '',
      e.section_179_elected ? `Yes ($${parseFloat(e.section_179_amount || 0).toFixed(2)})` : 'No',
    ]));
  }
  return lines.join('\n');
}

function laborToCSV(summaries) {
  const headers = ['Week Starting', 'Technician', 'Regular Hours', 'OT Hours', 'Total Hours', 'Jobs', 'Rate', 'Regular Pay', 'OT Pay', 'Total Cost'];
  const lines = [row(headers)];
  for (const s of summaries) {
    const regHrs = parseFloat(s.regular_hours || s.total_hours || 0);
    const otHrs = parseFloat(s.ot_hours || s.overtime_hours || 0);
    const totalHrs = regHrs + otHrs;
    const rate = parseFloat(s.hourly_rate || s.rate || 0);
    const regPay = regHrs * rate;
    const otPay = otHrs * rate * 1.5;
    lines.push(row([
      s.week_start || s.date || '',
      s.technician_name || s.tech_name || s.name || '',
      regHrs.toFixed(1),
      otHrs.toFixed(1),
      totalHrs.toFixed(1),
      s.jobs_completed || s.jobs || '',
      rate.toFixed(2),
      regPay.toFixed(2),
      otPay.toFixed(2),
      (s.total_cost != null ? parseFloat(s.total_cost) : regPay + otPay).toFixed(2),
    ]));
  }
  return lines.join('\n');
}

function pnlToCSV(pnlData) {
  const lines = [row(['Line Item', 'Amount'])];
  lines.push(row(['', '']));
  lines.push(row(['REVENUE', '']));
  lines.push(row(['  Service Revenue', (pnlData.revenue?.serviceRevenue || 0).toFixed(2)]));
  lines.push(row(['  Other Revenue', (pnlData.revenue?.otherRevenue || 0).toFixed(2)]));
  lines.push(row(['Total Revenue', (pnlData.revenue?.total || 0).toFixed(2)]));
  lines.push(row(['', '']));
  lines.push(row(['COST OF GOODS SOLD', '']));
  lines.push(row(['  Labor', (pnlData.cogs?.labor || 0).toFixed(2)]));
  lines.push(row(['  Materials & Supplies', (pnlData.cogs?.materials || 0).toFixed(2)]));
  lines.push(row(['Total COGS', (pnlData.cogs?.total || 0).toFixed(2)]));
  lines.push(row(['', '']));
  lines.push(row(['GROSS PROFIT', (pnlData.grossProfit || 0).toFixed(2)]));
  lines.push(row(['Gross Margin', ((pnlData.grossMargin || 0) * 100).toFixed(1) + '%']));
  lines.push(row(['', '']));
  lines.push(row(['OPERATING EXPENSES', '']));
  if (pnlData.operatingExpenses?.categories) {
    for (const cat of pnlData.operatingExpenses.categories) {
      lines.push(row([`  ${cat.name || cat.category}`, (cat.amount || cat.total || 0).toFixed(2)]));
    }
  }
  lines.push(row(['Total Operating Expenses', (pnlData.operatingExpenses?.total || 0).toFixed(2)]));
  lines.push(row(['', '']));
  lines.push(row(['DEDUCTIONS', '']));
  lines.push(row(['  Mileage Deduction', (pnlData.deductions?.mileage || 0).toFixed(2)]));
  lines.push(row(['  Depreciation', (pnlData.deductions?.depreciation || 0).toFixed(2)]));
  lines.push(row(['Total Deductions', (pnlData.deductions?.total || 0).toFixed(2)]));
  lines.push(row(['', '']));
  lines.push(row(['NET INCOME', (pnlData.netIncome || 0).toFixed(2)]));
  lines.push(row(['Net Margin', ((pnlData.netMargin || 0) * 100).toFixed(1) + '%']));
  return lines.join('\n');
}

function generateReadme(year, pnlData) {
  const now = new Date().toISOString().split('T')[0];
  const lines = [
    `Waves Pest Control — ${year} Tax Package`,
    `Generated: ${now}`,
    ``,
    `This ZIP contains the following CSV files for your CPA:`,
    ``,
    `  1. transactions.csv     — All payment transactions`,
    `  2. expenses.csv         — Business expenses by Schedule C category`,
    `  3. mileage.csv          — Business mileage log (IRS format)`,
    `  4. depreciation.csv     — Equipment depreciation schedule`,
    `  5. labor.csv            — Labor costs by technician`,
    `  6. pnl.csv              — Profit & Loss statement`,
    ``,
    `Summary for ${year}:`,
  ];
  if (pnlData) {
    lines.push(`  Revenue:           $${(pnlData.revenue?.total || 0).toFixed(2)}`);
    lines.push(`  COGS:              $${(pnlData.cogs?.total || 0).toFixed(2)}`);
    lines.push(`  Gross Profit:      $${(pnlData.grossProfit || 0).toFixed(2)}`);
    lines.push(`  Operating Exp:     $${(pnlData.operatingExpenses?.total || 0).toFixed(2)}`);
    lines.push(`  Deductions:        $${(pnlData.deductions?.total || 0).toFixed(2)}`);
    lines.push(`  Net Income:        $${(pnlData.netIncome || 0).toFixed(2)}`);
  }
  lines.push(``);
  lines.push(`Prepared for filing purposes. Consult your CPA for tax advice.`);
  lines.push(`Waves Pest Control, SW Florida`);
  return lines.join('\n');
}

module.exports = {
  transactionsToCSV,
  expensesToCSV,
  mileageToCSV,
  depreciationToCSV,
  laborToCSV,
  pnlToCSV,
  generateReadme,
};
