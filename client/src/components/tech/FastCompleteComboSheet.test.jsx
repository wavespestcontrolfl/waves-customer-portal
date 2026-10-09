// @vitest-environment jsdom
// The pest + lawn container (GATE_COMBO_FAST_COMPLETE): the onPrepared seq contract, "Complete stop" and its packet request,
// the confirm prompts, a lost response, a reload, and a server refusal. The two parts are stubs that hand up bodies the
// way the real sheets do (the sheets themselves are covered by their own suites). Synthetic ids only.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import React, { useEffect, useRef, useState } from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FastCompleteComboSheet from './FastCompleteComboSheet';
import { adminFetch } from '../../utils/admin-fetch';
import * as store from '../../lib/completion-resume-store';

vi.mock('../../utils/admin-fetch', () => ({ adminFetch: vi.fn() }));
vi.mock('../../pages/admin/SchedulePage', () => ({
  createCompletionIdempotencyKey: (id) => `key_${id}`,
  completionReconcilePrompt: (error) => (error.code === 'report_reconcile' ? 'Confirm recorded values' : null),
  completionReportRulesPrompt: (error) => (error.code === 'report_rules_review' ? 'Send report as is' : null),
  completionPromiseMarksPrompt: (error) => (error.code === 'promise_marks_changed' ? 'A promise you marked changed' : null),
}));
// A part: shows the shared note it was given, and hands bodies up on demand (and, like the real sheets, drops its body
// when told to by the test).
const partCalls = { pest: [], lawn: [] };
function stubPart(kind) {
  return function Part({ service, onPrepared, sharedNote, embedded, onFullForm }) {
    const [last, setLast] = useState('');
    const send = async (body, seq) => {
      partCalls[kind].push({ body, seq });
      try { await onPrepared(service.id, body, seq); setLast(`ok ${seq}`); } catch (err) { setLast(`rejected: ${err.message}`); }
    };
    // Like the real pest part: once saved, a changed shared note makes the report stale, and the part un-saves itself.
    const saved = useRef(false);
    const seenNote = useRef(sharedNote);
    saved.current = partCalls[kind].some((call) => call.body) && !partCalls[kind].at(-1)?.unsaved;
    useEffect(() => {
      if (seenNote.current !== sharedNote && kind === 'pest' && saved.current) {
        partCalls[kind].push({ body: null, unsaved: true, seq: 0 });
        void onPrepared(service.id, null, window.__seq = (window.__seq || 0) + 1);
      }
      seenNote.current = sharedNote;
    });
    return (
      <div data-testid={`${kind}-part`} data-embedded={String(embedded)}>
        {kind} part sees note "{sharedNote}" {last}
        <button type="button" onClick={() => send({ visitOutcome: 'completed', kind, n: 1 }, window.__seq = (window.__seq || 0) + 1)}>{kind} save</button>
        <button type="button" onClick={() => send(null, window.__seq = (window.__seq || 0) + 1)}>{kind} unsave</button>
        <button type="button" onClick={() => send({ visitOutcome: 'completed', kind, n: 0 }, 1)}>{kind} late old</button>
        <button type="button" onClick={onFullForm}>{kind} needs full form</button>
      </div>
    );
  };
}
vi.mock('./FastCompleteSheet', () => ({ default: (props) => stubPart('pest')(props) }));
vi.mock('./FastCompleteLawnSheet', () => ({ default: (props) => stubPart('lawn')(props) }));
vi.mock('../../hooks/useIsMobile', () => ({ default: () => true }));

const PEST = { id: 'svc-pest', customerName: 'Fixture Customer', address: '100 Example Lane', serviceType: 'Quarterly Pest Control', reportFlow: true };
const LAWN = { id: 'svc-lawn', customerName: 'Fixture Customer', address: '100 Example Lane', serviceType: 'Lawn Care' };
const members = [
  { id: 'svc-lawn', serviceType: 'Lawn Care', status: 'on_site', requiresForm: true },
  { id: 'svc-pest', serviceType: 'Quarterly Pest Control', status: 'on_site', requiresForm: true },
];
const rows = [{ id: 'svc-lawn', visitId: 'visit' }, { id: 'svc-pest', visitId: 'visit' }];
let detail;
let post;
const onSaved = vi.fn();
const onClose = vi.fn();
const onFullForm = vi.fn();

function mount() {
  return render(<FastCompleteComboSheet visitId="visit" pest={{ service: PEST }} lawn={{ service: LAWN }} request={vi.fn()} operatorId="op-1" catalog={[]} onClose={onClose} onSaved={onSaved} onFullForm={onFullForm} />);
}
const click = (name) => fireEvent.click(screen.getByRole('button', { name }));
const completeStop = () => screen.getByRole('button', { name: /Complete stop|Resume closeout/ });
async function prepareBoth() {
  await screen.findByTestId('pest-part');
  click('pest save');
  click('lawn save');
  await waitFor(() => expect(completeStop()).toBeEnabled());
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'op-1', role: 'technician' }));
  window.__seq = 0;
  partCalls.pest = []; partCalls.lawn = [];
  detail = { visitId: 'visit', serviceDate: '2020-01-01', members, packet: null };
  post = vi.fn(async () => ({ packetId: 'packet', state: 'done' }));
  adminFetch.mockReset().mockImplementation(async (path, options) => {
    if (options?.method === 'POST') return post(path, options);
    if (path.startsWith('/admin/schedule?')) return { services: rows };
    return detail;
  });
  onSaved.mockClear(); onClose.mockClear(); onFullForm.mockClear();
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

describe('the container', () => {
  it('embeds both parts, gives them the one note, and keeps Complete stop off until both are saved', async () => {
    mount();
    await screen.findByTestId('pest-part');
    expect(screen.getByTestId('pest-part')).toHaveAttribute('data-embedded', 'true');
    expect(screen.getByTestId('lawn-part')).toHaveAttribute('data-embedded', 'true');
    expect(completeStop()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: 'Ants by the door, lawn thin' } });
    expect(screen.getByTestId('pest-part')).toHaveTextContent('Ants by the door, lawn thin');
    expect(screen.getByTestId('lawn-part')).toHaveTextContent('Ants by the door, lawn thin');
    click('pest save');
    await screen.findAllByText('Saved for this stop');
    expect(completeStop()).toBeDisabled();
    expect(screen.getByText(/Lawn part: not saved yet/)).toBeInTheDocument();
    click('lawn save');
    await waitFor(() => expect(completeStop()).toBeEnabled());
  });

  it('a note edit after saving un-saves the pest part and says so plainly; Complete stop is blocked until it is saved again', async () => {
    mount();
    await prepareBoth();
    fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: 'A wasp nest by the garage' } });
    await waitFor(() => expect(completeStop()).toBeDisabled());
    expect(screen.getByText(/Pest part: changed, save it again/)).toBeInTheDocument();
    expect(screen.getByText('Pest part changed. Save it again below.')).toBeInTheDocument();
    click('pest save');
    await waitFor(() => expect(completeStop()).toBeEnabled());
  });

  it('applies a call only if its seq is greater than the last applied for that service; a null drops the body and blocks Complete stop', async () => {
    mount();
    await prepareBoth();
    // An older call arriving late changes nothing.
    click('pest late old');
    await waitFor(() => expect(partCalls.pest.at(-1).seq).toBe(1));
    const stored = await store.getVisitCompletionDraft('visit', 'op-1');
    expect(stored.forms['svc-pest'].body).toMatchObject({ n: 1 });
    // A newer null drops it.
    click('pest unsave');
    await waitFor(() => expect(completeStop()).toBeDisabled());
    expect(screen.getByText(/Pest part: changed, save it again/)).toBeInTheDocument();
    expect((await store.getVisitCompletionDraft('visit', 'op-1')).forms['svc-pest']).toBeUndefined();
    // Saving again brings it back.
    click('pest save');
    await waitFor(() => expect(completeStop()).toBeEnabled());
  });

  it('a call that cannot be saved on the device rejects, and the part stays not ready', async () => {
    mount();
    await screen.findByTestId('pest-part');
    vi.spyOn(store, 'putVisitCompletionDraft').mockResolvedValueOnce(false);
    click('pest save');
    await screen.findByText(/rejected: Could not save this part on this device/);
    click('lawn save');
    await waitFor(() => expect(screen.getByText(/Pest part: not saved yet/)).toBeInTheDocument());
    expect(completeStop()).toBeDisabled();
  });

  it('posts the stop once: { items } from the two saved bodies in member order, with the draft\'s idempotency key', async () => {
    mount();
    await prepareBoth();
    click('Complete stop');
    await screen.findByText(/Stop recorded/);
    expect(post).toHaveBeenCalledTimes(1);
    const [path, options] = post.mock.calls[0];
    expect(path).toBe('/admin/visit-closeouts/visit');
    expect(options.headers['Idempotency-Key']).toBe('key_visit');
    expect(JSON.parse(options.body)).toEqual({ items: [
      { serviceId: 'svc-lawn', body: { visitOutcome: 'completed', kind: 'lawn', n: 1 } },
      { serviceId: 'svc-pest', body: { visitOutcome: 'completed', kind: 'pest', n: 1 } },
    ] });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    // Recorded: the saved draft is gone.
    await waitFor(async () => expect(await store.getVisitCompletionDraft('visit', 'op-1')).toBeFalsy());
  });

  it('a lost response sends the same key and bodies again', async () => {
    post.mockRejectedValueOnce(Object.assign(new TypeError('Failed to fetch')));
    mount();
    await prepareBoth();
    click('Complete stop');
    await screen.findByText(/Connection interrupted/);
    await waitFor(() => expect(completeStop()).toBeEnabled());
    click('Complete stop');
    await screen.findByText(/Stop recorded/);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][1].headers['Idempotency-Key']).toBe(post.mock.calls[0][1].headers['Idempotency-Key']);
    expect(post.mock.calls[1][1].body).toBe(post.mock.calls[0][1].body);
  });

  it('a packet that started on the server turns the button into Resume closeout', async () => {
    post.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    mount();
    await prepareBoth();
    detail = { ...detail, packet: { id: 'packet', status: 'processing' } };
    click('Complete stop');
    await screen.findByRole('button', { name: 'Resume closeout' });
    click('Resume closeout');
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][0]).toBe('/admin/visit-closeouts/visit/resume');
  });

  it.each([
    ['report_reconcile', 'reportReconcileConfirmed'],
    ['report_rules_review', 'reportRulesConfirmed'],
    ['promise_marks_changed', 'promiseMarksConfirmed'],
  ])('the %s prompt: OK sends that member again with %s under the same key', async (code, flag) => {
    post.mockRejectedValueOnce(Object.assign(new Error('review'), { code, details: { serviceId: 'svc-pest' } }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mount();
    await prepareBoth();
    click('Complete stop');
    await screen.findByText(/Stop recorded/);
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(2);
    const sent = JSON.parse(post.mock.calls[1][1].body).items.find((item) => item.serviceId === 'svc-pest');
    expect(sent.body[flag]).toBe(true);
    expect(post.mock.calls[1][1].headers['Idempotency-Key']).toBe('key_visit');
  });

  it('declining a changed-promise prompt puts that part back to be marked again', async () => {
    post.mockRejectedValueOnce(Object.assign(new Error('review'), { code: 'promise_marks_changed', details: { serviceId: 'svc-pest' } }));
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    mount();
    await prepareBoth();
    click('Complete stop');
    await screen.findByText(/A promise changed\. Open that service again/);
    expect(post).toHaveBeenCalledTimes(1);
    expect(completeStop()).toBeDisabled();
    expect((await store.getVisitCompletionDraft('visit', 'op-1')).forms['svc-pest'].body).toBeNull();
  });

  it('a reload restores the saved bodies: the parts show as saved, Complete stop is on, and Edit this part drops one', async () => {
    const first = mount();
    await prepareBoth();
    first.unmount();
    mount();
    await screen.findAllByText('Saved earlier on this device. Edit it to change anything.');
    expect(screen.queryByTestId('pest-part')).not.toBeInTheDocument();
    await waitFor(() => expect(completeStop()).toBeEnabled());
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit this part' })[0]);
    await waitFor(() => expect(completeStop()).toBeDisabled());
    await screen.findByTestId('pest-part');
    expect(screen.queryByTestId('lawn-part')).not.toBeInTheDocument();
  });

  it('a server refusal shows its reason and Full form, and never leaves the tech stuck', async () => {
    post.mockRejectedValueOnce(Object.assign(new Error('This visit cannot be completed on the quick sheet.'), {
      code: 'lawn_fast_not_eligible', details: { reason: 'grouped_visit', serviceId: 'svc-lawn' },
    }));
    mount();
    await prepareBoth();
    click('Complete stop');
    await waitFor(() => expect(screen.getAllByRole('alert').some((node) => /cannot be completed on the quick sheet/.test(node.textContent))).toBe(true));
    expect(completeStop()).toBeDisabled();
    // The card beside the reason and the header both offer it.
    const buttons = screen.getAllByRole('button', { name: 'Full form' });
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(onFullForm).toHaveBeenCalledTimes(1));
    // The long form starts clean: the short screen's saved bodies are gone.
    expect(await store.getVisitCompletionDraft('visit', 'op-1')).toBeFalsy();
  });

  it('a part that says it needs the long form shows the reason and Full form', async () => {
    mount();
    await screen.findByTestId('lawn-part');
    click('lawn needs full form');
    expect(await screen.findByRole('alert')).toHaveTextContent('needs the long form');
    expect(completeStop()).toBeDisabled();
  });

  it('a stop that is no longer exactly this pair goes to the long form', async () => {
    detail = { ...detail, members: [...members, { id: 'svc-third', serviceType: 'Mosquito', status: 'on_site', requiresForm: true }] };
    adminFetch.mockImplementation(async (path) => (path.startsWith('/admin/schedule?') ? { services: [...rows, { id: 'svc-third', visitId: 'visit' }] } : detail));
    mount();
    expect(await screen.findByText(/This stop changed since the schedule loaded/)).toBeInTheDocument();
    expect(screen.queryByTestId('pest-part')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Full form' }).length).toBeGreaterThan(0);
  });
});

