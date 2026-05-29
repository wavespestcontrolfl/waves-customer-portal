/**
 * Data fix — correct the Charlotte/North Port fertilizer-blackout facts in the
 * two LIVE tables that carry them, on deploy:
 *   1) knowledge_base  — informational (Intelligence Bar / recommendation context)
 *   2) municipality_ordinances — OPERATIONAL (drives the product blackout blockers
 *      in waveguard-plan-engine + admin-dispatch)
 *
 * Context: PR #1329 corrected the seed (Charlotte DOES have the June 1-Sept 30
 * blackout; North Port starts April 1) and added a `forceUpdate` flag. But
 * forceUpdate only corrects an already-seeded row when someone MANUALLY re-runs
 * scripts/seed-knowledge-base.js. Deploys run knex migrations, not the seed — so
 * without this migration the live rows keep the stale "Charlotte does NOT have
 * the blackout" data. The KB drives what the Intelligence Bar SAYS; the
 * municipality_ordinances row drives what the product checks actually BLOCK.
 * Fixing only the KB would leave Charlotte N/P applications operationally allowed
 * during the real blackout (Codex P2 on #1329 + #1342).
 *
 * Self-contained: KB content embedded as JSON (canonical, matches main's seed).
 * Both updates are update-only and idempotent; fresh environments get correct
 * data from their respective seeds.
 */

const SLUG = "nitrogen-blackout-sarasota-manatee";
const ENTRY = {
  "title": "Nitrogen Blackout — Sarasota, Manatee & Charlotte Counties",
  "tags": [
    "nitrogen",
    "phosphorus",
    "fertilizer",
    "blackout",
    "regulation",
    "sarasota",
    "manatee",
    "charlotte"
  ],
  "content": "# Nitrogen Blackout — June 1 through September 30\n\nSarasota, Manatee, AND Charlotte counties all prohibit nitrogen- and phosphorus-containing fertilizer application from June 1 to September 30 each year.\n\n## Key Rules\n- NO nitrogen in ANY form during the blackout window (liquid, granular, slow-release)\n- NO phosphorus during the blackout window\n- Iron-only and micronutrient-only applications ARE allowed during blackout\n- Potassium (0-0-X) products ARE allowed\n- Outside the blackout, ≥50% slow-release nitrogen is required (all three counties)\n- Violation can result in fines and license issues\n\n## Impact on Lawn Programs\n- Switch to iron + micro treatments (FeSO4, chelated iron) June-September\n- Pre-load nitrogen in late May (last app before June 1) — EXCEPT North Port, where the last app is before APRIL 1 (city ordinance; see North Port Exception below)\n- Resume nitrogen in early October (first app after September 30)\n- Communicate blackout reason to customers proactively — prevents \"why is my lawn yellow\" calls\n\n## County Scope\nAll three Waves service counties — Sarasota, Manatee, and Charlotte — run the same June 1–Sept 30 county blackout. Charlotte County's ordinance (in place since 2008) protects Charlotte Harbor from red-tide / algal-bloom nutrient runoff. Geo note: North Port falls under Sarasota County; Port Charlotte under Charlotte County.\n\n## ⚠ North Port Exception — Blackout Starts April 1\nThe City of North Port has its OWN fertilizer ordinance with a LONGER restricted period: April 1 through September 30 (nitrogen AND phosphorus on turf), broader than the June 1–Sept 30 county window. For North Port jobs the LAST nitrogen application is before APRIL 1 (not June 1); resume after September 30. Do NOT apply the June 1 county date to North Port. (Encoded in server/config/protocols.json — \"LAST N before Jun 1 blackout (Apr 1 North Port)\".)\n\nSources: charlottecountyfl.gov (One Charlotte One Water) for Charlotte County; cityofnorthport.com fertilizer ordinance for the North Port April 1 start. Verified 2026-05-28."
};

exports.up = async function up(knex) {
  // 1) knowledge_base — INFORMATIONAL layer (Intelligence Bar / recommendation
  //    context). Update-only; fresh envs get correct content from the seed.
  if (await knex.schema.hasTable('knowledge_base')) {
    const existing = await knex('knowledge_base').where({ slug: SLUG }).first();
    if (existing) {
      await knex('knowledge_base').where({ slug: SLUG }).update({
        title: ENTRY.title,
        tags: JSON.stringify(ENTRY.tags),
        content: ENTRY.content,
        confidence: 'high',
        last_verified_at: new Date(),
        verified_by: 'migration-blackout-charlotte-northport',
      });
    }
  }

  // 2) municipality_ordinances — OPERATIONAL layer. This table drives the actual
  //    product blackout blockers in WaveGuard plan-engine (getApplicableOrdinances)
  //    and admin-dispatch (actualProductBlackoutBlocks). Charlotte County was
  //    seeded (20260430000011) with restricted_nitrogen/phosphorus = false and a
  //    null window, so the blockers WRONGLY allow N/P in Charlotte Jun 1–Sep 30 —
  //    a compliance gap that fixing only the KB would leave open. Correct the
  //    active county row in place (this was a data error, not a real ordinance
  //    amendment). Verified vs charlottecountyfl.gov 2026-05-28.
  if (await knex.schema.hasTable('municipality_ordinances')) {
    await knex('municipality_ordinances')
      .where({ jurisdiction_type: 'county', jurisdiction_name: 'Charlotte County', active: true })
      .update({
        restricted_start_month: 6,
        restricted_start_day: 1,
        restricted_end_month: 9,
        restricted_end_day: 30,
        restricted_nitrogen: true,
        restricted_phosphorus: true,
        source_url: 'https://www.charlottecountyfl.gov/one-charlotte-one-water/improving-water-quality/fertilizers-pesticides-irrigation.stml',
        source_name: 'Charlotte County One Charlotte One Water — Fertilizer Ordinance',
        source_checked_at: '2026-05-28',
        notes: 'Jun 1 - Sept 30 restricted: N/P prohibited (Charlotte County ordinance, in effect since 2008 to protect Charlotte Harbor). Slow-release N >= 50% outside the season. Corrected 2026-05-28 - prior seed row incorrectly recorded no county-level blackout.',
      });
  }
};

exports.down = async function down() {
  // Data correction — intentionally NOT reverted (a down would restore false info).
};
