// Source guard for the lawn treatment-memory freeze (P12, best effort).
//
// The first-writer-wins memory entry may only be created from a complete read,
// so every fail-soft read that feeds the lawn report inputs must REPORT its
// failure into the build's `readFailures` set instead of quietly becoming an
// absence. This fails when a new swallowed read lands in those blocks without
// either reporting (failSoft / readFailures / onFailure) or an explicit
// `read-failure-exempt: <why>` comment, so the author has to decide.

const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, '../services/service-report/report-data.js'), 'utf8');

const between = (start, end) => {
  const a = SOURCE.indexOf(start);
  const b = SOURCE.indexOf(end, a);
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
  return { text: SOURCE.slice(a, b), offset: a };
};

const swallowed = ({ text }) => {
  const out = [];
  const re = /\.catch\(|\bcatch\s*(?:\([^)]*\))?\s*\{/g;
  let m;
  while ((m = re.exec(text))) out.push(m.index);
  return out;
};

// The swallowing statement itself (up to the end of its line) must report, or
// the line(s) just before it must carry an explicit exemption.
const reports = (text, idx) => {
  const rest = text.slice(idx);
  const end = rest.search(/\)\s*;\s*\n|\}\s*\n/);
  const statement = rest.slice(0, end === -1 ? 240 : end + 1);
  return /readFailures|failSoft|onFailure/.test(statement)
    || /read-failure-exempt/.test(text.slice(Math.max(0, idx - 160), idx));
};

const BLOCKS = {
  'buildLawnAssessmentReportData (assessment, photos, turf profile, prefs, week weather, week plan)': () => between(
    'async function buildLawnAssessmentReportData(', 'GATE_LAWN_WATERING_RULE: the visit\'s one watering instruction',
  ),
  'mowing height-of-cut reads': () => between('let mowingHeight = null;', 'const lawnProgramOverview'),
  'lawn reportV2 inputs (water snapshot, water gap history, watering inputs)': () => between(
    'let waterSnapshot = null;', 'reportV2 = buildLawnReportV2({',
  ),
};

describe('lawn treatment-memory input reads report their failure', () => {
  test.each(Object.entries(BLOCKS))('%s: every swallowed read reports or is explicitly exempt', (_name, slice) => {
    const block = slice();
    const unreported = swallowed(block).filter((idx) => !reports(block.text, idx));
    expect(unreported.map((idx) => block.text.slice(Math.max(0, idx - 80), idx + 80))).toEqual([]);
  });

  test('every turf-height and week-plan read passes onFailure', () => {
    for (const name of ['getTurfHeightForVisit', 'getTurfHeightTrend', 'loadCurrentWeekPlan']) {
      const re = new RegExp(`await ${name}\\(`, 'g');
      let m;
      let seen = 0;
      while ((m = re.exec(SOURCE))) {
        if (name === 'loadCurrentWeekPlan' && SOURCE.slice(m.index, m.index + 160).includes('strict: true')) continue; // signature lookup, not a report input
        seen += 1;
        expect(SOURCE.slice(m.index, m.index + 360)).toContain('onFailure');
      }
      expect(seen).toBeGreaterThan(0);
    }
  });

  test('the product reads feed the set: service_products and catalog enrichment', () => {
    expect(SOURCE).toMatch(/knex\('service_products'\)\.where\(\{ service_record_id: service\.id \}\)\.orderBy\('created_at'\)\.catch\(\(\) => \{ productsLoadFailed = true;/);
    expect(SOURCE).toContain("if (productsLoadFailed) readFailures.add('service_products');");
    expect(SOURCE).toContain("if (products.catalogEnrichmentFailed) readFailures.add('catalog_enrichment');");
  });

  test('the freeze guard is the collected set, not a hand-written OR of flags', () => {
    const a = SOURCE.indexOf('resolveVisitMemoryForRender({');
    const call = SOURCE.slice(a, SOURCE.indexOf('knex,\n', SOURCE.indexOf('degraded:', a)));
    expect(call).toContain('degraded: readFailures.size > 0');
    expect(call).not.toMatch(/productsLoadFailed|catalogEnrichmentFailed|portalPrefsReadFailed|weekWeatherUnfrozen/);
  });

  test('the guard really sees a new unreported read (the check itself is not vacuous)', () => {
    const sample = { text: "const x = await knex('t').first().catch(() => null);\nconst y = await knex('u').first().catch(failSoft(readFailures, 'u', null));" };
    const found = swallowed(sample).filter((idx) => !reports(sample.text, idx));
    expect(found).toHaveLength(1);
  });
});
