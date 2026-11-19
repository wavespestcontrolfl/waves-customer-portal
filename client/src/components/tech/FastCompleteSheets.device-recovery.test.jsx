// @vitest-environment jsdom
import React from 'react';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import FastCompleteSheet from './FastCompleteSheet';
import FastCompleteLawnReserviceSheet from './FastCompleteLawnReserviceSheet';
import FastCompleteTreeShrubSheet from './FastCompleteTreeShrubSheet';
import FastCompleteLawnSheet from './FastCompleteLawnSheet';
import FastCompleteAssessmentSheet from './FastCompleteAssessmentSheet';
import { getFastCompletionAttempt, putFastCompletionAttempt } from '../../lib/completion-resume-store';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

for (const [name, Sheet, reportFlow] of [
  ['report', FastCompleteSheet, true],
  ['lawn', FastCompleteLawnReserviceSheet, false],
  ['tree/shrub', FastCompleteTreeShrubSheet, false],
  ['lawn visit', FastCompleteLawnSheet, false],
  ['assessment', FastCompleteAssessmentSheet, false],
]) {
  test.each(['receipt', 'already_saved'])(`${name} recovery shows the saved result for %s while context is unavailable`, async (outcome) => {
    const body = { idempotencyKey: 'saved-key', technicianNotes: 'Retained exact work' };
    await putFastCompletionAttempt('visit-a', 'tech-a', { body, summary: 'Retained visit summary' });
    const request = vi.fn(async (path) => {
      if (!path.endsWith('/complete')) throw Object.assign(new Error('Context unavailable'), { status: 503 });
      if (outcome === 'already_saved') throw Object.assign(new Error('Already saved'), { status: 409, code: 'service_already_completed' });
      return { success: true, completionSmsStatus: 'deferred', invoiceId: 'invoice-a', invoiceStatus: 'paid' };
    });
    const completed = vi.fn();
    render(<Sheet service={{ id: 'visit-a', reportFlow }} operatorId="tech-a" request={request}
      onClose={vi.fn()} onCompleted={completed} onFullForm={vi.fn()} />);
    const retry = await screen.findByRole('button', { name: 'Retry', exact: true });
    expect(request.mock.calls.filter(([path]) => path.endsWith('/complete'))).toHaveLength(0);
    fireEvent.click(retry);
    const next = await screen.findByRole('button', { name: 'Next stop' });
    expect(screen.queryByRole('button', { name: 'Retry', exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText(/An unfinished completion/)).not.toBeInTheDocument();
    const posts = request.mock.calls.filter(([path]) => path.endsWith('/complete'));
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0][1].body)).toEqual(body);
    await waitFor(async () => expect((await getFastCompletionAttempt('visit-a', 'tech-a')).attempt).toBeNull());
    if (reportFlow && outcome === 'receipt') {
      expect(screen.getByText(/report is queued/)).toBeInTheDocument();
      expect(screen.getByText('Bill: paid.')).toBeInTheDocument();
    }
    fireEvent.click(next);
    expect(completed).toHaveBeenCalledTimes(1);
  });

  test(`${name} closes while a stalled device read is still checking (GitHub Codex P2 on #5972)`, async () => {
    // A storage open that never answers: the check never settles.
    globalThis.indexedDB = { open: () => ({}) };
    const onClose = vi.fn();
    const request = vi.fn(async () => { throw Object.assign(new Error('Context unavailable'), { status: 503 }); });
    render(<Sheet service={{ id: `visit-stall-${name}`, reportFlow }} operatorId="tech-stall" request={request}
      onClose={onClose} onCompleted={vi.fn()} onFullForm={vi.fn()} />);
    expect(await screen.findByText(/Checking for an unfinished completion/)).toBeInTheDocument();
    // The lawn visit sheet's header closes with Back.
    fireEvent.click(screen.getByRole('button', { name: Sheet === FastCompleteLawnSheet ? 'Back' : 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.filter(([path]) => path.endsWith('/complete'))).toHaveLength(0);
  });

  test(`${name} keeps the server's refusal on screen when the visit cannot load and the copy cleared (GitHub Codex P2 on #5972)`, async () => {
    const body = { idempotencyKey: 'saved-key', technicianNotes: 'Retained exact work' };
    await putFastCompletionAttempt('visit-a', 'tech-a', { body, summary: 'Retained visit summary' });
    const request = vi.fn(async (path) => {
      if (!path.endsWith('/complete')) throw Object.assign(new Error('Context unavailable'), { status: 503 });
      throw Object.assign(new Error('Changed'), { status: 409, code: 'idempotency_key_mismatch' });
    });
    render(<Sheet service={{ id: 'visit-a', reportFlow }} operatorId="tech-a" request={request}
      onClose={vi.fn()} onCompleted={vi.fn()} onFullForm={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry', exact: true }));
    expect(await screen.findByText(/Another completion for this visit/)).toBeInTheDocument();
    await waitFor(async () => expect((await getFastCompletionAttempt('visit-a', 'tech-a')).attempt).toBeNull());
    expect(screen.getByText(/Another completion for this visit/)).toBeInTheDocument();
  });

  test(`${name} waits on a saved attempt it cannot read, then shows it on Try again (GitHub Codex P2 on #6001)`, async () => {
    const body = { idempotencyKey: 'unread-key', technicianNotes: 'Unread work' };
    await putFastCompletionAttempt('visit-u', 'tech-a', { body, summary: 'Unread visit' });
    const store = globalThis.indexedDB;
    globalThis.indexedDB = undefined;
    const onFullForm = vi.fn();
    const request = vi.fn(async (path) => {
      if (path.endsWith('/complete')) return { success: true };
      throw Object.assign(new Error('Not this sheet'), { status: 404 });
    });
    render(<Sheet service={{ id: 'visit-u', reportFlow }} operatorId="tech-a" request={request}
      onClose={vi.fn()} onCompleted={vi.fn()} onFullForm={onFullForm} />);
    expect(await screen.findByText(/saved on this device but can’t be read right now/)).toBeInTheDocument();
    expect(onFullForm).not.toHaveBeenCalled();
    expect(request.mock.calls.filter(([path]) => path.endsWith('/complete'))).toHaveLength(0);
    globalThis.indexedDB = store;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Retry', exact: true })).toBeInTheDocument();
  });

  test(`${name} shows a refused copy found after a reload to discard only, then a fresh form (GitHub Codex P2 on #5967)`, async () => {
    const body = { idempotencyKey: 'refused-key', technicianNotes: 'Refused work' };
    await putFastCompletionAttempt('visit-a', 'tech-a', { body, summary: 'Refused visit', refused: true });
    const request = vi.fn(async () => { throw Object.assign(new Error('Context unavailable'), { status: 503 }); });
    render(<Sheet service={{ id: 'visit-a', reportFlow }} operatorId="tech-a" request={request}
      onClose={vi.fn()} onCompleted={vi.fn()} onFullForm={vi.fn()} />);
    expect(await screen.findByText(/server refused this saved completion/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry', exact: true })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard saved retry' }));
    await waitFor(() => expect(screen.queryByText(/server refused this saved completion/)).not.toBeInTheDocument());
    expect((await getFastCompletionAttempt('visit-a', 'tech-a')).attempt).toBeNull();
    expect(request.mock.calls.filter(([path]) => path.endsWith('/complete'))).toHaveLength(0);
  });

  test(`${name} keeps a refused completion whose copy will not clear, to discard (GitHub Codex P2 on 102b99cb1b)`, async () => {
    const body = { idempotencyKey: 'saved-key', technicianNotes: 'Retained exact work' };
    await putFastCompletionAttempt('visit-a', 'tech-a', { body, summary: 'Retained visit summary' });
    let refuse;
    const request = vi.fn((path) => {
      if (!path.endsWith('/complete')) return Promise.reject(Object.assign(new Error('Context unavailable'), { status: 503 }));
      return new Promise((_resolve, reject) => { refuse = () => reject(Object.assign(new Error('Changed'), { status: 409, code: 'idempotency_key_mismatch' })); });
    });
    render(<Sheet service={{ id: 'visit-a', reportFlow }} operatorId="tech-a" request={request}
      onClose={vi.fn()} onCompleted={vi.fn()} onFullForm={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry', exact: true }));
    await waitFor(() => expect(refuse).toBeTypeOf('function'));
    const store = globalThis.indexedDB;
    globalThis.indexedDB = undefined;
    try {
      refuse();
      expect(await screen.findByText(/could not clear its saved copy of this completion/)).toBeInTheDocument();
    } finally { globalThis.indexedDB = store; }
    fireEvent.click(screen.getByRole('button', { name: 'Discard saved retry' }));
    await waitFor(async () => expect((await getFastCompletionAttempt('visit-a', 'tech-a')).attempt).toBeNull());
    expect(screen.queryByRole('button', { name: 'Discard saved retry' })).not.toBeInTheDocument();
    expect(request.mock.calls.filter(([path]) => path.endsWith('/complete'))).toHaveLength(1);
  });

  test(`${name} says when this device could not clear the saved copy (GitHub Codex P2 on 0fdeda8a25)`, async () => {
    const body = { idempotencyKey: 'saved-key', technicianNotes: 'Retained exact work' };
    await putFastCompletionAttempt('visit-a', 'tech-a', { body, summary: 'Retained visit summary' });
    let release;
    const request = vi.fn((path) => {
      if (!path.endsWith('/complete')) return Promise.reject(Object.assign(new Error('Context unavailable'), { status: 503 }));
      return new Promise((resolve) => { release = () => resolve({ success: true }); });
    });
    render(<Sheet service={{ id: 'visit-a', reportFlow }} operatorId="tech-a" request={request}
      onClose={vi.fn()} onCompleted={vi.fn()} onFullForm={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry', exact: true }));
    await waitFor(() => expect(release).toBeTypeOf('function'));
    const store = globalThis.indexedDB;
    globalThis.indexedDB = undefined;
    try {
      release();
      expect(await screen.findByText(/could not clear its saved copy/)).toBeInTheDocument();
    } finally { globalThis.indexedDB = store; }
    expect(screen.getByRole('button', { name: 'Next stop' })).toBeInTheDocument();
    expect((await getFastCompletionAttempt('visit-a', 'tech-a')).attempt.body).toEqual(body);
  });
}


test('recovered confirmation shows a failed discard and retains the saved attempt', async () => {
  const body = { idempotencyKey: 'saved-key', technicianNotes: 'Retained work' };
  await putFastCompletionAttempt('visit-a', 'tech-a', { body, summary: 'Retained visit' });
  const request = vi.fn(async (path) => {
    if (!path.endsWith('/complete')) throw Object.assign(new Error('Context unavailable'), { status: 503 });
    throw Object.assign(new Error('Review report before sending'), { status: 409, code: 'report_rules_review' });
  });
  render(<FastCompleteSheet service={{ id: 'visit-a', reportFlow: true }} operatorId="tech-a"
    request={request} onClose={vi.fn()} onCompleted={vi.fn()} onFullForm={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry', exact: true }));
  const back = await screen.findByRole('button', { name: 'Go back' });
  const factory = globalThis.indexedDB;
  globalThis.indexedDB = undefined;
  try {
    fireEvent.click(back);
    expect(await screen.findByText(/Could not discard the saved completion/)).toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  } finally { globalThis.indexedDB = factory; }
  expect((await getFastCompletionAttempt('visit-a', 'tech-a')).attempt.body).toEqual(body);
  fireEvent.click(back);
  await waitFor(async () => expect((await getFastCompletionAttempt('visit-a', 'tech-a')).attempt).toBeNull());
  expect(request.mock.calls.filter(([path]) => path.endsWith('/complete'))).toHaveLength(1);
});

test('the lawn visit sheet holds its full-form hand-off while a saved attempt is shown, and tags the attempt as its own', async () => {
  const body = { idempotencyKey: 'lawn-key', technicianNotes: 'Lawn work' };
  await putFastCompletionAttempt('visit-l', 'tech-a', { body, summary: 'Lawn visit', sheet: 'lawn_visit' });
  const request = vi.fn(async () => { throw Object.assign(new Error('Not this sheet'), { status: 404 }); });
  const onFullForm = vi.fn();
  render(<FastCompleteLawnSheet service={{ id: 'visit-l' }} operatorId="tech-a" request={request}
    onClose={vi.fn()} onCompleted={vi.fn()} onFullForm={onFullForm} />);
  expect(await screen.findByRole('button', { name: 'Retry', exact: true })).toBeInTheDocument();
  expect(onFullForm).not.toHaveBeenCalled();
  expect((await getFastCompletionAttempt('visit-l', 'tech-a')).attempt.sheet).toBe('lawn_visit');
  fireEvent.click(screen.getByRole('button', { name: 'Discard saved retry' }));
  await waitFor(() => expect(onFullForm).toHaveBeenCalledTimes(1));
  expect(request.mock.calls.filter(([path]) => path.endsWith('/complete'))).toHaveLength(0);
});

// `collectOnSheet` (the Today page, which opens no payment prompt of its own):
// the saved view offers Take payment now for a bill the completion says is
// owed and whose pay link did not go out. Without it (admin Dispatch, whose
// prompt takes the response) the view offers none.
for (const [name, Sheet] of [['tree/shrub', FastCompleteTreeShrubSheet], ['lawn visit', FastCompleteLawnSheet]]) {
  test.each([true, false])(`${name} saved view offers Take payment now for an owed bill only with collectOnSheet (%s)`, async (collectOnSheet) => {
    const body = { idempotencyKey: 'owed-key', technicianNotes: 'Work done' };
    await putFastCompletionAttempt('visit-owed', 'tech-a', { body, summary: 'Owed visit' });
    const request = vi.fn(async (path) => {
      if (!path.endsWith('/complete')) throw Object.assign(new Error('Context unavailable'), { status: 503 });
      // The text with the pay link failed: the bill is still owed on the spot.
      return {
        success: true, invoiceId: 'inv-owed', invoiceToken: 'tok-owed', invoiceTotal: 120, invoiceStatus: 'sent',
        invoicePaymentActionRequired: true, completionSmsStatus: 'failed', completionSmsType: 'service_complete_with_invoice',
      };
    });
    render(<Sheet service={{ id: 'visit-owed' }} operatorId="tech-a" request={request} collectOnSheet={collectOnSheet}
      onClose={vi.fn()} onCompleted={vi.fn()} onFullForm={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry', exact: true }));
    await screen.findByRole('button', { name: 'Next stop' });
    if (collectOnSheet) expect(screen.getByRole('button', { name: /Take payment now/ })).toBeInTheDocument();
    else expect(screen.queryByRole('button', { name: /Take payment now/ })).not.toBeInTheDocument();
  });
}

// Today's off-route saved attempt (`recoveryOnly`): the row holds only the
// visit id and summary, so a discard leaves a notice: no fresh form, and no
// full-form hand-off with no day or premise to open it on.
// A retry the server refuses clears the saved copy: the off-route view keeps
// the server's reason above the way back to the schedule, for a refusal for
// good (409) and a correctable rejection (422) alike.
test.each([
  ['refused for good', 409, 'visit_closed', 'This visit is closed.'],
  ['a correctable rejection', 422, 'invalid_product', 'A product on this completion is not on the lawn list.'],
])('the lawn visit sheet on an off-route saved attempt keeps the reason when its retry is %s', async (_label, status, code, message) => {
  const body = { idempotencyKey: `lawn-off-${status}`, technicianNotes: 'Lawn work' };
  await putFastCompletionAttempt('visit-off', 'tech-a', { body, summary: 'Lawn visit', sheet: 'lawn_visit' });
  const request = vi.fn(async (path) => {
    if (!path.endsWith('/complete')) throw Object.assign(new Error('Not this sheet'), { status: 404 });
    throw Object.assign(new Error(message), { status, code });
  });
  const onFullForm = vi.fn();
  render(<FastCompleteLawnSheet service={{ id: 'visit-off', recoveryOnly: true }} operatorId="tech-a" request={request} catalog={[]}
    onClose={vi.fn()} onCompleted={vi.fn()} onFullForm={onFullForm} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry', exact: true }));
  expect(await screen.findByText(message)).toBeInTheDocument();
  expect(screen.getByText(/No saved completion is left for this visit/)).toBeInTheDocument();
  await waitFor(async () => expect((await getFastCompletionAttempt('visit-off', 'tech-a')).attempt).toBeNull());
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(onFullForm).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: /Complete/ })).not.toBeInTheDocument();
  expect(request.mock.calls.filter(([path]) => path.endsWith('/complete'))).toHaveLength(1);
});

// A correctable rejection whose saved copy this device could not clear: the
// off-route view has no form to fix it, so it keeps the copy to discard
// (never to retry), under the server's reason, until the delete lands.
test('the lawn visit sheet on an off-route saved attempt keeps a rejected copy that will not clear, to discard', async () => {
  const body = { idempotencyKey: 'lawn-off-kept', technicianNotes: 'Lawn work' };
  await putFastCompletionAttempt('visit-off', 'tech-a', { body, summary: 'Lawn visit', sheet: 'lawn_visit' });
  const message = 'A product on this completion is not on the lawn list.';
  let rejectSend;
  const request = vi.fn((path) => {
    if (!path.endsWith('/complete')) return Promise.reject(Object.assign(new Error('Not this sheet'), { status: 404 }));
    return new Promise((_resolve, reject) => { rejectSend = () => reject(Object.assign(new Error(message), { status: 422, code: 'invalid_product' })); });
  });
  render(<FastCompleteLawnSheet service={{ id: 'visit-off', recoveryOnly: true }} operatorId="tech-a" request={request} catalog={[]}
    onClose={vi.fn()} onCompleted={vi.fn()} onFullForm={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry', exact: true }));
  await waitFor(() => expect(rejectSend).toBeTypeOf('function'));
  const store = globalThis.indexedDB;
  globalThis.indexedDB = undefined;
  try {
    rejectSend();
    expect(await screen.findByText(/could not clear its saved copy of this completion/)).toBeInTheDocument();
  } finally { globalThis.indexedDB = store; }
  expect(screen.getByText(message)).toBeInTheDocument();
  expect(screen.queryByText(/No saved completion is left/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Retry', exact: true })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Retry completion/ })).not.toBeInTheDocument();
  expect((await getFastCompletionAttempt('visit-off', 'tech-a')).attempt.body).toEqual(body);
  fireEvent.click(screen.getByRole('button', { name: 'Discard saved retry' }));
  await waitFor(async () => expect((await getFastCompletionAttempt('visit-off', 'tech-a')).attempt).toBeNull());
  expect(await screen.findByText(/No saved completion is left for this visit/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Discard saved retry' })).not.toBeInTheDocument();
  expect(request.mock.calls.filter(([path]) => path.endsWith('/complete'))).toHaveLength(1);
});

test('the lawn visit sheet on an off-route saved attempt shows a notice after a discard, never a fresh form or the hand-off', async () => {
  const body = { idempotencyKey: 'lawn-off-key', technicianNotes: 'Lawn work' };
  await putFastCompletionAttempt('visit-off', 'tech-a', { body, summary: 'Lawn visit', sheet: 'lawn_visit' });
  const request = vi.fn(async () => { throw Object.assign(new Error('Not this sheet'), { status: 404 }); });
  const onFullForm = vi.fn();
  render(<FastCompleteLawnSheet service={{ id: 'visit-off', recoveryOnly: true }} operatorId="tech-a" request={request} catalog={[]}
    onClose={vi.fn()} onCompleted={vi.fn()} onFullForm={onFullForm} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Discard saved retry' }));
  expect(await screen.findByText(/No saved completion is left for this visit/)).toBeInTheDocument();
  await waitFor(async () => expect((await getFastCompletionAttempt('visit-off', 'tech-a')).attempt).toBeNull());
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(onFullForm).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: /Complete/ })).not.toBeInTheDocument();
  expect(request.mock.calls.filter(([path]) => path.endsWith('/complete'))).toHaveLength(0);
});

// A visit the lawn sheet hands to the full form (its context says the sheet
// does not take it): the server's refusal of a saved attempt's retry stays on
// screen instead of the hand-off hiding it. A correctable rejection with no
// copy left opens the full form on a tap, to fix it there; a request refused
// for good offers no form.
test.each([
  ['a correctable rejection', 422, 'invalid_product', 'A product on this completion is not on the lawn list.', true],
  ['refused for good', 409, 'visit_closed', 'This visit is closed.', false],
])('the lawn visit sheet keeps %s of a saved retry on screen on a visit it hands to the full form', async (_label, status, code, message, fixable) => {
  const body = { idempotencyKey: `lawn-held-${status}`, technicianNotes: 'Lawn work' };
  await putFastCompletionAttempt('visit-h', 'tech-a', { body, summary: 'Lawn visit', sheet: 'lawn_visit' });
  const request = vi.fn(async (path) => {
    if (!path.endsWith('/complete')) throw Object.assign(new Error('Not this sheet'), { status: 404 });
    throw Object.assign(new Error(message), { status, code });
  });
  const onFullForm = vi.fn();
  render(<FastCompleteLawnSheet service={{ id: 'visit-h' }} operatorId="tech-a" request={request} catalog={[]}
    onClose={vi.fn()} onCompleted={vi.fn()} onFullForm={onFullForm} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry', exact: true }));
  expect(await screen.findByText(message)).toBeInTheDocument();
  await waitFor(async () => expect((await getFastCompletionAttempt('visit-h', 'tech-a')).attempt).toBeNull());
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(onFullForm).not.toHaveBeenCalled();
  expect(screen.getByText(message)).toBeInTheDocument();
  expect(screen.queryByText(/Opening the full form/)).not.toBeInTheDocument();
  if (fixable) {
    fireEvent.click(screen.getByRole('button', { name: 'Full form' }));
    expect(onFullForm).toHaveBeenCalledTimes(1);
  } else {
    expect(screen.queryByRole('button', { name: 'Full form' })).not.toBeInTheDocument();
  }
  expect(request.mock.calls.filter(([path]) => path.endsWith('/complete'))).toHaveLength(1);
});

// The same hand-off visit, with a rejected copy this device could not clear:
// the copy waits to be discarded (never retried) under the server's reason,
// and the hand-off runs only once the discard lands.
test('the lawn visit sheet hands a visit to the full form only after a rejected copy that would not clear is discarded', async () => {
  const body = { idempotencyKey: 'lawn-held-kept', technicianNotes: 'Lawn work' };
  await putFastCompletionAttempt('visit-h', 'tech-a', { body, summary: 'Lawn visit', sheet: 'lawn_visit' });
  const message = 'A product on this completion is not on the lawn list.';
  let rejectSend;
  const request = vi.fn((path) => {
    if (!path.endsWith('/complete')) return Promise.reject(Object.assign(new Error('Not this sheet'), { status: 404 }));
    return new Promise((_resolve, reject) => { rejectSend = () => reject(Object.assign(new Error(message), { status: 422, code: 'invalid_product' })); });
  });
  const onFullForm = vi.fn();
  render(<FastCompleteLawnSheet service={{ id: 'visit-h' }} operatorId="tech-a" request={request} catalog={[]}
    onClose={vi.fn()} onCompleted={vi.fn()} onFullForm={onFullForm} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry', exact: true }));
  await waitFor(() => expect(rejectSend).toBeTypeOf('function'));
  const store = globalThis.indexedDB;
  globalThis.indexedDB = undefined;
  try {
    rejectSend();
    expect(await screen.findByText(/could not clear its saved copy of this completion/)).toBeInTheDocument();
  } finally { globalThis.indexedDB = store; }
  expect(screen.getByText(message)).toBeInTheDocument();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(onFullForm).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Full form' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Retry', exact: true })).not.toBeInTheDocument();
  expect((await getFastCompletionAttempt('visit-h', 'tech-a')).attempt.body).toEqual(body);
  fireEvent.click(screen.getByRole('button', { name: 'Discard saved retry' }));
  await waitFor(() => expect(onFullForm).toHaveBeenCalledTimes(1));
  expect((await getFastCompletionAttempt('visit-h', 'tech-a')).attempt).toBeNull();
  expect(request.mock.calls.filter(([path]) => path.endsWith('/complete'))).toHaveLength(1);
});

// The Waves Assessment sheet saves its attempt under its own tag, so the Today
// page reopens it in this sheet (useSavedFastCompletions), not the pest one.
test('the assessment sheet tags its saved attempt as its own', async () => {
  const request = vi.fn(async (path) => {
    if (path.endsWith('/outcome')) throw Object.assign(new Error('No outcome recorded for that visit'), { status: 404 });
    // The send's outcome is unknown: the saved copy stays for a same-key retry.
    if (path.endsWith('/complete')) throw new TypeError('Failed to fetch');
    return {};
  });
  render(<FastCompleteAssessmentSheet service={{ id: 'visit-as', serviceType: 'Waves Assessment' }} operatorId="tech-a" request={request}
    onClose={vi.fn()} onCompleted={vi.fn()} onFullForm={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Warm' }));
  fireEvent.change(screen.getByLabelText('Tell me about the visit'), { target: { value: 'Walked the yard with the owner.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Complete assessment' }));
  expect(await screen.findByRole('button', { name: 'Retry', exact: true })).toBeInTheDocument();
  const saved = (await getFastCompletionAttempt('visit-as', 'tech-a')).attempt;
  expect(saved.sheet).toBe('assessment');
  expect(saved.body.technicianNotes).toBe('Walked the yard with the owner.');
});

// The Today page opens the assessment sheet for a saved attempt alone
// (`recoveryOnly`): no Full form, and once the attempt is gone, the notice
// instead of a fresh form; a rejected retry keeps the server's reason.
test.each([
  ['a discard', null],
  ['a correctable rejection of its retry', 422],
])('the assessment sheet for a saved attempt alone shows no fresh form after %s', async (_label, status) => {
  const body = { idempotencyKey: `as-alone-${status}`, technicianNotes: 'Assessment work' };
  await putFastCompletionAttempt('visit-as', 'tech-a', { body, summary: 'Waves Assessment', sheet: 'assessment' });
  const message = 'Pick how the visit went.';
  const request = vi.fn(async (path) => {
    if (path.endsWith('/outcome')) throw Object.assign(new Error('No outcome recorded for that visit'), { status: 404 });
    if (path.endsWith('/complete')) throw Object.assign(new Error(message), { status, code: 'consultation_outcome_invalid' });
    return {};
  });
  render(<FastCompleteAssessmentSheet service={{ id: 'visit-as', recoveryOnly: true }} operatorId="tech-a" request={request}
    onClose={vi.fn()} onCompleted={vi.fn()} />);
  expect(await screen.findByRole('button', { name: 'Retry', exact: true })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Full form' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: status ? 'Retry' : 'Discard saved retry', exact: true }));
  expect(await screen.findByText(/No saved completion is left for this visit/)).toBeInTheDocument();
  await waitFor(async () => expect((await getFastCompletionAttempt('visit-as', 'tech-a')).attempt).toBeNull());
  await new Promise((resolve) => setTimeout(resolve, 20));
  if (status) expect(screen.getByText(message)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Warm' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Complete assessment' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Full form' })).not.toBeInTheDocument();
  expect(request.mock.calls.filter(([path]) => path.endsWith('/complete'))).toHaveLength(status ? 1 : 0);
});

// An on-route lawn visit whose product list could not be read (the form
// waits on it): a saved attempt's retry the server refuses keeps its reason
// above the catalog message, and a rejected copy this device could not clear
// waits there to be discarded, never retried.
const LAWN_VISIT = {
  id: 'visit-c', customerId: 'cust-fixture', customerName: 'Fixture Customer', serviceType: 'Lawn Care', status: 'confirmed',
  scheduledDate: '2026-10-04T13:00:00.000Z', propertyId: 'prop-fixture', catalogServiceId: null,
  address: { line1: '100 Example Lane', line2: null, city: 'Bradenton', state: 'FL', zip: '34205' },
  hasPhone: true, category: 'lawn_care', serviceKey: 'lawn_care_recurring', isCallback: false, technicianId: null,
};
const LAWN_SERVICE = {
  id: 'visit-c', customerName: 'Fixture Customer', serviceType: 'Lawn Care', address: '100 Example Lane', timeLabel: '2:00 PM',
  findingsType: null, routedCustomerId: 'cust-fixture', routedScheduledDate: '2026-10-04', routedPropertyId: 'prop-fixture', routedAddress: '100 Example Lane',
};
const LAWN_CONTEXT = {
  enabled: true, eligible: true, reason: null, visitType: 'recurring', findingsType: null, service: LAWN_VISIT,
  visitDate: '2026-10-04', turfHeightCapture: false, plannedProducts: { source: 'plan', items: [] }, plannedProductsUnavailable: null,
  methods: [{ value: 'spot_treatment', label: 'Spot treatment', common: true, requiresSqft: false }],
  assessment: { exists: false, id: null, confirmed: false }, photoStatus: null, previousFrontPhoto: null, readFailures: [],
};
const CATALOG_ERROR = 'Could not load the product list. Close this, check your signal, then tap Report again.';

test.each([false, true])('the lawn visit sheet keeps a refused retry above a product list it could not read (copy kept: %s)', async (kept) => {
  const body = { idempotencyKey: `lawn-catalog-${kept}`, technicianNotes: 'Lawn work' };
  await putFastCompletionAttempt('visit-c', 'tech-a', { body, summary: 'Lawn visit', sheet: 'lawn_visit' });
  const message = 'A product on this completion is not on the lawn list.';
  let rejectSend;
  const request = vi.fn((path) => {
    if (path.includes('/lawn-fast/context')) return Promise.resolve(LAWN_CONTEXT);
    if (!path.endsWith('/complete')) return Promise.resolve({});
    return new Promise((_resolve, reject) => { rejectSend = () => reject(Object.assign(new Error(message), { status: 422, code: 'invalid_product' })); });
  });
  const onFullForm = vi.fn();
  render(<FastCompleteLawnSheet service={LAWN_SERVICE} operatorId="tech-a" request={request} catalog={null} catalogError={CATALOG_ERROR}
    onClose={vi.fn()} onCompleted={vi.fn()} onFullForm={onFullForm} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry', exact: true }));
  await waitFor(() => expect(rejectSend).toBeTypeOf('function'));
  const store = globalThis.indexedDB;
  if (kept) globalThis.indexedDB = undefined;
  try {
    rejectSend();
    expect(await screen.findByText(message)).toBeInTheDocument();
    if (kept) expect(await screen.findByText(/could not clear its saved copy of this completion/)).toBeInTheDocument();
  } finally { globalThis.indexedDB = store; }
  expect(screen.getByText(CATALOG_ERROR)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Retry', exact: true })).not.toBeInTheDocument();
  if (kept) {
    expect((await getFastCompletionAttempt('visit-c', 'tech-a')).attempt.body).toEqual(body);
    fireEvent.click(screen.getByRole('button', { name: 'Discard saved retry' }));
    await waitFor(async () => expect((await getFastCompletionAttempt('visit-c', 'tech-a')).attempt).toBeNull());
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Discard saved retry' })).not.toBeInTheDocument());
    expect(screen.getByText(CATALOG_ERROR)).toBeInTheDocument();
  } else {
    await waitFor(async () => expect((await getFastCompletionAttempt('visit-c', 'tech-a')).attempt).toBeNull());
    expect(screen.queryByRole('button', { name: 'Discard saved retry' })).not.toBeInTheDocument();
  }
  expect(onFullForm).not.toHaveBeenCalled();
  expect(request.mock.calls.filter(([path]) => path.endsWith('/complete'))).toHaveLength(1);
});
