/**
 * Seed the rodent guarantee operational SOP into the knowledge base.
 *
 * This is operational guidance, not pricing logic — what to do when a
 * customer on the Rodent Guarantee Combo reports re-entry during the
 * guarantee term. The pricing engine never sees this; the team does.
 *
 * Idempotent: re-running updates the existing entry.
 */

const ARTICLE = {
  path: 'wiki/operations/rodent-guarantee-sop.md',
  title: 'Rodent Guarantee — Operational SOP',
  summary: 'How to handle re-entry calls on customers under the Rodent Guarantee Combo (12/24-mo). Retreatment is free; do NOT reprice bait stations to standalone rates; flag for full-redo review at 3+ re-entries.',
  category: 'operations',
  tags: ['rodent', 'guarantee', 'exclusion', 'sop', 'service'],
  content: `# Rodent Guarantee — Operational SOP

## Purpose
Defines what happens when a customer on the **Rodent Guarantee Combo** (12-mo or 24-mo) reports rodent re-entry during the guarantee term. This is the team-facing playbook; the pricing engine handles none of this — it's purely operational.

## Core Rules

### 1. Retreatment is free
The guarantee is the product. If a guaranteed customer reports rodents inside the structure during the active term, the retreatment visit and any re-sealing work is **at no charge**. No invoice, no upcharge, no exception.

### 2. Do NOT reprice bait stations to standalone rates
Re-entry means a seal failed, not that the exclusion concept failed. Bait station pricing on a guarantee customer **stays at the post-exclusion rate** (~28% off standalone) for the entire guarantee term — even after a retreatment. Repricing them mid-term would punish the customer for a failure on our side.

### 3. 3+ re-entries triggers a full redo review
If the same customer reports re-entry **three or more times** during the guarantee term:
- Flag the account for review at the next renewal cycle.
- The exclusion job may need a complete redo (different sealing materials, missed entry path, structural issue).
- The combo should be **re-evaluated** at renewal — not silently rolled over. Either rebuild the exclusion under warranty or recommend not renewing the combo and moving the customer to standalone monitoring.

## Workflow

### When the call comes in (Virginia / CSR)
1. Confirm the customer is on an **active guarantee combo** (check tier + start date in profile).
2. Tag the appointment as **"guarantee retreatment — no charge"** in the schedule.
3. Increment the customer's **re-entry counter** for the term (custom field on customer record).
4. Do NOT prompt for payment in any reminder/confirmation SMS.

### When the tech arrives (Adam / Jose / Jacob)
1. **Walk the seal first.** Re-entry is a failed seal until proven otherwise. Inspect the original exclusion points before treating.
2. Photograph any failed seals (broken caulk, displaced mesh, gnaw-through fabric, missed point).
3. **Re-seal on the spot** if the failed point is accessible and material is on the truck. If not, schedule a follow-up exclusion visit (still no charge).
4. Bait the area as needed using the same products as the original exclusion job.
5. Document the failure mode in the service report — this feeds the 3+ review threshold.

### After the visit
- Update the customer profile: re-entry count, failure mode, action taken.
- If this was the 3rd re-entry: flag the account in the admin portal for review.
- The Customer Retention agent should pick up the account and drop a check-in at +14 days.

## What This Is NOT

- This is **not** a way to get free pest control by claiming re-entry. The tech inspection is the gate; if there's no evidence of re-entry (droppings, gnaw marks, sightings with timestamps), the retreatment is logged but no further work is scheduled. Repeat false claims are noted on the profile.
- This is **not** a perpetual warranty. The guarantee is term-bound (12 or 24 months from the **exclusion completion date**, not the sale date).
- This is **not** a substitute for proper inspection at sale. If the original inspection missed an entry path, that's on us — own it, fix it, don't argue with the customer.

## Common Re-Entry Failure Modes

| Mode | Cause | Fix |
|---|---|---|
| Caulk shrinkage | Hot/cold cycling on south-facing walls | Replace with high-grade urethane sealant |
| Mesh displacement | Mesh installed without enough overlap | Re-pack point with copper mesh + secure with screen + caulk |
| Gnaw-through fabric | Used standard fabric where xcluder was needed | Replace with xcluder, document point as "high-pressure" |
| Missed soffit return | Overlooked at original walkthrough | Add to standard inspection checklist |
| New entry from animal damage | Squirrels, raccoons making new openings | Reseal + recommend wildlife exclusion add-on (separate quote) |

## Renewal Decision Tree

At guarantee expiration:
- **0 re-entries** → renew at standard combo pricing. Customer sees the value.
- **1–2 re-entries** → renew, but flag the property as "active monitoring" — bump quarterly visit duration.
- **3+ re-entries** → mandatory review. Either: (a) full exclusion redo under warranty + new guarantee, or (b) move customer off combo to standalone bait monitoring. Do not silently re-up.

## Why This Matters

The Rodent Guarantee Combo is the highest-AOV residential service we sell ($695–$2,500+). The customer is buying **peace of mind**, not bait stations. Every operational interaction should reinforce that. A guarantee customer who calls about a single sighting and gets a free, fast, professional retreatment becomes a referral source. A guarantee customer who feels nickel-and-dimed becomes a one-star review.

## Related
- [[wiki/business-strategy/route-density-economics.md|Route density and why it drives profit]]
- Pricing logic: \`calculateRodentGuaranteeCombo\` in \`server/services/pricing-engine/service-pricing.js\`
- Pricing logic: \`priceRodentBait\` with \`postExclusion: true\` (auto-set in combo)

## Sources
- Founder operational notes, April 2026
- post-exclusion-modifier-spec.md (edge case section)
`,
};

exports.up = async function (knex) {
  const wordCount = ARTICLE.content.split(/\s+/).filter(Boolean).length;
  const existing = await knex('knowledge_base').where('path', ARTICLE.path).first();
  if (existing) {
    await knex('knowledge_base').where('id', existing.id).update({
      title: ARTICLE.title,
      category: ARTICLE.category,
      summary: ARTICLE.summary,
      content: ARTICLE.content,
      tags: JSON.stringify(ARTICLE.tags),
      word_count: wordCount,
      last_compiled: new Date(),
      version: (existing.version || 1) + 1,
      active: true,
      updated_at: new Date(),
    });
  } else {
    await knex('knowledge_base').insert({
      path: ARTICLE.path,
      title: ARTICLE.title,
      category: ARTICLE.category,
      summary: ARTICLE.summary,
      content: ARTICLE.content,
      tags: JSON.stringify(ARTICLE.tags),
      backlinks: JSON.stringify([]),
      source_documents: JSON.stringify(['founder-notes:2026-04', 'post-exclusion-modifier-spec.md']),
      word_count: wordCount,
      last_compiled: new Date(),
      version: 1,
      active: true,
    });
  }
};

exports.down = async function (knex) {
  await knex('knowledge_base').where('path', ARTICLE.path).del();
};
