/**
 * Data fix — correct the bermudagrass-in-St.-Augustine protocol facts in the
 * LIVE tables that carry them (knowledge_base + its knowledge_embeddings
 * chunks, opportunity_queue, products_catalog), on deploy:
 *   1) knowledge_base — the "Fusilade II — Bermuda & Bahia Eradication" article
 *      taught Fusilade ALONE at 1 oz/gal per 1,000 sq ft (4-8x the labeled turf
 *      rate, on a use the standalone label does not allow over St. Augustine),
 *      a 14-21 day interval, and up to 3 applications. The Intelligence Bar and
 *      tech answers read this table — the article is the documented St.
 *      Augustine injury failure mode. Replaced wholesale with the Recognition +
 *      Fusilade II tank-mix protocol (matches the published blog protocol at
 *      /lawn-care/remove-bermudagrass-from-st-augustine/, fact-checked
 *      2026-08-05). The Celsius article's alternatives list pointed at the same
 *      solo-Fusilade use — corrected by targeted line replacement so any other
 *      admin edits to that article survive.
 *   2) opportunity_queue — category seed L18 (catseed:v1:L18, window
 *      2026-10-15) embeds its brief in signal_metadata.category_brief at seed
 *      time, and the seeded thesis asserts bermuda "can't be selectively
 *      sprayed out" — which would publish a post contradicting the live
 *      protocol article. Pending rows get the corrected brief (matches the
 *      updated server/data/category-seed-topics-v1.json); claimed/done rows
 *      are left alone.
 *   3) products_catalog — the Recognition row's active_ingredient read
 *      "Trifloxysulfuron-sodium + Mesotrione"; Recognition contains no
 *      mesotrione (it is trifloxysulfuron-sodium 20.4% + the safener
 *      metcamifen — the safener is the entire basis of the tank-mix program).
 *
 * Context: deploys run knex migrations, not scripts/seed-knowledge-base.js —
 * the seed's forceUpdate flag only corrects rows on a MANUAL re-run (same
 * situation as 20260528000031_fix_kb_blackout_charlotte_northport.js, the
 * exemplar for this migration). Seeds are corrected in the same PR so fresh
 * environments come up right; this migration fixes environments already
 * seeded. All updates are update-only and idempotent.
 */

const KB_SLUG = 'fusilade-ii-bermuda-bahia-eradication';
const KB_ENTRY = {
  title: 'Recognition + Fusilade II — Bermudagrass Suppression in St. Augustine',
  tags: ['fusilade', 'recognition', 'bermuda', 'st-augustine', 'tank-mix', '2ee'],
  content: `# Recognition + Fusilade II — Bermudagrass Suppression in St. Augustine (TANK MIX ONLY)

## ⛔ Never Fusilade alone
An earlier version of this article described Fusilade II by itself at 1 oz per gallon per 1,000 sq ft. That is 4-8x the labeled turf rate, and St. Augustine is NOT a labeled turf for over-the-top Fusilade at all — solo application injures the lawn. The ONLY sanctioned use is the tank mix below, under the Florida FIFRA 2(ee) recommendation (dated 2023-05-11).

## How it works
- Fusilade II (fluazifop-P-butyl, Group 1 ACCase inhibitor) is what kills the bermudagrass.
- Recognition (trifloxysulfuron-sodium 20.4% + the safener metcamifen) is what lets St. Augustine tolerate it. The safener changes plant metabolism — it does not neutralize or shield anything.
- Monument or any plain trifloxysulfuron product is NOT a substitute for Recognition — no safener, no program.
- Resistance note: Recognition's Group 2 active does not control bermudagrass, so for bermuda this is a SINGLE mode-of-action program.

## Rates (per application)
- Recognition: 1.95 oz/acre = 0.045 oz per 1,000 sq ft (the FL 2(ee) allows down to 1.29 oz/acre)
- Fusilade II: 24 fl oz/acre for bermudagrass (0.55 fl oz per 1,000 sq ft) — Syngenta recommends the full rate for bermuda; label range is 12-24
- Non-ionic surfactant (>=80% active): 0.25-0.5% of spray volume
- Mix order: water -> agitation -> Recognition fully dispersed -> Fusilade -> surfactant LAST. No MSO/COC, no acidifiers, no organophosphate insecticides/nematicides in the tank. Buffer toward pH 7 if carrier water is below 5.5.

## Application limits — HARD CEILING: 2 per growing season
- Recognition label alone: min 28 days between applications, max 1.95 oz/acre per application, 6.26 oz/acre/yr.
- The 2026 Fusilade II master label (EPA-accepted 2026-07-15) resistance clause caps this MOA at 2 applications per season, and there is no overlapping-MOA exception for bermuda (see above). A 3rd application waits for the NEXT spring.
- Fusilade annual cap: 1.125 lb fluazifop-P-butyl per acre per year.

## Timing and follow-up
- Spring only (UF/IFAS). Avoid late summer/fall applications.
- Symptoms in 7-14 days; control at 10-21 days; rhizome regrowth appears weeks 4-6.
- Application 2 lands in weeks 5-6, triggered by OBSERVED regrowth — not the calendar.

## Eligibility gates (check BEFORE quoting)
- Cultivars: Floratam / Palmetto / Raleigh / SunClipse -> proceed. CitraBlue -> test area first. Seville -> do NOT treat. ProVista and Captiva -> EXCLUDED (the 2(ee) prohibits Captiva). Unknown cultivar -> test area watched 3-4 weeks. Wait 4 weeks after new sod/sprigs/seed.
- Do NOT treat stressed turf (drought stress, saturated soil, chinch damage, active disease, nematodes, recent scalping) — the safener relies on healthy plant metabolism.
- Mostly-bermuda lawns: do not treat — recommend renovation/re-sod instead.
- Torpedograss: SUPPRESSION only. Never sell this program as torpedograss removal.

## Field rules
- No mowing 7 days before OR after application.
- 3-hour dry minimum (Recognition rainfast 3 hr, Fusilade 1 hr); avoid rain/irrigation within 48 hr.
- 12-month replant interval before planting anything but turfgrass in a treated area.
- Sprayer cleanout: 2.5 oz household ammonia per gallon, recirculate 15+ min, repeat, rinse.

## Critical warnings
- The mix kills bermudagrass AND zoysiagrass — confirm the lawn is St. Augustine first.
- Bahiagrass is NOT in the 2026 Fusilade II weed table — do not sell or apply this program for bahia.
- Single-MOA for bermuda: never exceed the 2-application season ceiling — that is how resistant bermudagrass gets selected.

Source of truth: the published blog protocol /lawn-care/remove-bermudagrass-from-st-augustine/ (fact-checked 2026-08-05), the Syngenta Recognition and Fusilade II labels, and the Florida 2(ee).`,
};

const CELSIUS_SLUG = 'celsius-wg-application-limits';
const CELSIUS_OLD_LINE = '- Fusilade II — specifically for Bermuda/Bahia eradication in St. Augustine';
const CELSIUS_NEW_LINE = '- Recognition + Fusilade II tank mix — bermudagrass suppression in St. Augustine (bermudagrass ONLY — bahiagrass is not in the 2026 Fusilade II weed table; NEVER Fusilade alone over St. Augustine; see the Recognition + Fusilade II article)';

// Canonical corrected L18 brief — matches server/data/category-seed-topics-v1.json.
// Fresh environments never hit this branch (the seeder only runs on explicit
// operator invocation), so the embedded copy only serves already-seeded rows.
const L18_DEDUPE_KEY = 'catseed:v1:L18';
const L18_BRIEF = {
  id: 'L18',
  action: 'new_supporting_blog',
  slug: '/lawn-care/bermudagrass-invading-st-augustine-palmetto-fl/',
  city: 'Palmetto',
  working_title: 'That Fine, Wiry Grass Creeping Into Your Palmetto Lawn Is Bermuda — and It Plays Dirty',
  primary_kw: 'bermuda grass in st augustine lawn',
  secondary_kws: ['get rid of bermuda grass', 'wiry grass taking over lawn'],
  intent: 'informational',
  window: '2026-10-15',
  byline: 'adam-augusta',
  cta: ['QUOTE'],
  schema_types: ['Article'],
  thesis: "Common bermudagrass invades St. Augustine through runners and seed and thrives on the same conditions. Competition — mowing height, density, clean edging — is still the foundation of managing it, but there IS now a labeled selective option: the professional Recognition + Fusilade II tank mix under Florida's 2(ee) recommendation, a strict 2-application spring program with cultivar limits.",
  outline: [
    'ID: fine texture, gray-green color, aggressive runners visibly crossing sidewalks and beds',
    'How it gets in: seed, contaminated fill, mower transfer, thin turf',
    'The competition strategy: mowing height and density management that favors St. Augustine',
    "The selective option: the Recognition + Fusilade II tank mix under Florida's 2(ee) — capped at 2 applications per growing season (spring), cultivar restrictions, why it's a professional program (link the full protocol post)",
    'Spot-treatment realities and the resod decision for heavy takeover',
    'Keeping it out of beds and preventing reintroduction',
  ],
  sources: [
    'https://edis.ifas.ufl.edu/',
    'Pull current UF/IFAS guidance on bermudagrass control in St. Augustinegrass; cross-check every selective-option claim against /lawn-care/remove-bermudagrass-from-st-augustine/ (the canonical Waves protocol post, fact-checked 2026-08-05) and the Syngenta Recognition / Fusilade II labels plus the Florida 2(ee); snapshot at draft.',
  ],
  internal_links: [
    '/lawn-care/types-of-grass-sarasota-fl/',
    '/lawn-care/remove-bermudagrass-from-st-augustine/',
  ],
  verify_notes: [
    'Verify /lawn-care/types-of-grass-sarasota-fl/ resolves on the live sitemap before including it.',
    'Verify /lawn-care/remove-bermudagrass-from-st-augustine/ resolves on the live sitemap before including it.',
    "Do NOT restate the retired 'can't be selectively sprayed out' claim — it was superseded by the 2(ee) tank-mix protocol post published 2026-08-05.",
  ],
};

const PRODUCT_NAME = 'Recognition Post Emergent Herbicide';
const PRODUCT_AI_CORRECT = 'Trifloxysulfuron-sodium 20.4% + metcamifen (safener)';

exports.up = async function up(knex) {
  // 1) knowledge_base — wholesale replace of the wrong article (every section
  //    of the original was the wrong protocol), targeted line fix for Celsius.
  if (await knex.schema.hasTable('knowledge_base')) {
    const article = await knex('knowledge_base').where({ slug: KB_SLUG }).first();
    if (article) {
      await knex('knowledge_base').where({ slug: KB_SLUG }).update({
        title: KB_ENTRY.title,
        tags: JSON.stringify(KB_ENTRY.tags),
        content: KB_ENTRY.content,
        confidence: 'high',
        last_verified_at: new Date(),
        verified_by: 'migration-bermuda-tank-mix-protocol',
      });
    }

    const celsius = await knex('knowledge_base').where({ slug: CELSIUS_SLUG }).first();
    if (celsius && typeof celsius.content === 'string' && celsius.content.includes(CELSIUS_OLD_LINE)) {
      await knex('knowledge_base').where({ slug: CELSIUS_SLUG }).update({
        content: celsius.content.replace(CELSIUS_OLD_LINE, CELSIUS_NEW_LINE),
        last_verified_at: new Date(),
        verified_by: 'migration-bermuda-tank-mix-protocol',
      });
    }
  }

  // 1b) knowledge_embeddings — /api/mcp serves raw chunk snippets from this
  //     table (server/routes/mcp.js), NOT from knowledge_base, and the index
  //     rebuild runs only nightly AND only when the independent hybridKnowledge
  //     gate is enabled (scheduler.js) — so without this purge an environment
  //     with MCP enabled but hybrid search disabled could serve the old
  //     solo-Fusilade overdose chunks indefinitely. Delete the two corrected
  //     articles' chunks (source='kb', source_id=slug per
  //     services/knowledge-index/connectors.js); until the next index sync the
  //     articles are simply absent from chunk search — the safe state.
  if (await knex.schema.hasTable('knowledge_embeddings')) {
    await knex('knowledge_embeddings')
      .where({ source: 'kb' })
      .whereIn('source_id', [KB_SLUG, CELSIUS_SLUG])
      .del();
  }

  // 2) opportunity_queue — refresh the embedded L18 brief on rows the engine
  //    has not picked up yet. Claimed/done/pending_review rows are left alone
  //    (rewriting a brief mid-compose or after publish would be wrong); the
  //    L18 window is 2026-10-15, so the pending row is the expected state.
  if (await knex.schema.hasTable('opportunity_queue')) {
    const row = await knex('opportunity_queue')
      .where({ dedupe_key: L18_DEDUPE_KEY, status: 'pending' })
      .first();
    if (row) {
      const meta = (row.signal_metadata && typeof row.signal_metadata === 'object')
        ? row.signal_metadata
        : {};
      meta.category_brief = L18_BRIEF;
      await knex('opportunity_queue')
        .where({ id: row.id, status: 'pending' })
        .update({ signal_metadata: JSON.stringify(meta) });
    }
  }

  // 3) products_catalog — correct the active ingredient only if it still
  //    carries the wrong mesotrione string (an admin who already fixed or
  //    otherwise edited it is left alone).
  if (await knex.schema.hasTable('products_catalog')) {
    await knex('products_catalog')
      .whereILike('name', PRODUCT_NAME)
      .whereILike('active_ingredient', '%mesotrione%')
      .update({ active_ingredient: PRODUCT_AI_CORRECT });
  }
};

exports.down = async function down() {
  // Data correction — intentionally NOT reverted (a down would restore the
  // 4-8x overdose rate and the solo-Fusilade injury protocol).
};
