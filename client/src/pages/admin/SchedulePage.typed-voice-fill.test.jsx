// @vitest-environment jsdom
// Typed voice fill on the office Complete Service form (GATE_TYPED_VOICE_FILL,
// Fast Complete step 3, owner "ok go" 2026-10-02 on the mockup v8): with the
// schedule's per-visit flag on, Generate AI report first reads the notes for
// the typed visit's own findings (POST /admin/dispatch/:id/typed-facts,
// sending the form's present values only for the server to judge) and fills
// only the fields still empty, each shown with the words it came from; the
// report is then written from the filled form. A field the notes left
// unclear asks to be picked, and a failed read fills nothing and generates
// anyway. Off, Generate is exactly as before.
import { IDBFactory } from 'fake-indexeddb';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompletionPanel } from './SchedulePage';

// A cockroach form with the field kinds the reader fills: two selects and a
// chips field kept in the optional drawer.
const COCKROACH_SCHEMA = {
  type: 'cockroach',
  fields: [
    { key: 'species', label: 'Species', type: 'select', options: ['German', 'American', 'Smoky brown', 'Mixed', 'Unknown'] },
    { key: 'activity_level', label: 'Activity level', type: 'select', options: ['None observed', 'Low', 'Moderate', 'Heavy', 'Severe'] },
    { key: 'evidence_observed', label: 'Evidence observed', type: 'chips', detail: true, options: ['Live roaches', 'Dead roaches', 'Droppings', 'Egg cases'] },
  ],
};
const ROACH = {
  id: 'typed-visit', customerId: 'typed-customer', customerName: 'Synthetic Customer',
  serviceType: 'Cockroach Control', status: 'confirmed', scheduledDate: '2099-01-01', estimatedPrice: 100,
  completionProfile: { serviceKey: 'cockroach_control', findingsType: 'cockroach' },
  findingsSchema: COCKROACH_SCHEMA,
  typedVoiceFillEnabled: true,
};
const NOTE = 'German roaches, heavy behind the fridge. Saw live ones and droppings.';
const READ = {
  available: true,
  status: 'read',
  type: 'cockroach',
  values: { species: 'German', activity_level: 'Heavy' },
  heard: {
    species: [{ value: 'German', quote: 'german roaches' }],
    activity_level: [{ value: 'Heavy', quote: 'heavy behind the fridge' }],
  },
  unclearFields: [],
};

let calls;
let typedAnswer;
beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('alert', vi.fn());
  localStorage.clear();
  calls = [];
  typedAnswer = () => ({ ok: true, json: async () => READ });
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    if (url.includes('/typed-facts')) {
      calls.push({ kind: 'typed', body: JSON.parse(options.body) });
      return typedAnswer();
    }
    if (url.includes('generate-report')) {
      calls.push({ kind: 'generate', body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ report: 'WHAT WE FOUND\n\nGerman roaches behind the fridge.\n\nWHAT WE DID\n\nBaited the kitchen.' }) };
    }
    return { ok: true, json: async () => ({ customer: {}, actions: [], available: false }) };
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function openForm(service) {
  render(<CompletionPanel service={service} products={[]} onClose={() => {}} onSubmit={vi.fn().mockResolvedValue({})} />);
  await waitFor(() => expect(document.querySelector('textarea')).toBeTruthy(), { timeout: 10000 });
  fireEvent.change(document.querySelector('textarea'), { target: { value: NOTE } });
}
const fieldSelect = (key) => document.getElementById(`typed-finding-cockroach-${key}`);
async function generate() {
  await act(async () => fireEvent.click(screen.getAllByRole('button', { name: /generate ai/i })[0]));
  await waitFor(() => expect(calls.some((call) => call.kind === 'generate')).toBe(true));
}
const generated = () => calls.find((call) => call.kind === 'generate').body;

describe('typed voice fill on Generate', () => {
  it('reads the notes with the form\'s present values, fills the empty fields with their words, and writes the report from them', async () => {
    await openForm(ROACH);
    await generate();
    expect(calls.map((call) => call.kind)).toEqual(['typed', 'generate']);
    expect(calls[0].body).toEqual({ note: NOTE, current: {}, scoreSet: false });
    expect(generated().structuredFindings).toEqual({ type: 'cockroach', values: { species: 'German', activity_level: 'Heavy' } });
    expect(fieldSelect('species').value).toBe('German');
    expect(screen.getAllByText('Heard: “german roaches”').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Heard: “heavy behind the fridge”').length).toBeGreaterThan(0);
  });

  it('never overwrites a pick: a field picked by hand goes to the server as present and stays', async () => {
    await openForm(ROACH);
    fireEvent.change(fieldSelect('species'), { target: { value: 'American' } });
    // Even an answer that names the field again never writes over the pick.
    typedAnswer = () => ({ ok: true, json: async () => READ });
    await generate();
    expect(calls[0].body.current).toEqual({ species: 'American' });
    expect(generated().structuredFindings.values).toEqual({ species: 'American', activity_level: 'Heavy' });
    expect(fieldSelect('species').value).toBe('American');
    expect(screen.queryByText('Heard: “german roaches”')).toBeNull();
  });

  it('a person\'s edit drops the words a fill stood on, even when the filled value is picked again (Codex P2 r3 on #5632)', async () => {
    await openForm(ROACH);
    await generate();
    expect(screen.getAllByText('Heard: “german roaches”').length).toBeGreaterThan(0);
    fireEvent.change(fieldSelect('species'), { target: { value: 'American' } });
    fireEvent.change(fieldSelect('species'), { target: { value: 'German' } });
    expect(fieldSelect('species').value).toBe('German');
    expect(screen.queryByText('Heard: “german roaches”')).toBeNull();
    // A field nobody touched keeps its words.
    expect(screen.getAllByText('Heard: “heavy behind the fridge”').length).toBeGreaterThan(0);
  });

  it('a field the notes left unclear asks to be picked, even one kept in the optional drawer', async () => {
    typedAnswer = () => ({ ok: true, json: async () => ({ ...READ, unclearFields: ['evidence_observed'] }) });
    await openForm(ROACH);
    await generate();
    await waitFor(() => expect(screen.getAllByText('The notes didn’t make this clear. Pick what applies.').length).toBeGreaterThan(0));
  });

  it('the unclear asks follow the latest Generate: a later read that answers nothing clears them (pre-push P1)', async () => {
    typedAnswer = () => ({ ok: true, json: async () => ({ ...READ, unclearFields: ['evidence_observed'] }) });
    await openForm(ROACH);
    await generate();
    await waitFor(() => expect(screen.getAllByText('The notes didn’t make this clear. Pick what applies.').length).toBeGreaterThan(0));
    typedAnswer = () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: /generate ai/i })[0]));
    await waitFor(() => expect(calls.filter((call) => call.kind === 'typed')).toHaveLength(2));
    await waitFor(() => expect(screen.queryByText('The notes didn’t make this clear. Pick what applies.')).toBeNull());
  });

  it('a failed read fills nothing and the report is still written', async () => {
    typedAnswer = () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });
    await openForm(ROACH);
    await generate();
    expect(calls.map((call) => call.kind)).toEqual(['typed', 'generate']);
    expect(generated().structuredFindings.values).toEqual({});
  });

  it('an answer for another form fills nothing', async () => {
    typedAnswer = () => ({ ok: true, json: async () => ({ ...READ, type: 'flea' }) });
    await openForm(ROACH);
    await generate();
    expect(calls.map((call) => call.kind)).toEqual(['typed', 'generate']);
    expect(generated().structuredFindings.values).toEqual({});
  });

  it('off: Generate never reads the notes for the findings', async () => {
    await openForm({ ...ROACH, typedVoiceFillEnabled: false });
    await generate();
    expect(calls.map((call) => call.kind)).toEqual(['generate']);
  });
});

describe('counts and the technician\'s rating (step 4)', () => {
  const TRAP_SCHEMA = {
    type: 'rodent_trapping',
    fields: [
      { key: 'species', label: 'Species', type: 'select', required: true, options: ['Roof rat', 'Norway rat', 'House mouse', 'Mixed', 'Unknown'] },
      { key: 'trap_visit_type', label: 'This visit', type: 'select', required: true, internal: true, options: ['Initial setup', 'Follow-up check'] },
      { key: 'traps_checked', label: 'Traps checked', type: 'count' },
      { key: 'captures', label: 'Captures', type: 'count' },
    ],
    activity: { label: 'Rodent Activity', deriveField: null, techScoreLabels: { 0: 'None', 1: 'Very low', 2: 'Low', 3: 'Moderate', 4: 'High', 5: 'Severe' } },
  };
  const TRAPS = {
    ...ROACH,
    serviceType: 'Rodent Trapping Follow-up',
    completionProfile: { serviceKey: 'rodent_trapping', findingsType: 'rodent_trapping' },
    findingsSchema: TRAP_SCHEMA,
  };
  const TRAP_READ = {
    available: true,
    status: 'read',
    type: 'rodent_trapping',
    values: { species: 'Roof rat', trap_visit_type: 'Follow-up check', traps_checked: '8', captures: '2' },
    heard: {
      species: [{ value: 'Roof rat', quote: 'the roof rats' }],
      trap_visit_type: [{ value: 'Follow-up check', quote: 'follow-up check on the roof rats' }],
      traps_checked: [{ value: '8', quote: 'checked all 8 traps' }],
      captures: [{ value: '2', quote: '2 caught by the ac chase' }],
    },
    unclearFields: [],
    score: { value: 2, quote: "i'd call it a 2" },
  };
  const trapField = (key) => document.getElementById(`typed-finding-rodent_trapping-${key}`);
  const gauge = () => document.getElementById('typed-activity-rodent_trapping');

  it('fills the counts and the technician\'s rating from the notes, each with its words, and writes the report from them', async () => {
    typedAnswer = () => ({ ok: true, json: async () => TRAP_READ });
    await openForm(TRAPS);
    await generate();
    expect(calls[0].body).toEqual({ note: NOTE, current: {}, scoreSet: false });
    expect(trapField('traps_checked').value).toBe('8');
    expect(screen.getAllByText('Heard: “checked all 8 traps”').length).toBeGreaterThan(0);
    expect(gauge().value).toBe('2');
    expect(screen.getAllByText('Set by technician').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Heard: “i\'d call it a 2”').length).toBeGreaterThan(0);
    expect(generated().typedActivityScore).toBe(2);
    expect(generated().structuredFindings.values).toMatchObject({ traps_checked: '8', captures: '2' });
  });

  it('two values heard in the same words show those words once', async () => {
    const schema = { ...TRAP_SCHEMA, fields: [...TRAP_SCHEMA.fields, { key: 'trap_actions', label: 'Trap actions', type: 'chips', options: ['Traps reset', 'Bait/lure refreshed'] }] };
    typedAnswer = () => ({
      ok: true,
      json: async () => ({
        ...TRAP_READ,
        values: { ...TRAP_READ.values, trap_actions: 'Traps reset, Bait/lure refreshed' },
        heard: {
          ...TRAP_READ.heard,
          trap_actions: [{ value: 'Traps reset', quote: 'reset and re-baited all of them' }, { value: 'Bait/lure refreshed', quote: 'reset and re-baited all of them' }],
        },
      }),
    });
    await openForm({ ...TRAPS, findingsSchema: schema });
    await generate();
    expect(screen.getAllByText('Heard: “reset and re-baited all of them”').length).toBeGreaterThan(0);
  });

  it('a rating set by hand is never filled over, and the reader is told it is set', async () => {
    typedAnswer = () => ({ ok: true, json: async () => TRAP_READ });
    await openForm(TRAPS);
    fireEvent.change(gauge(), { target: { value: '4' } });
    await generate();
    expect(calls[0].body.scoreSet).toBe(true);
    expect(gauge().value).toBe('4');
    expect(screen.queryByText('Heard: “i\'d call it a 2”')).toBeNull();
    expect(generated().typedActivityScore).toBe(4);
  });

  it('a pick drops the words a heard rating stood on, even when the heard rating is picked again', async () => {
    typedAnswer = () => ({ ok: true, json: async () => TRAP_READ });
    await openForm(TRAPS);
    await generate();
    fireEvent.change(gauge(), { target: { value: '3' } });
    fireEvent.change(gauge(), { target: { value: '2' } });
    expect(gauge().value).toBe('2');
    expect(screen.queryByText('Heard: “i\'d call it a 2”')).toBeNull();
  });

  it('a rating the notes left unclear asks to be picked', async () => {
    typedAnswer = () => ({ ok: true, json: async () => ({ ...TRAP_READ, score: undefined, scoreUnclear: true }) });
    await openForm(TRAPS);
    await generate();
    await waitFor(() => expect(screen.getAllByText('The notes didn’t make this clear. Pick one.').length).toBeGreaterThan(0));
    expect(gauge().value).toBe('');
  });
});
