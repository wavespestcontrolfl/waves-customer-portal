#!/usr/bin/env node
/**
 * Regenerates the "Typed form facts" block of
 * docs/design/visit-facts-contract.md from server/config/visit-facts-contract.js.
 * The typed facts themselves are generated from project-types.js, so this
 * block is never edited by hand; server/tests/visit-facts-contract.test.js
 * fails while it is stale.
 *
 *   node server/scripts/generate-visit-facts-doc.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { VISIT_FACTS_CONTRACT } = require('../config/visit-facts-contract');

const DOC_PATH = path.join(__dirname, '..', '..', 'docs', 'design', 'visit-facts-contract.md');
const BLOCK_START = '<!-- BEGIN GENERATED: typed form facts (server/scripts/generate-visit-facts-doc.js) -->';
const BLOCK_END = '<!-- END GENERATED: typed form facts -->';

const cell = (text) => String(text).replace(/\|/g, '\\|');

/** Report sections that read a typed fact by name (the generic list aside). */
function namedReaders(fact) {
  const named = fact.readers
    .filter((r) => r.readerSymbol !== 'buildTypedReportSnapshot')
    .map((r) => `${r.section} (${path.basename(r.file)})`);
  return named.length ? named.join('; ') : '—';
}

function renderTypedFactsBlock() {
  const out = [BLOCK_START, ''];
  out.push('Generated from the registry, which generates these facts from each form\'s');
  out.push('`findingsFields` (`project-types.js`) and `REQUIRED_FINDINGS_FIELDS`');
  out.push('(`activity-indicators.js`). Do not edit this block by hand: run');
  out.push('`node server/scripts/generate-visit-facts-doc.js`. Every fact not marked');
  out.push('internal also renders in the generic typed findings list. `applicability`');
  out.push('`companion` means the field is `companionOnly` in project-types.js — legal');
  out.push('ONLY when the form runs as a COMPANION section beside a different primary');
  out.push('type (a primary submission carrying it is rejected as unknown); `both`');
  out.push('means the field is legal on a primary OR a companion submission.');
  for (const [line, def] of Object.entries(VISIT_FACTS_CONTRACT)) {
    if (!def.typedForm) continue;
    out.push('', `### \`${line}\` — typed \`${def.typedForm}\` form`, '');
    out.push('| fact | label | type | applicability | when missing | also read by name in |');
    out.push('|---|---|---|---|---|---|');
    for (const fact of def.facts) {
      if (fact.typedForm !== def.typedForm) continue;
      const internal = fact.readers.some((r) => r.readerSymbol === 'buildTypedReportSnapshot') ? '' : ' (internal)';
      const whenMissing = fact.companionWhenMissing !== undefined
        ? `${fact.whenMissing} (companion: ${fact.companionWhenMissing})`
        : fact.whenMissing;
      out.push(`| \`${fact.key}\` | ${cell(fact.label)}${internal} | ${fact.fieldType} | ${fact.applicability} | ${whenMissing} | ${cell(namedReaders(fact))} |`);
    }
  }
  out.push('', BLOCK_END);
  return out.join('\n');
}

function writeDoc() {
  const doc = fs.readFileSync(DOC_PATH, 'utf8');
  const start = doc.indexOf(BLOCK_START);
  const end = doc.indexOf(BLOCK_END);
  if (start < 0 || end < start) throw new Error(`generated block markers not found in ${DOC_PATH}`);
  fs.writeFileSync(DOC_PATH, doc.slice(0, start) + renderTypedFactsBlock() + doc.slice(end + BLOCK_END.length));
}

if (require.main === module) writeDoc();

module.exports = { renderTypedFactsBlock, BLOCK_START, BLOCK_END };
