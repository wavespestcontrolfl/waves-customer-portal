/**
 * Call-research corpus taxonomy (voice-of-customer lane).
 *
 * Fixed controlled vocabulary shared by the miner's extraction schema and
 * the Intelligence Bar search tool. Nuance belongs in the free-text
 * `topics` array, NEVER in new tags — renaming or adding a tag after the
 * backfill means a full re-mine (bump RESEARCH_PROMPT_VERSION), so treat
 * this list as stable.
 */

const RESEARCH_TAGS = [
  'need', // the problem in the customer's own words
  'objection', // price/contract/competitor pushback
  'capability_question', // "do you treat X?" — service-gap + content-gap signal
  'confusion', // prep, billing, arrival windows — each one a UX/copy defect
  'churn_signal',
  'praise',
  'complaint',
  'competitor_mention',
];

// Row-shape version stamped on every chunk. The PROMPT version (which
// drives re-mines) lives in prompts/call-research-v1.js as a content hash.
const RESEARCH_SCHEMA_VERSION = 'call-research.v1';

module.exports = { RESEARCH_TAGS, RESEARCH_SCHEMA_VERSION };
