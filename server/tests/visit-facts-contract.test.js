/**
 * Visit facts contract — static guard for server/config/visit-facts-contract.js
 * (owner rulings 2026-09-28; doc: docs/design/visit-facts-contract.md).
 *
 * The registry pins, per service line, which facts a completed visit records,
 * where they are stored, who writes them and which report section reads them.
 * This suite fails when that map drifts from the code: a renamed storage key,
 * a moved reader, a gap that silently closed (or opened) without the doc
 * saying so. Plain file reads and string searches — no DB, no module loading
 * beyond the registry itself.
 */
const fs = require('fs');
const path = require('path');
const {
  VISIT_FACTS_CONTRACT,
  EXCLUDED_SERVICE_LINES,
  RETIRED_CATALOG_KEYS,
} = require('../config/visit-facts-contract');

const REPO_ROOT = path.join(__dirname, '..', '..');
const DOC_PATH = path.join(REPO_ROOT, 'docs', 'design', 'visit-facts-contract.md');
const CAPTURES = new Set(['tap', 'voice', 'prefill', 'derived', 'photo']);
const WHEN_MISSING = new Set(['hidden', 'fallback', 'filler', 'required']);

const fileCache = new Map();
function readRepoFile(rel) {
  if (!fileCache.has(rel)) {
    const abs = path.join(REPO_ROOT, rel);
    fileCache.set(rel, fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null);
  }
  return fileCache.get(rel);
}

/** The last dotted segment of a storage path, without a `[]` suffix. */
function storageKey(storage) {
  return storage.split('.').pop().replace(/\[\]$/, '');
}

/** A writer entry is a path (names the storage key) or { file, writerSymbol }. */
function writerFile(writer) {
  return typeof writer === 'string' ? writer : writer && writer.file;
}

const allFacts = Object.entries(VISIT_FACTS_CONTRACT).flatMap(([line, def]) => (
  def.facts.map((fact) => ({ line, voiceFill: def.voiceFill, fact }))
));
const label = ({ line, fact }) => `${line}.${fact.key}`;

describe('visit facts contract registry', () => {
  test('lines and facts have a valid shape, keys unique per line', () => {
    const problems = [];
    for (const [line, def] of Object.entries(VISIT_FACTS_CONTRACT)) {
      if (EXCLUDED_SERVICE_LINES[line]) problems.push(`${line}: excluded line listed in the registry`);
      if (typeof def.label !== 'string' || !def.label) problems.push(`${line}: label`);
      if (!Array.isArray(def.catalogKeys)) problems.push(`${line}: catalogKeys`);
      if (typeof def.voiceFill !== 'boolean') problems.push(`${line}: voiceFill`);
      if (!Array.isArray(def.facts) || !def.facts.length) problems.push(`${line}: facts`);
      const seen = new Set();
      for (const fact of def.facts || []) {
        const id = `${line}.${fact.key}`;
        if (!/^[a-z][a-z0-9_]*$/.test(fact.key || '')) problems.push(`${id}: key`);
        if (seen.has(fact.key)) problems.push(`${id}: duplicate key`);
        seen.add(fact.key);
        if (typeof fact.label !== 'string' || !fact.label) problems.push(`${id}: label`);
        if (!Array.isArray(fact.capture) || !fact.capture.length
          || fact.capture.some((c) => !CAPTURES.has(c))) problems.push(`${id}: capture`);
        if (!WHEN_MISSING.has(fact.whenMissing)) problems.push(`${id}: whenMissing`);
        if (!Array.isArray(fact.writers) || !Array.isArray(fact.readers)) problems.push(`${id}: writers/readers`);
        if (fact.status !== undefined && fact.status !== 'gap') problems.push(`${id}: status`);
        if (fact.storage === null) {
          if (fact.status !== 'gap') problems.push(`${id}: null storage without status gap`);
        } else if (typeof fact.storage !== 'string' || !/^[a-z_]+(\.[A-Za-z0-9_]+(\[\])?)+$/.test(fact.storage)) {
          problems.push(`${id}: storage must be one dotted path`);
        }
        if (fact.status !== 'gap' && !(fact.writers || []).length) problems.push(`${id}: no writers`);
        for (const writer of fact.writers || []) {
          const ok = typeof writer === 'string'
            || (writer && typeof writer.file === 'string'
              && typeof writer.writerSymbol === 'string' && writer.writerSymbol.trim());
          if (!ok) problems.push(`${id}: writer shape`);
        }
        for (const reader of fact.readers || []) {
          if (!reader || typeof reader.file !== 'string' || typeof reader.section !== 'string' || !reader.section) {
            problems.push(`${id}: reader shape`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test('every writer and reader path exists on disk', () => {
    const missing = [];
    for (const entry of allFacts) {
      const files = [...entry.fact.writers.map(writerFile), ...entry.fact.readers.map((r) => r.file)];
      for (const rel of files) {
        if (readRepoFile(rel) === null) missing.push(`${label(entry)}: ${rel}`);
      }
    }
    expect(missing).toEqual([]);
  });

  // Every declared writer edge is checked on its own, for every storage
  // family: a stale writer entry (a client surface that stopped submitting
  // the fact) fails even while another writer still names the key.
  test('every declared writer names the storage key or its declared writerSymbol', () => {
    const unwritten = [];
    for (const entry of allFacts) {
      const { storage, writers } = entry.fact;
      if (!storage) continue;
      for (const writer of writers) {
        const needle = typeof writer === 'string' ? storageKey(storage) : writer.writerSymbol;
        const file = writerFile(writer);
        if (!(readRepoFile(file) || '').includes(needle)) {
          unwritten.push(`${label(entry)}: "${needle}" not in ${file}`);
        }
      }
    }
    expect(unwritten).toEqual([]);
  });

  test('every reader file names the storage key or its declared readerSymbol', () => {
    const unread = [];
    for (const entry of allFacts) {
      const { storage, readers } = entry.fact;
      for (const reader of readers) {
        const needle = reader.readerSymbol || (storage && storageKey(storage));
        if (!needle || !(readRepoFile(reader.file) || '').includes(needle)) {
          unread.push(`${label(entry)}: "${needle}" not in ${reader.file}`);
        }
      }
    }
    expect(unread).toEqual([]);
  });

  test('gap facts have no readers and are listed in the doc Known gaps section', () => {
    const doc = fs.readFileSync(DOC_PATH, 'utf8');
    const match = doc.match(/^## Known gaps\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m);
    expect(match).not.toBeNull();
    const knownGaps = match[1];
    const problems = [];
    for (const entry of allFacts) {
      if (entry.fact.status !== 'gap') continue;
      if (entry.fact.readers.length) problems.push(`${label(entry)}: gap fact has readers`);
      if (!knownGaps.includes(`\`${entry.fact.key}\``)) problems.push(`${label(entry)}: missing from Known gaps`);
    }
    // And the reverse: a fact with no reader must be declared a gap.
    for (const entry of allFacts) {
      if (!entry.fact.readers.length && entry.fact.status !== 'gap') {
        problems.push(`${label(entry)}: no readers but not status gap`);
      }
    }
    expect(problems).toEqual([]);
  });

  test('no line lists a retired catalog key; each retirement names its migration', () => {
    const problems = [];
    for (const [key, migration] of Object.entries(RETIRED_CATALOG_KEYS)) {
      const src = readRepoFile(migration);
      if (src === null) problems.push(`${key}: ${migration} missing`);
      else if (!src.includes(`'${key}'`)) problems.push(`${key}: not named in ${migration}`);
    }
    for (const [line, def] of Object.entries(VISIT_FACTS_CONTRACT)) {
      for (const key of def.catalogKeys) {
        if (RETIRED_CATALOG_KEYS[key]) problems.push(`${line}: lists retired catalog key ${key}`);
      }
    }
    expect(problems).toEqual([]);
  });

  test('no undeclared tap-only fact on a voice-fill line', () => {
    const problems = [];
    for (const entry of allFacts) {
      const { fact } = entry;
      const tapOnlyCapture = fact.capture.length === 1 && fact.capture[0] === 'tap';
      if (fact.tapOnly !== undefined && !tapOnlyCapture) problems.push(`${label(entry)}: tapOnly on a non-tap-only capture`);
      if (!entry.voiceFill || !tapOnlyCapture) continue;
      if (fact.tapOnly !== true || typeof fact.reason !== 'string' || !fact.reason.trim()) {
        problems.push(`${label(entry)}: tap-only on a voice-fill line needs tapOnly + reason`);
      }
    }
    expect(problems).toEqual([]);
  });
});
