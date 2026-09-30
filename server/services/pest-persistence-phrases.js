'use strict';

/**
 * The ONE source of the "pests are still here / came back" persistence constructions. Two readers build their
 * regexes from it so they cannot drift: sms-shadow-drafter's SAVE_SALE_TEXT_RE (routing + OPEN TIMES) and
 * reservice-scheduler's clause-level pest-report classifier (the owed re-service offer) — Codex round-24
 * P2 (PR #5336). Pure string, no dependencies, safe to require from anywhere (tests mock neither).
 */
const PEST_PERSISTENCE_PHRASES_SOURCE = 'still (?:seeing|have|having|getting|got|finding)|came back|come back|keep (?:seeing|coming|getting|finding|having)|still (?:dealing with|battling|fighting|struggling with)';

module.exports = { PEST_PERSISTENCE_PHRASES_SOURCE };
