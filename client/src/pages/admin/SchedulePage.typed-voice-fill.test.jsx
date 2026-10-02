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
    expect(calls[0].body).toEqual({ note: NOTE, current: {} });
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
