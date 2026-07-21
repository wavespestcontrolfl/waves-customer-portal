/**
 * AI expense categorization — Claude maps an expense to an IRS Schedule C
 * category from the expense_categories table.
 *
 * Extracted from admin-tax.js (2026-07-21) so BOTH expense writers share it:
 * the admin POST /expenses route AND the email invoice-processor. The
 * processor previously resolved categories only via vendor_email_domains —
 * with no domain mapping every emailed invoice landed category_id NULL,
 * which is how prod reached 138/138 uncategorized expenses (0% Schedule C
 * coverage) while the categorizer sat unused on a path nothing exercised.
 */
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../models/db');
const MODELS = require('../config/models');

/**
 * Returns { categoryId?, categoryName, irsLine, deductiblePercent, reasoning }.
 * categoryId is set only when the AI's pick matches a real expense_categories
 * row. Throws on API failure — callers decide whether that blocks the insert.
 */
async function autoCategorizeExpense(vendorName, description, amount) {
  const client = new Anthropic();

  const categories = await db('expense_categories').orderBy('sort_order');
  const categoryList = categories.map(c =>
    `- ${c.name} (IRS Line ${c.irs_line}): ${c.irs_description}${c.notes ? ` — ${c.notes}` : ''}`
  ).join('\n');

  const prompt = `You are a tax categorization assistant for a pest control / lawn care business in Florida.

Given this expense, categorize it into the correct IRS Schedule C category and determine deductibility.

Expense details:
- Vendor: ${vendorName || 'Unknown'}
- Description: ${description || 'None provided'}
- Amount: $${amount}

Available categories:
${categoryList}

Respond ONLY with valid JSON (no markdown, no explanation):
{
  "categoryName": "exact category name from the list above",
  "irsLine": "the IRS line number",
  "deductiblePercent": 100,
  "reasoning": "one sentence why"
}

Rules:
- Business meals are 50% deductible
- Vehicle expenses: use "Vehicle Expenses" category
- Software, SaaS, hosting: use "Software & Technology"
- Chemicals, PPE, equipment supplies: use "Supplies"
- If truly unclear, use "Office Expenses" as default`;

  const response = await client.messages.create({
    model: MODELS.FLAGSHIP,
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0]?.text || '{}';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    parsed = match ? JSON.parse(match[0]) : {};
  }

  if (parsed.categoryName) {
    const match = categories.find(c =>
      c.name.toLowerCase() === parsed.categoryName.toLowerCase()
    );
    if (match) {
      parsed.categoryId = match.id;
    }
  }

  return parsed;
}

/**
 * The AI's deductiblePercent is derived from UNTRUSTED input (emailed
 * invoice content can prompt-inject it; the model can hallucinate) — it may
 * only SELECT from server-owned partial-deduction policies, never supply an
 * arbitrary percentage. Today the sole policy is the IRS 50% business-meals
 * limitation; extend the set only alongside a real policy. Anything else
 * returns null → the caller keeps the full amount for operator review.
 */
const ALLOWED_PARTIAL_DEDUCTION_PERCENTS = new Set([50]);

function sanitizeDeductiblePercent(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return ALLOWED_PARTIAL_DEDUCTION_PERCENTS.has(n) ? n : null;
}

/**
 * Server-owned partial-deduction policy keyed by the MATCHED category name —
 * NOT by the model's echoed `deductiblePercent`. The model picking
 * "Meals & Entertainment" but omitting (or overstating) the field must still
 * yield the IRS 50% limitation, so the percent is derived from the category
 * the server resolved, not from untrusted output. Values still pass through
 * sanitizeDeductiblePercent so an un-sanctioned entry is inert rather than
 * shipping a new deduction rule. A category with no entry means "full amount".
 * expense_categories has only an is_deductible boolean — no percent column —
 * so this map is where the graduated policy lives.
 */
const CATEGORY_DEDUCTIBLE_PCT = { 'Meals & Entertainment': 50 };

/**
 * The deductible amount for `amount` under the matched category's policy, or
 * null to mean "leave the full amount" (no partial policy applies).
 */
function categoryDeductibleAmount(categoryName, amount) {
  const pct = sanitizeDeductiblePercent(CATEGORY_DEDUCTIBLE_PCT[categoryName]);
  if (pct === null) return null;
  return parseFloat(((Number(amount) || 0) * pct / 100).toFixed(2));
}

module.exports = {
  autoCategorizeExpense,
  sanitizeDeductiblePercent,
  CATEGORY_DEDUCTIBLE_PCT,
  categoryDeductibleAmount,
};
