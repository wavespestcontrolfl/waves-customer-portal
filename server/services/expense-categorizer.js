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
const db = require('../models/db');
const MODELS = require('../config/models');
const { dispatchWithFallback } = require('./llm/call');

// Structured-output contract (llm/call.js jsonSchema). The category-name
// match and sanitizeDeductiblePercent still decide what is trusted.
const CATEGORIZE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['categoryName', 'irsLine', 'deductiblePercent', 'reasoning'],
  properties: {
    categoryName: { type: 'string', description: 'Exact category name from the list' },
    irsLine: { type: 'string', description: 'The IRS line number' },
    deductiblePercent: { type: 'integer' },
    reasoning: { type: 'string', description: 'One sentence why' },
  },
};

/**
 * Returns { categoryId?, categoryName, irsLine, deductiblePercent, reasoning }.
 * categoryId is set only when the AI's pick matches a real expense_categories
 * row. Throws on API failure — callers decide whether that blocks the insert.
 */
async function autoCategorizeExpense(vendorName, description, amount) {
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

Give the exact category name from the list above, its IRS line number, the deductible percent, and one sentence of reasoning.

Rules:
- Business meals are 50% deductible
- Vehicle expenses: use "Vehicle Expenses" category
- Software, SaaS, hosting: use "Software & Technology"
- Chemicals, PPE, equipment supplies: use "Supplies"
- If truly unclear, use "Office Expenses" as default`;

  // FLAGSHIP first, Sol on a miss. A two-leg miss throws like the old SDK
  // path did — callers decide whether that blocks the insert.
  const res = await dispatchWithFallback(MODELS.TEXT_POLICIES.highStakes, {
    laneId: 'expense_categorize',
    text: prompt,
    jsonMode: true,
    jsonSchema: CATEGORIZE_SCHEMA,
    maxTokens: 200,
  });
  if (!res.ok || !res.json) throw new Error(`expense categorizer LLM unavailable (${res.reason || 'no_json'})`);
  const parsed = res.json;

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
