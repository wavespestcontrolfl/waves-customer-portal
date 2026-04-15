/**
 * Seed the founder knowledge layer into knowledge_base.
 *
 * These are the strategic articles no compiler can extract — they live in
 * Waves' head and get referenced by the BI Briefing Agent and Retention Agent
 * when they need business reasoning (not just treatment facts).
 *
 * Articles are idempotent: existing paths are updated, not duplicated.
 */

const ARTICLES = [
  {
    path: 'wiki/business-strategy/waveguard-tier-logic.md',
    title: 'Why WaveGuard Tiers Are Structured This Way',
    summary: 'The WaveGuard Bronze/Silver/Gold/Platinum ladder is a Hormozi-style Grand Slam Offer structure — the middle tier is priced to look like the obvious choice, the top tier anchors value, the bottom tier exists to be rejected.',
    category: 'business-strategy',
    tags: ['pricing', 'waveguard', 'memberships', 'strategy'],
    content: `# Why WaveGuard Tiers Are Structured This Way

## Summary
The WaveGuard Bronze/Silver/Gold/Platinum ladder is a Hormozi-style Grand Slam Offer. The middle tiers (Silver, Gold) are the real product — Bronze is the decoy that makes Silver look like a no-brainer, and Platinum is the anchor that makes Gold feel like the smart middle choice.

## The Four Tiers

- **Bronze** — Single-service recurring (pest only OR lawn only). Lowest discount on add-ons. Exists primarily as an entry point and to make Silver look better.
- **Silver** — Two-service bundle (pest + one lawn component, or lawn + mosquito). Meaningful discount on add-ons. This is the workhorse tier.
- **Gold** — Three-service bundle with deeper add-on discount and priority scheduling. This is where margin compounds: one truck, one stop, three services billed.
- **Platinum** — Everything-included with the largest add-on discount, termite warranty, and annual inspection. Priced to be aspirational; sold as "the whole house handled."

## Why the Ladder Works

1. **Anchoring.** Platinum's price anchors the value perception for Gold.
2. **Decoy effect.** Bronze is deliberately less attractive per-dollar than Silver — the gap nudges customers up.
3. **Compound route economics.** Every tier above Bronze puts multiple services on the same truck roll. Loaded labor stays flat while billable minutes go up. This is where the real margin lives, not in the monthly membership discount itself.
4. **Customer-lifetime-value lever.** Moving a Bronze customer to Silver is worth more than acquiring a new Bronze customer — the CAC is already paid.

## What This Means for Operations

- Never pitch Bronze as "the best deal." Pitch Silver as "what most customers choose" and let Bronze be the fallback.
- When a customer adds a second service, proactively offer to roll both into Silver/Gold. The upsell path is baked into the tier structure.
- The add-on discount % is the hook. The real profit is the route density from stacking services at one address.

## Related
- [[wiki/business-strategy/route-density-economics.md|Route density and why it drives profit]]
- [[wiki/business-strategy/stripe-discount-model.md|Why discounts run through Stripe, not Square]]

## Sources
- Founder notes, April 2026
`,
  },
  {
    path: 'wiki/business-strategy/stripe-discount-model.md',
    title: 'Why We Moved From Square to Stripe (and the Discount Model)',
    summary: 'Square was a payment terminal; Stripe is a programmable revenue layer. The move unlocked WaveGuard member discounts, ACH for larger invoices, and programmatic refunds. All customer and billing state now lives in PostgreSQL — Stripe is the processor, not the system of record.',
    category: 'business-strategy',
    tags: ['stripe', 'payments', 'pricing', 'strategy'],
    content: `# Why We Moved From Square to Stripe

## Summary
Square was fine as a payment terminal but couldn't support the business model we were building. Stripe is a programmable revenue layer: Payment Element, ACH, programmatic refunds, webhook-driven automation, and — critically — discount codes that can be wired to WaveGuard membership logic sitting in our own database.

## What Square Could Not Do

- Membership-aware discounts (we'd have had to hand-key them)
- ACH at reasonable fees for larger invoices (tree & shrub, termite)
- Programmatic refunds and partial refunds on tech corrections
- Webhook-driven state sync with our portal (appointments, invoices, receipts)
- Apple Pay / Google Pay / card-on-file in one UI element

## What The Move Unlocked

1. **Discount model lives in our code.** WaveGuard discount % is computed from the customer's tier in PostgreSQL. Stripe is told the final amount. This means we can change the discount logic without touching the processor.
2. **Single source of truth is PostgreSQL.** No Stripe customer records are used for business logic — customers exist in our DB, Stripe just has payment methods attached.
3. **ACH opens bigger invoices.** Termite warranties, tree injections, and commercial accounts now go through ACH — card fees on a $2,400 termite job would have been punishing.
4. **Automation compounds.** Webhook → invoice state → SMS follow-up → dashboard KPI — none of that existed on Square.

## Hard Rules Going Forward

- **Never reference Square in new code.** It is fully phased out.
- **Stripe is the payment processor only.** All business state (customer tier, service history, discount eligibility, loyalty credits) lives in our DB.
- **All automation is native.** No Zapier, no Make, no third-party glue. If the portal needs to do something when a payment succeeds, write it in the Stripe webhook handler.

## Related
- [[wiki/business-strategy/waveguard-tier-logic.md|WaveGuard tier structure]]

## Sources
- Founder notes, April 2026
`,
  },
  {
    path: 'wiki/business-strategy/route-density-economics.md',
    title: 'Route Density: Why It Drives Profitability',
    summary: 'Pest control profit is a function of minutes-billed-per-drive-minute. The loaded labor rate ($35/hr) is fixed; the only lever is how many billable minutes you stack into a single route. Zone density — customers clustered in the same neighborhood — is the single biggest profit multiplier in the business.',
    category: 'business-strategy',
    tags: ['routing', 'scheduling', 'profit', 'operations', 'strategy'],
    content: `# Route Density: Why It Drives Profitability

## Summary
In pest/lawn, profit per day = (billable minutes on site) ÷ (total paid minutes including drive). Loaded labor is fixed at $35/hr. The number that moves is the denominator — drive time, turnaround, idle. Zone density (multiple stops in the same neighborhood) is the biggest single lever.

## The Math

- Tech paid 8 hours = 480 minutes loaded labor.
- If billable minutes on property = 240, effective utilization = 50%.
- Each additional stop within 5 minutes of another stop adds ~25 billable minutes for only ~5 minutes of drive. That's a 5x ratio on that marginal stop.
- Conversely, a one-off stop 20 minutes from the nearest other job costs 40 minutes of drive for maybe 30 billable minutes. Ratio collapses below 1.

## Where This Shows Up

1. **Acquisition priority.** A new customer in an existing zone is worth materially more than the same customer 15 miles away. Estimator CRM should flag and prioritize dense-zone leads.
2. **Schedule optimization.** The Intelligence Bar's zone density / gap analysis tools exist specifically to surface under-used density.
3. **Service bundling.** Two services at one address = double billable on the same drive. This is why WaveGuard multi-service tiers are more profitable than the discount suggests.
4. **WordPress spoke sites.** The 15-domain hub-and-spoke SEO network is designed to dominate specific cities — not to cast a wide net, but to stack more customers in the zones we already serve.

## Operational Rules

- Never let a tech drive >15 min between stops if it's avoidable. Prefer reshuffling the route to respecting the original order.
- A dense route with mediocre per-stop margin beats a sparse route with premium per-stop margin. Every time.
- When pitching memberships, weight the upsell toward existing-zone customers first. CAC is lower, margin is higher.

## Related
- [[wiki/business-strategy/waveguard-tier-logic.md|WaveGuard tier structure]]
- [[wiki/business-strategy/neighborhood-conversion.md|Which neighborhoods convert]]

## Sources
- Founder notes, April 2026
`,
  },
  {
    path: 'wiki/business-strategy/neighborhood-conversion.md',
    title: 'Which Neighborhoods Convert Best and Why',
    summary: 'Not all SWFL neighborhoods convert at the same rate. Gated communities in Lakewood Ranch, Palmer Ranch, and The Meadows convert at 2–3x the rate of open developments in North Port or Port Charlotte — but ticket sizes vary. The takeaway: prioritize HOA-adjacent, owner-occupied zones with mature landscaping.',
    category: 'business-strategy',
    tags: ['marketing', 'conversion', 'demographics', 'strategy', 'gbp'],
    content: `# Which Neighborhoods Convert Best and Why

## Summary
Conversion rate on leads varies wildly by neighborhood. The pattern: gated / HOA / owner-occupied / mature landscaping wins. Open developments with transient renters convert poorly regardless of how cheap the offer is.

## Observed Conversion Tiers (high → low)

**Tier A — Highest conversion, highest LTV**
- Lakewood Ranch gated villages
- Palmer Ranch
- The Meadows
- Siesta Key (limited inventory, very high ticket)
- University Park

**Tier B — Strong conversion, good ticket**
- West Bradenton (established single-family)
- Bradenton Beach, Holmes Beach (seasonal owners)
- Glen Oaks Estates
- Parrish newer communities (Crosscreek, Silverleaf)

**Tier C — Medium conversion, average ticket**
- Venice Gardens, South Venice
- Sarasota Springs
- North Port (new construction pockets only)

**Tier D — Low conversion, avoid paid acquisition**
- North Port open lots (high lot vacancy)
- Warm Mineral Springs (renters dominant)
- Port Charlotte open developments
- Bayshore Gardens apartment-heavy

## Why The Pattern Holds

1. **Owner-occupancy drives perceived value.** Owners pay for ongoing service; renters won't.
2. **HOAs set a landscaping floor.** Lawns have to look good, which means recurring lawn/tree service has social pressure behind it.
3. **Mature landscaping = more pest pressure.** Older oak canopies, denser ornamentals, and established turf all mean higher service volume per property.
4. **Word-of-mouth density.** In gated communities, one happy customer generates 3–5 referrals. In open developments, almost none.

## How To Use This

- **Google Ads geo-targeting** should weight Tier A/B zip codes heavily. Do not spend evenly across service area.
- **Blog + SEO spoke sites** should prioritize Tier A/B cities in page creation order. See the WordPress fleet spec.
- **Referral incentives** pay back fastest in Tier A zones. This is where to push the WaveGuard referral bonus hardest.
- **Estimator follow-up cadence** can be lighter in Tier A (they convert fast or not at all) and heavier in Tier C (they need multiple touches).

## Related
- [[wiki/business-strategy/route-density-economics.md|Route density economics]]
- [[wiki/business-strategy/seo-hub-and-spoke.md|15-site hub-and-spoke SEO strategy]]

## Sources
- Founder observations, April 2026
- Cross-referenced with estimator conversion data
`,
  },
  {
    path: 'wiki/business-strategy/seasonal-callback-patterns.md',
    title: 'Seasonal Callback Patterns (Field Observations)',
    summary: 'Adam\'s observed callback patterns follow predictable SWFL seasonal curves. Callbacks are not random — they cluster around rainy-season ant flushes, post-blackout turf stress, and fall rodent-entry season. Scheduling and stocking should anticipate these waves.',
    category: 'business-strategy',
    tags: ['seasonality', 'callbacks', 'operations', 'field-intel'],
    content: `# Seasonal Callback Patterns (Field Observations)

## Summary
Callbacks in SWFL are not random. Adam (lead tech) has observed repeating patterns that follow the climate and the state fertilizer-blackout calendar. Scheduling, stocking, and SMS-campaign timing should anticipate these waves rather than react to them.

## The Annual Callback Curve

**January–February (dry, cool)**
- Rodent callbacks peak. Cool nights drive rats into attics and garages.
- Ant callbacks are lowest all year.
- Turf complaints: dormant St. Augustine looks "dead" — a lot of anxious-customer calls that are actually education opportunities, not real callbacks.

**March–April (warm, dry)**
- Ant activity (especially ghost ants and white-footed ants) starts ramping.
- Weed pressure explodes — pre-emergent window is closing.
- Termite swarms begin. Subterranean swarms peak in the first warm rain.

**May–June (rain starts, fertilizer blackout begins June 1)**
- Peak callback season. Ant flushes follow rain. Mosquito load surges.
- Lawn callbacks spike because fertilizer blackout (June 1 – Sep 30) hits right when turf stress appears.
- Tree & shrub: scale and sooty mold become visible on gardenias, hibiscus, viburnum.

**July–August (wettest months)**
- Mosquito is the dominant call.
- Roach callbacks (especially palmetto bugs / smokey browns) climb as harborage gets damp.
- Fungal turf disease (large patch, take-all root rot) peaks — and we can't fertilize to help recover.

**September (late blackout, hurricane watch)**
- Post-storm callbacks: displaced rodents, wet-wood termites in damaged wood, ant colonies flushed by flooding.
- First fall window for pre-emergent application as blackout lifts Oct 1.

**October–November (cooling, blackout over)**
- Heavy fertilizer + pre-emergent window.
- Callbacks drop sharply.
- Rodent season begins to ramp again.

**December (holiday bookings, cool snaps)**
- Callbacks low. Good time for retention touches, annual inspections, and sales push on termite warranties.

## Operational Use

- **Product stocking.** Pre-order bifenthrin and non-repellent residuals before May. Pre-order pre-emergents for October. Never stock-out on the ramp.
- **Tech scheduling.** Don't approve peak-season PTO in May–August without overlap coverage.
- **SMS campaigns.** Ant prevention push in April, mosquito in May, rodent in October. Fire them two weeks before the observed wave, not during.
- **Callback policy.** Higher callback counts in June–August are expected and not a quality signal unless they exceed the seasonal baseline.

## Related
- [[wiki/compliance/fertilizer-blackout-swfl.md|Fertilizer blackout compliance]]
- [[wiki/business-strategy/route-density-economics.md|Route density]]

## Sources
- Adam (lead tech) field observations, multi-season
- Sarasota + Manatee county fertilizer ordinances
`,
  },
  {
    path: 'wiki/business-strategy/seo-hub-and-spoke.md',
    title: '15-Site Hub-and-Spoke SEO Strategy (and Why)',
    summary: 'The 15-domain fleet is not a spam farm — it\'s a topic-and-city authority play. Each spoke targets one vertical (pest / lawn / exterminator) in one SWFL city, links back to the hub, and captures long-tail local queries that the hub alone can\'t rank for without over-pruning its homepage.',
    category: 'business-strategy',
    tags: ['seo', 'wordpress', 'fleet', 'marketing', 'strategy'],
    content: `# 15-Site Hub-and-Spoke SEO Strategy

## Summary
The WordPress fleet (15 sites) is a deliberate SEO architecture: wavespestcontrol.com is the hub; 14 spoke domains each target one vertical (pest, exterminator, lawn) in one SWFL city (Bradenton, Sarasota, Venice, Lakewood Ranch, etc.). Spokes carry city-specific content the hub can't hold without diluting its homepage, and they pass internal-link equity back to the hub.

## Why Hub-and-Spoke Instead of One Big Site

1. **Local intent dominates.** "pest control bradenton fl" and "exterminator bradenton fl" are different queries with different intent. Google rewards pages that match the intent exactly — not sprawling category pages that try to serve both.
2. **Domain name match still signals.** bradentonflpestcontrol.com ranks for city+vertical queries the hub can't easily compete for from its homepage.
3. **Content scale.** 15 sites × ~10 pages each = 150+ city-specific pages, each narrowly targeted. One hub site couldn't carry that without becoming unnavigable.
4. **Defensibility.** Competitors can outbid us on PPC. They can't easily replicate 15 aged domains with ongoing original content.

## How The Spokes Work

- Each spoke has: homepage, 5–8 city+service pages, 3–5 local-angle blog posts, review page, contact page.
- Spokes link to the hub in navigation, footer, and contextual anchors (WaveGuard memberships, about-us, service guarantee).
- Hub does **not** link back heavily (that would concentrate authority the wrong direction); hub links to spokes only where a user genuinely needs city-specific info.
- Blog content engine writes city-tagged posts that can be published to the matching spoke (or the hub, for broad topics).

## What NOT To Do With The Fleet

- **Never cross-link all 15 spokes to each other.** That's a link wheel and Google penalizes it.
- **Never duplicate content across spokes.** Each page must be meaningfully city-specific.
- **Never run AI-generated content without SWFL-specific grounding** (nitrogen blackout, chinch bugs, sandy soil, seasonal timing).

## Measurement

- GSC data is pulled from all 15 sites and aggregated in the SEO Intelligence Bar.
- Rank tracking via DataForSEO on target keyword × city combinations.
- The compounding signal: hub authority rises as spokes age, which helps the hub rank for broader queries.

## Related
- [[wiki/business-strategy/neighborhood-conversion.md|Which neighborhoods convert]]
- [[wiki/operations/blog-content-engine.md|Blog content engine]]

## Sources
- Founder SEO strategy notes
- WordPress fleet specs (server/data/wordpress-specs/)
`,
  },
];

exports.up = async function (knex) {
  for (const a of ARTICLES) {
    const wordCount = a.content.split(/\s+/).filter(Boolean).length;
    const existing = await knex('knowledge_base').where('path', a.path).first();
    if (existing) {
      await knex('knowledge_base').where('id', existing.id).update({
        title: a.title,
        category: a.category,
        summary: a.summary,
        content: a.content,
        tags: JSON.stringify(a.tags),
        word_count: wordCount,
        last_compiled: new Date(),
        version: (existing.version || 1) + 1,
        active: true,
        updated_at: new Date(),
      });
    } else {
      await knex('knowledge_base').insert({
        path: a.path,
        title: a.title,
        category: a.category,
        summary: a.summary,
        content: a.content,
        tags: JSON.stringify(a.tags),
        backlinks: JSON.stringify([]),
        source_documents: JSON.stringify(['founder-notes:2026-04']),
        word_count: wordCount,
        last_compiled: new Date(),
        version: 1,
        active: true,
      });
    }
  }
};

exports.down = async function (knex) {
  for (const a of ARTICLES) {
    await knex('knowledge_base').where('path', a.path).del();
  }
};
