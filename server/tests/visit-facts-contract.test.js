/**
 * Visit facts contract — static guard for server/config/visit-facts-contract.js
 * (owner rulings 2026-09-28; doc: docs/design/visit-facts-contract.md).
 *
 * The registry pins, per service line, which facts a completed visit records,
 * where they are stored, who writes them and which report section reads them.
 * This suite fails when that map drifts from the code: a renamed storage key,
 * a moved reader, a gap that silently closed (or opened) without the doc
 * saying so. Plain file reads and string searches — no DB. Besides the
 * registry it loads only the DB-free modules the typed facts are generated
 * from (project-types.js, activity-indicators.js), to re-derive them
 * independently.
 */
const fs = require('fs');
const path = require('path');
const {
  VISIT_FACTS_CONTRACT,
  EXCLUDED_SERVICE_LINES,
  RETIRED_CATALOG_KEYS,
  TYPED_REPORT_BUILDERS,
  REPORT_DATA_TYPED_AREA_FIELD_KEYS,
} = require('../config/visit-facts-contract');
const { PROJECT_TYPES } = require('../services/project-types');
const { REQUIRED_FINDINGS_FIELDS } = require('../services/service-report/activity-indicators');
const { renderTypedFactsBlock, BLOCK_START, BLOCK_END } = require('../scripts/generate-visit-facts-doc');

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

function readDoc() {
  return fs.readFileSync(DOC_PATH, 'utf8');
}

/** The body of the doc's `## Known gaps` section. */
function knownGapsSection(doc) {
  const match = doc.match(/^## Known gaps\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m);
  return match ? match[1] : null;
}

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
          // Nothing can write a fact that has no storage; a writer here would
          // be an unchecked (and false) edge.
          if ((fact.writers || []).length) problems.push(`${id}: null storage but writers declared`);
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
        if (fact.qualifiedBy !== undefined && !def.facts.some((f) => f.key === fact.qualifiedBy)) {
          problems.push(`${id}: qualifiedBy ${fact.qualifiedBy} is not a fact on this line`);
        }
        if (fact.typedForm !== undefined && fact.typedForm !== def.typedForm) {
          problems.push(`${id}: typed fact from form ${fact.typedForm} on a line whose typedForm is ${def.typedForm}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  // A measurement without its unit is not interpretable: every
  // service_products measurement column is registered with its unit column.
  test('every product measurement is registered with its unit fact', () => {
    const MEASUREMENT_UNITS = {
      'service_products.area_value': 'service_products.area_unit',
      'service_products.total_amount': 'service_products.amount_unit',
      'service_products.application_rate': 'service_products.rate_unit',
    };
    const problems = [];
    for (const [line, def] of Object.entries(VISIT_FACTS_CONTRACT)) {
      for (const fact of def.facts) {
        const unitStorage = MEASUREMENT_UNITS[fact.storage];
        if (!unitStorage) continue;
        const unit = def.facts.find((f) => f.key === fact.qualifiedBy);
        if (!unit || unit.storage !== unitStorage) problems.push(`${line}.${fact.key}: not qualifiedBy a ${unitStorage} fact`);
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

  // Known gaps lists each gap as a bullet naming `<line>.<fact key>`. Both
  // directions are checked: every registry gap is listed, and every listed
  // gap is still a `status: 'gap'` fact on that line (a gap deleted from the
  // registry while the doc still promises it fails here).
  test('gap facts have no readers and match the doc Known gaps list both ways', () => {
    const knownGaps = knownGapsSection(readDoc());
    expect(knownGaps).not.toBeNull();
    const bullets = knownGaps.split('\n').filter((l) => /^- /.test(l));
    const problems = [];
    const documented = new Set();
    for (const bullet of bullets) {
      const m = bullet.match(/^- `([a-z_]+)\.([a-z0-9_]+)`:/);
      if (!m) {
        problems.push(`Known gaps bullet does not start with \`<line>.<fact>\`: ${bullet.slice(0, 60)}`);
        continue;
      }
      const [, line, key] = m;
      documented.add(`${line}.${key}`);
      const fact = (VISIT_FACTS_CONTRACT[line]?.facts || []).find((f) => f.key === key);
      if (!fact) problems.push(`${line}.${key}: in Known gaps but not a registry fact`);
      else if (fact.status !== 'gap') problems.push(`${line}.${key}: in Known gaps but not status gap`);
    }
    for (const entry of allFacts) {
      if (entry.fact.status !== 'gap') continue;
      if (entry.fact.readers.length) problems.push(`${label(entry)}: gap fact has readers`);
      if (!documented.has(label(entry))) problems.push(`${label(entry)}: missing from Known gaps`);
    }
    // A fact with no reader must be declared a gap.
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

  // ---------------------------------------------------------------------
  // Typed lines are generated from project-types.js; these re-derive the
  // expectation independently so the generator cannot be bypassed.
  // ---------------------------------------------------------------------

  const typedLines = Object.entries(VISIT_FACTS_CONTRACT).filter(([, def]) => def.typedForm);

  test('each typed line carries exactly its form\'s fields, requiredness from REQUIRED_FINDINGS_FIELDS', () => {
    expect(typedLines.length).toBeGreaterThan(0);
    const problems = [];
    for (const [line, def] of typedLines) {
      const cfg = PROJECT_TYPES[def.typedForm];
      if (!cfg) {
        problems.push(`${line}: typedForm ${def.typedForm} is not a PROJECT_TYPES key`);
        continue;
      }
      const required = new Set(REQUIRED_FINDINGS_FIELDS[def.typedForm] || []);
      const fields = new Map(cfg.findingsFields.map((f) => [f.key, f]));
      for (const key of required) {
        if (!fields.has(key)) problems.push(`${line}: REQUIRED_FINDINGS_FIELDS.${def.typedForm} names ${key}, not a field of the form`);
      }
      const expected = cfg.findingsFields
        .filter((f) => !f.internal || required.has(f.key))
        .map((f) => f.key)
        .sort();
      const typed = def.facts.filter((f) => f.typedForm === def.typedForm);
      expect({ line, keys: typed.map((f) => f.key).sort() }).toEqual({ line, keys: expected });
      for (const fact of def.facts) {
        if (fact.typedForm === undefined && fact.storage && fact.storage.startsWith('service_data.typedReportSnapshot.')) {
          problems.push(`${line}.${fact.key}: hand-written typed fact (generate it from ${def.typedForm})`);
        }
      }
      for (const fact of typed) {
        const shouldRequire = required.has(fact.key);
        if ((fact.whenMissing === 'required') !== shouldRequire) {
          problems.push(`${line}.${fact.key}: whenMissing ${fact.whenMissing}, REQUIRED_FINDINGS_FIELDS says ${shouldRequire ? 'required' : 'optional'}`);
        }
        const field = fields.get(fact.key);
        if (fact.label !== field.label || fact.fieldType !== field.type) problems.push(`${line}.${fact.key}: label/type differ from project-types.js`);
      }
    }
    expect(problems).toEqual([]);
  });

  test('typed builders read exactly the keys registered for them, all defined by the form', () => {
    const problems = [];
    for (const [name, builder] of Object.entries(TYPED_REPORT_BUILDERS)) {
      const src = readRepoFile(builder.file) || '';
      const reads = [...new Set([...src.matchAll(/\bvalues\??\.([a-z][a-z0-9_]*)\b/g)].map((m) => m[1]))].sort();
      expect({ builder: name, reads }).toEqual({ builder: name, reads: [...builder.keys].sort() });
      const fieldKeys = new Set((PROJECT_TYPES[builder.typedForm]?.findingsFields || []).map((f) => f.key));
      for (const key of reads) {
        if (!fieldKeys.has(key)) problems.push(`${builder.file} reads values.${key}, which ${builder.typedForm} does not define`);
      }
      for (const key of Object.keys(builder.sections)) {
        if (!builder.keys.includes(key)) problems.push(`${name}: section label for ${key}, which the builder does not read`);
      }
      const lines = typedLines.filter(([, def]) => def.typedForm === builder.typedForm);
      if (!lines.length) problems.push(`${name}: no line completes through ${builder.typedForm}`);
      for (const [line, def] of lines) {
        for (const key of builder.keys) {
          const fact = def.facts.find((f) => f.key === key && f.typedForm === builder.typedForm);
          if (!fact || !fact.readers.some((r) => r.file === builder.file)) {
            problems.push(`${line}.${key}: read by ${builder.file} but has no reader edge to it`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test('the typed areas key list matches report-data.js TYPED_AREA_FIELD_KEYS', () => {
    const src = readRepoFile('server/services/service-report/report-data.js') || '';
    const m = src.match(/const TYPED_AREA_FIELD_KEYS = \[([^\]]*)\]/);
    expect(m).not.toBeNull();
    const keys = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    expect(keys).toEqual([...REPORT_DATA_TYPED_AREA_FIELD_KEYS]);
  });

  test('the doc\'s generated typed facts block matches the registry', () => {
    const doc = readDoc();
    const start = doc.indexOf(BLOCK_START);
    const end = doc.indexOf(BLOCK_END);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    // Regenerate with: node server/scripts/generate-visit-facts-doc.js
    expect(doc.slice(start, end + BLOCK_END.length)).toEqual(renderTypedFactsBlock());
  });
});
