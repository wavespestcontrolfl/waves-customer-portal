/**
 * Codex round 11 P1 on #6135: GATE_AREA_ADDONS is the switch for SELLING add-ons (quote, price, send, accept, book).
 * Data that already exists - a booked visit, its add-on rows, tagged application rows, the ledger - must stay readable and
 * auditable with the gate off, so no reader of that data may ask the gate. This pins the complete list of server files
 * that read it. A new file on the list must be a sale or quote entry point; a reader of existing data keys on the data.
 */
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..');
const CLIENT = path.join(SERVER, '..', 'client', 'src');

// Every file that reads the gate, and why a read there is right (all of them stop a NEW sale or quote).
const SALE_OR_QUOTE_ENTRY_POINTS = {
  'routes/property-lookup-v2.js': 'estimator input: refuses add-ons in a new quote',
  'routes/admin-pricing-config.js': 'estimator catalog: tells the staff screen whether to offer add-ons',
  'services/area-addon-limits.js': 'quote history read for a new quote, and the accept/reserve/booking limit recheck (a gated estimate is refused before it)',
  'services/pricing-engine/service-pricing.js': 'the pricer: no add-on line is priced with the gate off',
  'services/pricing-engine/v1-legacy-mapper.js': 'a stored estimate is refused at send, accept, manual accept, linked booking, slots and card intents',
};

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'tests', 'models', '__tests__'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(js|jsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
  }
  return out;
}

// A line of code that names the gate (a comment line does not read it).
const readsGate = (file) => fs.readFileSync(file, 'utf8').split('\n')
  .some((line) => line.includes('GATE_AREA_ADDONS') && !/^\s*(\/\/|\*|\/\*)/.test(line));

describe('GATE_AREA_ADDONS readers', () => {
  test('only the sale and quote entry points read the gate on the server', () => {
    const readers = sourceFiles(SERVER).filter(readsGate).map((file) => path.relative(SERVER, file)).sort();
    expect(readers).toEqual(Object.keys(SALE_OR_QUOTE_ENTRY_POINTS).sort());
  });

  test('the client never reads it: the screens follow the server\'s catalog flag and the visit\'s own data', () => {
    expect(sourceFiles(CLIENT).filter(readsGate)).toEqual([]);
  });

  test('the readers of existing add-on data do not ask the gate (job card, closeout, completion, feed, discount, limits audit)', () => {
    for (const file of [
      'services/job-card.js', 'services/service-closeout-requirements.js', 'services/closeout-status.js', 'services/closeout-alerts.js',
      'services/complete-scheduled-service.js', 'services/area-addon-governed-rate.js', 'services/area-addon-visit-rows.js',
      'services/application-limits.js', 'services/lawn-fast-complete.js', 'services/fast-complete-voice-fill.js',
      'services/pest-recap.js', 'services/estimate-converter.js', 'routes/admin-schedule.js',
    ]) {
      expect(readsGate(path.join(SERVER, file))).toBe(false);
    }
  });
});
