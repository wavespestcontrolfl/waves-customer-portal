// Lawn bermuda removal: the canonical recipe sources and the cultivar policy.
// The step's text lives in lawn-protocol-v13.json (visit.addOns.bermudaRemoval) on
// the April and June St. Augustine and Zoysia visits only; pricing.csv carries the
// owner's 2026-10-06 prices; the cultivar policy mirrors the estimate copy's own.
const fs = require('fs');
const path = require('path');
const v13 = require('../config/lawn-protocol-v13.json');
const removal = require('../services/lawn-bermuda-removal');

describe('addOns.bermudaRemoval in lawn-protocol-v13.json', () => {
  const tracks = Object.keys(v13);
  test.each(tracks)('%s: only the April and June visits of St. Augustine and Zoysia carry it', (track) => {
    for (const visit of v13[track].visits) {
      const expected = ['st_augustine', 'zoysia'].includes(track) && ['Apr', 'Jun'].includes(visit.month);
      expect(Boolean(visit.addOns?.bermudaRemoval)).toBe(expected);
    }
  });

  test('each block names the gate, the mix and the three products by exact catalog name, once', () => {
    const blocks = ['st_augustine', 'zoysia'].flatMap((track) => ['Apr', 'Jun'].map((month) => removal.stepAddOn(track, month)));
    for (const block of blocks) {
      expect(block.gate).toBe('GATE_LAWN_BERMUDA_REMOVAL');
      expect(block.summary).toBe('Bermuda removal mix — Recognition 0.03 oz + Fusilade II 0.55 fl oz + nonionic surfactant 0.25% per gal per 1,000 sq ft, mapped bermuda areas plus a 3 ft border');
      const lines = block.secondary.split('\n');
      expect(lines.map((line) => line.split(' — ')[0])).toEqual([removal.RECOGNITION, removal.FUSILADE, removal.SURFACTANT]);
      expect(lines[0]).toMatch(/0\.03 oz per 1,000 sq ft/);
      expect(lines[1]).toMatch(/0\.55 fl oz per 1,000 sq ft/);
    }
  });

  test('the visit text every other reader parses is untouched: primary and secondary never name the step', () => {
    for (const track of Object.keys(v13)) {
      for (const visit of v13[track].visits) {
        expect(`${visit.primary}\n${visit.secondary}`).not.toMatch(/Recognition|Fusilade/);
      }
    }
  });

  test('stepAddOn is null everywhere else', () => {
    expect(removal.stepAddOn('bermuda', 'Apr')).toBeNull();
    expect(removal.stepAddOn('bahia', 'Jun')).toBeNull();
    expect(removal.stepAddOn('st_augustine', 'May')).toBeNull();
  });
});

describe('St. Augustine cultivar policy', () => {
  test.each([
    ['ProVista', 'excluded'], ['provista', 'excluded'], ['Captiva', 'excluded'], ['Seville', 'excluded'], ['Seville (dwarf)', 'excluded'], ['  SEVILLE ', 'excluded'], ['Pro Vista', 'excluded'],
    ['Floratam', 'ok'], ['Palmetto', 'ok'], ['Raleigh', 'ok'], ['SunClipse', 'ok'], ['Sun Clipse', 'ok'], ['floratam sod', 'ok'],
    ['CitraBlue', 'test_patch'], ['Citra Blue', 'test_patch'], [null, 'test_patch'], [undefined, 'test_patch'], ['', 'test_patch'], ['unknown', 'test_patch'], ['mystery sod', 'test_patch'],
  ])('%p is %s', (cultivar, state) => {
    expect(removal.cultivarState('st_augustine', cultivar)).toBe(state);
  });

  test('Zoysia has no cultivar rule', () => {
    for (const cultivar of ['ProVista', null, 'Zeon']) expect(removal.cultivarState('zoysia', cultivar)).toBe('ok');
  });

  test('the test-patch note states the 3 x 3 ft patch and the 3 to 4 week watch the estimate copy promises', () => {
    expect(removal.TEST_PATCH_NOTE).toMatch(/3 x 3 ft patch.*3 to 4 weeks/);
    const copy = fs.readFileSync(path.join(__dirname, '../services/estimate-service-details.js'), 'utf8');
    expect(copy).toMatch(/CitraBlue: a test patch first, watched 3–4 weeks/);
    for (const name of ['ProVista', 'Captiva', 'Seville']) expect(copy).toMatch(new RegExp(`${name}[^\\n]*no, our policy`));
  });
});

describe('pricing.csv carries the owner prices of 2026-10-06', () => {
  const rows = fs.readFileSync(path.join(__dirname, '../data/pricing.csv'), 'utf8').split('\n');
  const find = (re) => rows.filter((row) => re.test(row));

  test('Recognition 1.95 oz at SiteOne is $183.30', () => {
    expect(find(/^Recognition Post Emergent Herbicide,/)).toHaveLength(1);
    expect(find(/^Recognition Post Emergent Herbicide,/)[0]).toMatch(/SiteOne,1\.95 oz,Existing,,\$183\.30,/);
  });

  test('Fusilade II 32 fl oz is $93.88 at DoMyOwn (owner pick) and $135.29 at SiteOne; the 2.5 gal jug is $1,480.56', () => {
    const fusilade = find(/^Fusilade II/);
    expect(fusilade.some((row) => /DoMyOwn,32 fl oz,Existing,,\$93\.88,/.test(row))).toBe(true);
    expect(fusilade.some((row) => /SiteOne,32 fl oz,Existing,,\$135\.29,/.test(row))).toBe(true);
    expect(fusilade.some((row) => /SiteOne,2\.5 gal,Existing,,"\$1,480\.56",/.test(row))).toBe(true);
  });
});
