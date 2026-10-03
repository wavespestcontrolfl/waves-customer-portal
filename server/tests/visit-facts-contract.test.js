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
 * independently. It also re-derives, from complete-scheduled-service.js
 * itself, the full set of structured_notes keys that file writes (a
 * char-level scan, not a naive regex, since this codebase merges many of
 * those keys in via `...(cond ? { key } : {})` spreads) and requires every
 * one to be either a registered fact or an explicitly reasoned internal-only
 * key (UNREGISTERED_INTERNAL_KEYS) — so a new key can't quietly become a
 * customer-facing report input, or quietly stay internal, without a
 * registry decision either way.
 */
const fs = require('fs');
const path = require('path');
const {
  VISIT_FACTS_CONTRACT,
  EXCLUDED_SERVICE_LINES,
  RETIRED_CATALOG_KEYS,
  UNREGISTERED_INTERNAL_KEYS,
  TYPED_REPORT_BUILDERS,
  REPORT_DATA_TYPED_AREA_FIELD_KEYS,
  FAST_COMPLETE_TYPED_FORMS,
} = require('../config/visit-facts-contract');
const { PROJECT_TYPES } = require('../services/project-types');
const {
  REQUIRED_FINDINGS_FIELDS,
  ACTIVITY_INDICATORS,
  requiredFindingsFieldsFor,
} = require('../services/service-report/activity-indicators');
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

/**
 * Every key a typed report builder reads off its `values` object: dot access
 * (`values.foo`, `values?.foo`), bracket access with a string literal
 * (`values['foo']`, `values?.["foo"]`), and destructuring
 * (`const { foo, bar: baz } = values`). Catches the forms a plain
 * `values\.key` regex misses (Codex P2, round 4) so a builder that starts
 * reading a field through one of these forms can't silently escape the
 * reader-drift guard below.
 */
function extractValuesKeys(src) {
  const keys = new Set();
  for (const m of src.matchAll(/\bvalues\??\.([A-Za-z_][A-Za-z0-9_]*)\b/g)) keys.add(m[1]);
  for (const m of src.matchAll(/\bvalues\??\.?\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g)) keys.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*values\b/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(':')[0].trim().replace(/^\.\.\./, '');
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) keys.add(name);
    }
  }
  return keys;
}

/**
 * Every top-level key the `structuredNotes` object literal in
 * complete-scheduled-service.js writes — including keys merged in through a
 * `...(cond ? { key: … } : {})` spread, which this codebase uses throughout
 * that object for conditionally-frozen fields. Char-level scan (not a single
 * regex): a stack of "is this brace's contents a structured_notes top-level
 * merge, or a nested VALUE object" contexts, decided by the character
 * immediately preceding each `{` (`?` after a spread's ternary = top-level
 * merge; `:` after a key = a nested value, not itself a set of top-level
 * keys). Verified against the live file (2026-09-28): finds all 49 keys,
 * including the 14 spread-merged ones a naive per-line scan misses.
 */
function structuredNotesWrittenKeys(src) {
  const marker = 'const structuredNotes = {';
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('structuredNotesWrittenKeys: marker not found — complete-scheduled-service.js changed shape');
  const braceStart = start + marker.length - 1;
  const contextStack = [];
  const charTop = new Array(src.length).fill(null);
  let end = -1;
  for (let i = braceStart; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') {
      let j = i - 1;
      while (j >= 0 && /\s/.test(src[j])) j--;
      const prevChar = src[j];
      const isTop = contextStack.length === 0 ? true : (prevChar === '?' && contextStack[contextStack.length - 1] === true);
      contextStack.push(isTop);
    } else if (ch === '}') {
      contextStack.pop();
      if (contextStack.length === 0) { end = i; charTop[i] = true; break; }
    }
    charTop[i] = contextStack.length ? contextStack[contextStack.length - 1] : true;
  }
  if (end < 0) throw new Error('structuredNotesWrittenKeys: no matching close brace found');
  const objectSrc = src.slice(braceStart, end + 1);
  const objectCharTop = charTop.slice(braceStart, end + 1);
  const keys = new Set();
  // Plain top-level keys (including the later lines of a multi-line spread
  // body, e.g. the 2nd+ key inside `...(cond ? {\n key: v,\n key2: v2\n} : {})`).
  let offset = 0;
  for (const line of objectSrc.split('\n')) {
    const lineStartTop = objectCharTop[offset] === true;
    const trimmed = line.trim();
    if (lineStartTop && trimmed && !trimmed.startsWith('...') && !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')) {
      const m = trimmed.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*[:,]/) || trimmed.match(/^([A-Za-z_$][A-Za-z0-9_$]*)$/);
      if (m) keys.add(m[1]);
    }
    offset += line.length + 1;
  }
  // The FIRST key of every spread merge, single-line or not (`...(cond ? {`
  // may open on the same line as its key, or on a line of its own) — every
  // `? {` in this object is a spread-merge branch (verified 1:1 against the
  // `...(` count on 2026-09-28), so this alone is safe without also
  // requiring a preceding `...(` in the match.
  for (const m of objectSrc.matchAll(/\?\s*\{\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*[,:}]/g)) keys.add(m[1]);
  return keys;
}

describe('visit facts contract registry', () => {
  test('lines and facts have a valid shape, keys unique per line', () => {
    const problems = [];
    for (const [line, def] of Object.entries(VISIT_FACTS_CONTRACT)) {
      if (EXCLUDED_SERVICE_LINES[line]) problems.push(`${line}: excluded line listed in the registry`);
      // The exclusion also has to be checked against every catalog key a line
      // lists, not just the line's own identifier — the retired-key check
      // below does the same for RETIRED_CATALOG_KEYS. Without this, adding
      // wdo_inspection or termite_slab_pretreat under a differently named
      // line stays green.
      for (const key of def.catalogKeys || []) {
        if (EXCLUDED_SERVICE_LINES[key]) problems.push(`${line}: catalogKeys lists excluded service key ${key}`);
      }
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
        // companionStorage (a `both`-applicability typed fact's second,
        // companion-context storage path — same shape rule as storage, and
        // only meaningful alongside a real primary `storage`) and
        // companionWhenMissing (that same fact's companion-context
        // requiredness) are optional, but must be valid when present.
        if (fact.companionStorage !== undefined) {
          if (fact.storage === null) problems.push(`${id}: companionStorage without a primary storage`);
          else if (typeof fact.companionStorage !== 'string' || !/^[a-z_]+(\.[A-Za-z0-9_]+(\[\])?)+$/.test(fact.companionStorage)) {
            problems.push(`${id}: companionStorage must be one dotted path`);
          }
        }
        if (fact.companionWhenMissing !== undefined && !WHEN_MISSING.has(fact.companionWhenMissing)) {
          problems.push(`${id}: companionWhenMissing`);
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

  // Every structured_notes key complete-scheduled-service.js actually writes
  // must be accounted for: either it is a registered fact's storage key (a
  // customer-report input this registry tracks), or it is named in
  // UNREGISTERED_INTERNAL_KEYS with a reason (internal bookkeeping this
  // registry deliberately does not track). Without this, a brand-new key
  // that quietly becomes a customer-facing report input could land with
  // neither a registry entry nor a documented "this is internal" decision.
  test('every structured_notes key is a registered fact or an allow-listed internal key', () => {
    const src = readRepoFile('server/services/complete-scheduled-service.js') || '';
    const written = structuredNotesWrittenKeys(src);
    expect(written.size).toBeGreaterThan(30); // sanity: the extractor is finding real keys
    const registeredKeys = new Set(
      allFacts
        .map((entry) => entry.fact.storage)
        .filter((storage) => storage && storage.startsWith('structured_notes.'))
        .map(storageKey),
    );
    const problems = [];
    for (const key of written) {
      if (registeredKeys.has(key)) continue;
      if (Object.prototype.hasOwnProperty.call(UNREGISTERED_INTERNAL_KEYS, key)) continue;
      problems.push(`structured_notes.${key}: written by complete-scheduled-service.js but neither a registered fact nor in UNREGISTERED_INTERNAL_KEYS`);
    }
    // Reverse direction: an allow-list entry for a key the object no longer
    // writes is stale and should be removed (it would otherwise mask a
    // rename silently widening what "internal" covers).
    for (const key of Object.keys(UNREGISTERED_INTERNAL_KEYS)) {
      if (!written.has(key)) problems.push(`UNREGISTERED_INTERNAL_KEYS.${key}: no longer written by complete-scheduled-service.js`);
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
      // The full companion-context required set (base + this form's
      // COMPANION_REQUIRED_FINDINGS_FIELDS extras, e.g. tree_shrub's
      // treatments_completed) — a companionOnly field's ONLY context, and a
      // `both` field's second context alongside `required` above.
      const requiredCompanion = new Set(requiredFindingsFieldsFor(def.typedForm, { companion: true }));
      const fields = new Map(cfg.findingsFields.map((f) => [f.key, f]));
      for (const key of required) {
        if (!fields.has(key)) problems.push(`${line}: REQUIRED_FINDINGS_FIELDS.${def.typedForm} names ${key}, not a field of the form`);
      }
      // Mirrors typedFactFields()'s own inclusion rule exactly (independent
      // re-derivation, not a call into it): a pesticideOnly internal field
      // (pollinator_status / irac_frac_logged) is CONDITIONALLY required —
      // validateTreeShrubTypedCompliance enforces it whenever a pesticide
      // product is on the visit — which REQUIRED_FINDINGS_FIELDS has no way
      // to express, so it must be included here too or a bypass of
      // typedFactFields's own filter would go undetected (codex follow-up on
      // #5190).
      const expected = cfg.findingsFields
        .filter((f) => !f.internal || required.has(f.key) || f.pesticideOnly)
        .map((f) => f.key)
        .sort();
      const typed = def.facts.filter((f) => f.typedForm === def.typedForm);
      expect({ line, keys: typed.map((f) => f.key).sort() }).toEqual({ line, keys: expected });
      for (const fact of def.facts) {
        // The generated per-field storage is always `....typedReportSnapshot.values.<key>`
        // (primary) or `....companionReportSnapshots[].values.<key>` (companion) —
        // scoped to `.values.` so a hand-written fact at a SIBLING path on the
        // same snapshot (e.g. typedPhotoSummaryFact's `.photoSummary`, not a
        // findingsFields entry) is not mistaken for a bypassed generator.
        if (fact.typedForm === undefined && fact.storage
          && (fact.storage.startsWith('service_data.typedReportSnapshot.values.')
            || fact.storage.startsWith('service_data.companionReportSnapshots[].values.'))) {
          problems.push(`${line}.${fact.key}: hand-written typed fact (generate it from ${def.typedForm})`);
        }
      }
      for (const fact of typed) {
        const field = fields.get(fact.key);
        const isCompanionOnly = !!field.companionOnly;
        // A companionOnly field has only ONE context (companion) — its single
        // whenMissing is decided by the full companion-context required set.
        // A `both` field's whenMissing is its PRIMARY-context requiredness
        // (base REQUIRED_FINDINGS_FIELDS); its companion-context requiredness
        // (codex P2 round 5, e.g. tree_shrub's treatments_completed) is
        // `companionWhenMissing` when it differs, else the same as
        // `whenMissing`.
        const shouldRequire = isCompanionOnly ? requiredCompanion.has(fact.key) : required.has(fact.key);
        if ((fact.whenMissing === 'required') !== shouldRequire) {
          problems.push(`${line}.${fact.key}: whenMissing ${fact.whenMissing}, ${isCompanionOnly ? 'companion-required set' : 'REQUIRED_FINDINGS_FIELDS'} says ${shouldRequire ? 'required' : 'optional'}`);
        }
        if (isCompanionOnly) {
          if (fact.companionStorage !== undefined) problems.push(`${line}.${fact.key}: companionOnly fact should not declare companionStorage (its storage already IS the companion path)`);
          if (fact.companionWhenMissing !== undefined) problems.push(`${line}.${fact.key}: companionOnly fact should not declare companionWhenMissing (its whenMissing already IS the companion value)`);
        } else {
          // `both` fields are legal on either a primary OR a companion
          // submission of the same form (codex P2 round 5) — the registry
          // must record BOTH storage paths and BOTH writer-edge pairs, not
          // just the primary one.
          const expectedCompanionStorage = `service_data.companionReportSnapshots[].values.${fact.key}`;
          if (fact.companionStorage !== expectedCompanionStorage) {
            problems.push(`${line}.${fact.key}: companionStorage missing/incorrect for a 'both' fact (expected ${expectedCompanionStorage})`);
          }
          const hasSymbol = (sym) => fact.writers.some((w) => w && typeof w === 'object' && w.writerSymbol === sym);
          if (!hasSymbol('companionReportSnapshots') || !hasSymbol('companionFindings')) {
            problems.push(`${line}.${fact.key}: 'both' fact missing companion writer edges (companionReportSnapshots / companionFindings)`);
          }
          const shouldRequireCompanion = requiredCompanion.has(fact.key);
          const declaredCompanion = fact.companionWhenMissing !== undefined
            ? fact.companionWhenMissing === 'required'
            : fact.whenMissing === 'required';
          if (declaredCompanion !== shouldRequireCompanion) {
            problems.push(`${line}.${fact.key}: companion-context requiredness ${declaredCompanion ? 'required' : 'optional'}, companion-required set says ${shouldRequireCompanion ? 'required' : 'optional'}`);
          }
        }
        if (fact.label !== field.label || fact.fieldType !== field.type) problems.push(`${line}.${fact.key}: label/type differ from project-types.js`);
      }
    }
    expect(problems).toEqual([]);
  });

  test('typed activity score is registered exactly on typed lines whose form has an ACTIVITY_INDICATORS entry', () => {
    const problems = [];
    for (const [line, def] of typedLines) {
      const fact = def.facts.find((f) => f.key === 'typed_activity_score');
      const indicator = ACTIVITY_INDICATORS[def.typedForm];
      if (indicator && !fact) problems.push(`${line}: ${def.typedForm} has an ACTIVITY_INDICATORS entry but no typed_activity_score fact`);
      if (!indicator && fact) problems.push(`${line}: typed_activity_score registered but ${def.typedForm} has no ACTIVITY_INDICATORS entry`);
      if (fact && fact.typedForm !== undefined) problems.push(`${line}.typed_activity_score: should not carry typedForm (not a findingsFields entry)`);
    }
    expect(problems).toEqual([]);
  });

  // On a combined visit where this form runs as a COMPANION, the score is
  // ALSO frozen onto the companion's own typed snapshot
  // (service_data.companionReportSnapshots[].activity.score) before the
  // service_activity_scores trend row inserts — a fact naming only the
  // trend-table storage would silently miss that path (codex follow-up on
  // #5190). Not covered by the generic typedFormFacts companion checks below
  // (this fact carries no typedForm), so it needs its own assertion.
  test('typed activity score records its companion storage path and writer edges', () => {
    const problems = [];
    for (const [line, def] of typedLines) {
      const fact = def.facts.find((f) => f.key === 'typed_activity_score');
      if (!fact) continue;
      const expectedCompanionStorage = 'service_data.companionReportSnapshots[].activity.score';
      if (fact.companionStorage !== expectedCompanionStorage) {
        problems.push(`${line}.typed_activity_score: companionStorage missing/incorrect (expected ${expectedCompanionStorage})`);
      }
      const hasSymbol = (sym) => fact.writers.some((w) => w && typeof w === 'object' && w.writerSymbol === sym);
      if (!hasSymbol('companionReportSnapshots') || !hasSymbol('companionFindings') || !hasSymbol('finalScore')) {
        problems.push(`${line}.typed_activity_score: missing companion writer edges (companionReportSnapshots / companionFindings / finalScore)`);
      }
    }
    expect(problems).toEqual([]);
  });

  test('each pesticideOnly compliance fact names the predicate its own validation branch uses', () => {
    const closeout = readRepoFile('server/services/tree-shrub-closeout.js') || '';
    const PREDICATES = ['hasInsectProduct', 'needsIracFracLog'];
    const problems = [];
    for (const [line, def] of typedLines) {
      const cfg = PROJECT_TYPES[def.typedForm];
      for (const field of (cfg?.findingsFields || []).filter((f) => f.pesticideOnly)) {
        const fact = def.facts.find((f) => f.key === field.key);
        const reader = fact?.readers.find((r) => r.file === 'server/services/tree-shrub-closeout.js');
        const named = reader && (reader.section.match(new RegExp(`\\((${PREDICATES.join('|')})\\)`)) || [])[1];
        // The validation branch that blocks on this field: the blank-line
        // separated block holding its first pushBlock(..., '<field>').
        const at = closeout.search(new RegExp(`pushBlock\\([^;]*'${field.key}'\\)`));
        const branch = at < 0 ? '' : closeout.slice(closeout.lastIndexOf('\n\n', at), at);
        const used = PREDICATES.filter((p) => new RegExp(`\\b${p}\\b`).test(branch));
        if (!named) problems.push(`${line}.${field.key}: server reader does not name its condition`);
        else if (used.length !== 1 || used[0] !== named) {
          problems.push(`${line}.${field.key}: registry names ${named}, validation branch uses ${used.join(', ') || 'none'}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test('the flea work-sentence reader is pinned to the field WORK_PHRASE_FIELDS.flea actually reads', () => {
    const src = readRepoFile('server/services/service-report/activity-indicators.js') || '';
    const block = src.slice(src.indexOf('const WORK_PHRASE_FIELDS = {'));
    const flea = /\n\s{2}flea:\s*\{\s*field:\s*'([a-z_]+)'/.exec(block);
    const fact = VISIT_FACTS_CONTRACT.flea.facts.find((f) => f.readers.some((r) => /WORK_PHRASE_FIELDS\.flea/.test(r.section || '')));
    expect(flea && flea[1]).toBe(fact && fact.key);
  });

  test('bora_care registers no pest activity rating (never captured for a termite-classified service)', () => {
    expect(VISIT_FACTS_CONTRACT.bora_care.facts.map((f) => f.key)).not.toContain('pest_activity_rating');
  });

  test('typed builders read exactly the keys registered for them, all defined by the form', () => {
    const problems = [];
    for (const [name, builder] of Object.entries(TYPED_REPORT_BUILDERS)) {
      const src = readRepoFile(builder.file) || '';
      const reads = [...extractValuesKeys(src)].sort();
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

describe('the typed forms the Fast Complete sheet records (GATE_TYPED_VOICE_FILL)', () => {
  test('are exactly the forms the typed reader reads whose sheet is built', () => {
    const { VOICE_TYPES, SHEET_PENDING_TYPES } = require('../services/visit-typed-facts');
    expect([...FAST_COMPLETE_TYPED_FORMS].sort()).toEqual(Object.keys(VOICE_TYPES).filter((type) => !SHEET_PENDING_TYPES.has(type)).sort());
  });

  test('a tap-only typed field (the state\'s notice questions) is registered tap-only with a reason and never read from the note', () => {
    const { VOICE_TYPES, voiceFieldsFor } = require('../services/visit-typed-facts');
    const { PROJECT_TYPES } = require('../services/project-types');
    const tapOnly = Object.entries(PROJECT_TYPES).flatMap(([form, cfg]) => (cfg.findingsFields || [])
      .filter((field) => field.tapOnly).map((field) => [form, field.key]));
    expect(tapOnly).toEqual([['termite_inspection', 'inspection_notice_affixed'], ['termite_treatment', 'posted_notice']]);
    const facts = Object.values(VISIT_FACTS_CONTRACT).flatMap((line) => line.facts || []);
    for (const [form, key] of tapOnly) {
      for (const fact of facts.filter((f) => f.typedForm === form && f.key === key)) {
        expect(fact).toMatchObject({ capture: ['tap'], tapOnly: true });
        expect(fact.reason).toMatch(/always a tap/);
      }
      expect(facts.some((f) => f.typedForm === form && f.key === key)).toBe(true);
      if (VOICE_TYPES[form]) expect(voiceFieldsFor(form).map((field) => field.key)).not.toContain(key);
    }
  });

  test('the sheet writes each one\'s card fields, and the activity score only where the tech sets it', () => {
    const facts = Object.values(VISIT_FACTS_CONTRACT).flatMap((profile) => profile.facts || []);
    const writtenBySheet = (fact, token) => (fact.writers || []).some((w) => w.file === 'client/src/components/tech/FastCompleteSheet.jsx' && w.writerSymbol === token);
    const roachSpecies = facts.find((f) => f.typedForm === 'cockroach' && f.key === 'species');
    const roachWork = facts.find((f) => f.typedForm === 'cockroach' && f.key === 'work_completed');
    const treeShrub = facts.find((f) => f.typedForm === 'tree_shrub');
    expect(writtenBySheet(roachSpecies, 'structuredFindings')).toBe(true);
    // Filled from the products, never on the card.
    expect(writtenBySheet(roachWork, 'structuredFindings')).toBe(false);
    expect(writtenBySheet(treeShrub, 'structuredFindings')).toBe(false);
  });
});
