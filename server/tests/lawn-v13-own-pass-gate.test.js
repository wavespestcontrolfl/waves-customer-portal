// Lawn protocol v13: the ownPass note gate (waveguard-plan-engine.js V13_GATE_NOTES; written on the Topchoice add-on rows by
// migration 20261009101000, Codex round 1 on #6160). The Topchoice label says "Do not apply in combination with other
// materials": the granule is its own spreader pass. applyAlone is the wrong gate for that (it blocks the whole selection, so
// the granule could not share a visit with the month's fertilizer); ownPass only tells the tech. No database.
const engine = require('../services/waveguard-plan-engine');
const first = require('../models/migrations/20261009100000_lawn_v13_fire_ant_granule');
const followup = require('../models/migrations/20261009101000_lawn_v13_fire_ant_granule_followup');

const NOTE = 'Apply as its own spreader pass: do not blend with the month\'s granular or any other product.';
const TOPCHOICE_GATES = { ...first.ROW.gates, ...followup.OWN_PASS };
const FERTILIZER_GATES = { targetN: '0.5 lb N/1000', blackoutSensitive: true };
const CONTEXT = { monthNumber: 4, productionMode: 'spreader_plus_spot_backpack', municipality: 'Bradenton' };

const lines = (topGates) => {
  const rows = { top: { gates: topGates }, fert: { gates: FERTILIZER_GATES } };
  return {
    lines: [
      { selected: true, product: { id: 'T', name: 'Topchoice Granular Insecticide' }, key: 'top' },
      { selected: true, product: { id: 'F', name: 'LESCO 24-0-11 with PolyPlus OPTI' }, key: 'fert' },
    ],
    rowOf: (line) => rows[line.key],
  };
};

describe('the ownPass gate', () => {
  test('the exact gate written on a Topchoice row: the Advion shape plus ownPass', () => {
    expect(followup.OWN_PASS).toEqual({ ownPass: true });
    expect(TOPCHOICE_GATES).toEqual({ trigger: 'fire_ants_optional_add_on', optionalAddOn: true, officePrices: true, ownPass: true });
  });

  test('it reads as one note, not a required condition, in every reader of gate notes', () => {
    const notes = engine.v13GateNotes(TOPCHOICE_GATES, CONTEXT);
    expect(notes).toEqual([{ key: 'ownPass', severity: 'note', text: NOTE }]);
    // The tech sheet (lawn-fast-complete.js) maps the same table to texts.
    expect(notes.map((note) => note.text)).toEqual([NOTE]);
    // No plan warning: only 'required' notes become one.
    expect(engine.v13SelectedGateWarnings([{ product: { id: 'T', name: 'Topchoice' }, gateNotes: notes }])).toEqual([]);
  });

  test('the old Advion shape carries no note, and the note needs the gate to be set', () => {
    expect(engine.v13GateNotes(first.ROW.gates, CONTEXT)).toEqual([]);
    expect(engine.v13GateNotes({ ...first.ROW.gates, ownPass: false }, CONTEXT)).toEqual([]);
  });

  test('Topchoice selected with the month\'s fertilizer: the note, no block, so every mix amount stays', () => {
    const { lines: selection, rowOf } = lines(TOPCHOICE_GATES);
    expect(engine.v13SelectionBlocks(selection, rowOf, CONTEXT)).toEqual([]);
    // The plan and the tank sheet withhold amounts only when this list is not empty.
    expect(engine.v13SelectionBlocks(selection.slice(0, 1), rowOf, CONTEXT)).toEqual([]);
    expect(engine.v13GateNotes(rowOf(selection[0]).gates, CONTEXT).map((note) => note.key)).toEqual(['ownPass']);
    expect(engine.v13GateNotes(rowOf(selection[1]).gates, CONTEXT)).toEqual([]);
  });

  test('applyAlone on the same row would have blocked the selection (why it is not used)', () => {
    const { lines: selection, rowOf } = lines({ ...TOPCHOICE_GATES, applyAlone: true });
    const blocks = engine.v13SelectionBlocks(selection, rowOf, CONTEXT);
    expect(blocks.map((block) => block.code)).toEqual(['lawn_v13_apply_alone']);
  });

  test('the note is not in any customer-facing reader of the gate table', () => {
    const fs = require('fs');
    const path = require('path');
    const customerFiles = ['../services/service-report/report-data.js', '../services/service-report/lawn-report-v2.js', '../services/lawn-program.js'];
    for (const file of customerFiles) expect(fs.readFileSync(path.join(__dirname, file), 'utf8')).not.toMatch(/v13GateNotes|gateNotes/);
  });
});
