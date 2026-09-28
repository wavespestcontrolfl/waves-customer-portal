'use strict';

// Shared by new-post and refresh agents because both quality bundles emit
// the same optional citability signals. A single prompt contract keeps a
// retry code from meaning something different in the two lanes.
const CITABILITY_AGENT_GUIDANCE = `CITABILITY (blog posts only: a new supporting-blog brief, or a refresh
whose target is a blog post, i.e. its source lives under src/content/blog/.
For city-service pages, customer-question pages, and any other refresh
target, skip this whole section and keep that page's own structure; never
add a <ComparisonTable> or a How-to-choose H2 there on its account) — write
so a search engine or AI answer engine can lift the answer cleanly (nudge codes in [brackets] are weight-0 quality-gate signals:
they never block or authorize unsupported claims). Every rule below sits
INSIDE the evidence, product, price, and comparison rules — none licenses an
invented number, product, competitor, or source:
- [CITABILITY_NAMED_SOURCES] Attribute technical facts in prose to the
  SPECIFIC named authority the evidence came from — "per UF/IFAS", "the FDACS
  label rule", "the EPA product label", "Sarasota County Mosquito
  Management", "the CDC" — not "experts say" or "studies show". Never invent an
  agency, publication, program, or business to satisfy this.
- [CITABILITY_CONCRETE_SPECIFICS] When the facts pack, knowledge-base result,
  or an allowed source supplies a number, state it with its unit — "3.5–4
  inches", "June 1 – Sept 30", "10–14 days", "1/2 inch of water per week" —
  instead of a vague qualifier. This is not a quota and never a dollar amount.
- [CITABILITY_COMPARISON] When the reader faces two or more real paths, render ONE <ComparisonTable> with the decision
  criteria as rows. CATEGORY mode is the default; a brief that specifically needs named businesses keeps NAMED-COMPETITOR mode. Do NOT bolt a generic "DIY vs pro" table onto a post
  whose reader faces no choice. On a refresh whose target file_path (from
  get_existing_page) ends in .md — a legacy Markdown post — skip this rule
  entirely and never add a <ComparisonTable>: publishing rejects any MDX
  component in a .md file.
- [CITABILITY_HOW_TO_CHOOSE] Whenever the post carries a <ComparisonTable>
  (and always on decision/comparison/cost posts), add an H2 that reads
  "How to choose …"
  with 3–5 bulleted criteria, each an observable check followed by the option
  it points to. No winner or ranking; the reader assesses fit.
- Structure for extraction: open every H2 section with a one- or two-sentence
  direct answer; use numbered lists for sequences and bullets for parallel
  signs, criteria, or options.`;

module.exports = { CITABILITY_AGENT_GUIDANCE };
