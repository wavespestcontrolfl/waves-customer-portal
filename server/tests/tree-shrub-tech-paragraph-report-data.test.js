// The tree & shrub report build reads the frozen "From your technician"
// paragraph (GATE_TS_TECH_PARAGRAPH) and hands it to the payload as
// reportV2.techParagraph. It only READS: no model call at render. Gate off, no
// entry, an entry for another assessment, or a frozen text that no longer
// passes the read-time screens: the key is absent. Synthetic data only.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../services/service-report/treatment-narrative', () => ({
  buildTreatmentNarrative: jest.fn(async () => null),
  treatmentNarrativePdfSignature: jest.fn(async () => ''),
}));
jest.mock('../services/tree-shrub-assessment', () => ({
  ...jest.requireActual('../services/tree-shrub-assessment'),
  buildTreeShrubAssessmentReportData: jest.fn(),
}));

const { dispatchWithFallback } = require('../services/llm/call');
const { buildTreeShrubAssessmentReportData } = require('../services/tree-shrub-assessment');
const { buildReportV1Data } = require('../services/service-report/report-data');
const tech = require('../services/service-report/tree-shrub-tech-paragraph');

const SLOTS = { observed: [{ condition: 'scale', plant: 'hedges' }], maybe: [], confirmed: [], products: ['Merit 2F'], allClear: null };
const TEXT = tech.render(SLOTS);

function makeKnex() {
  const knex = () => {
    const rows = [];
    const q = {};
    ['select', 'leftJoin', 'join', 'where', 'andWhere', 'orWhere', 'whereIn', 'whereNot', 'whereNotNull', 'whereNull', 'whereRaw', 'orderBy', 'limit', 'groupBy'].forEach((m) => { q[m] = () => q; });
    q.modify = (fn) => { fn(q); return q; };
    q.first = () => Promise.resolve(null);
    q.columnInfo = () => Promise.resolve({});
    q.catch = () => Promise.resolve(rows);
    q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
    return q;
  };
  knex.raw = (sql) => sql;
  return knex;
}

const structured = (entry) => JSON.stringify(entry === undefined ? {} : { treeShrubTechParagraph: { 77: entry } });
const frozenEntry = (text = TEXT, extra = {}) => ({ v: 1, promptVersion: 'ts_tech_paragraph_v2', assessmentId: '77', text, slots: SLOTS, ...extra });

const serviceOf = (structuredNotes) => ({
  id: 'svc-ts-1',
  scheduled_service_id: null,
  customer_id: 'cust-ts-1',
  service_line: 'tree_shrub',
  service_type: 'Tree & Shrub Care',
  service_date: '2026-10-05',
  first_name: 'Test',
  last_name: 'Customer',
  city: 'Bradenton',
  areas_serviced: JSON.stringify(['Back yard']),
  structured_notes: structuredNotes,
  service_data: '{}',
  pressure_index: 0,
});

const ASSESSMENT = {
  assessmentId: 77,
  assessmentDate: '2026-10-05',
  scores: { foliageFullness: 82, leafColorVigor: 78, pestActivity: 66, diseaseLeafSpot: 80, waterHeatStress: 79, overallScore: 77 },
  observations: '',
  aiSummary: null,
  photos: [],
  plantGroups: [],
  trend: [],
};

const GATES = ['GATE_TS_TECH_PARAGRAPH', 'GATE_TS_TECH_FINDINGS_COPY'];
const saved = Object.fromEntries(GATES.map((g) => [g, process.env[g]]));
afterEach(() => { GATES.forEach((g) => { if (saved[g] === undefined) delete process.env[g]; else process.env[g] = saved[g]; }); });
const gatesOn = () => { GATES.forEach((g) => { process.env[g] = 'true'; }); };

const build = (structuredNotes) => buildReportV1Data(serviceOf(structuredNotes), 'tok', makeKnex());

beforeEach(() => {
  dispatchWithFallback.mockReset();
  buildTreeShrubAssessmentReportData.mockReset();
  buildTreeShrubAssessmentReportData.mockResolvedValue(ASSESSMENT);
});

test('gate off: the payload has no techParagraph key even when an entry is frozen', async () => {
  GATES.forEach((g) => { delete process.env[g]; });
  const data = await build(structured(frozenEntry()));
  expect(data.reportV2).toBeTruthy();
  expect(data.reportV2).not.toHaveProperty('techParagraph');
  expect(JSON.stringify(data)).not.toContain(TEXT);
});

test('gate on: the frozen text rides reportV2.techParagraph, read from the record, no model call', async () => {
  gatesOn();
  const data = await build(structured(frozenEntry()));
  expect(data.reportV2.techParagraph).toBe(TEXT);
  expect(dispatchWithFallback).not.toHaveBeenCalled();
});

test('gate on, no entry or an entry for another assessment: the key is absent', async () => {
  gatesOn();
  expect(await build(structured(undefined))).toHaveProperty('reportV2');
  expect((await build(structured(undefined))).reportV2).not.toHaveProperty('techParagraph');
  const other = JSON.stringify({ treeShrubTechParagraph: { 99: frozenEntry(TEXT, { assessmentId: '99' }) } });
  expect((await build(other)).reportV2).not.toHaveProperty('techParagraph');
});

test('gate on: a frozen entry that no longer matches its slots (edited text, missing slots, banned term) prints nothing', async () => {
  gatesOn();
  for (const bad of [
    frozenEntry(`${TEXT} Prune the hedge.`),
    frozenEntry('Our technician saw a conk on one palm trunk.'),
    frozenEntry(TEXT, { slots: undefined }),
    frozenEntry(TEXT, { slots: { ...SLOTS, observed: [] } }),
  ]) {
    const data = await build(structured(bad));
    expect(data.reportV2).not.toHaveProperty('techParagraph');
  }
});

test('the lawn paragraph\'s key is never read for a tree & shrub visit', async () => {
  gatesOn();
  const lawnKey = JSON.stringify({ lawnTechParagraph: { 77: frozenEntry() } });
  expect((await build(lawnKey)).reportV2).not.toHaveProperty('techParagraph');
});
