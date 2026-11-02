// @vitest-environment jsdom
// Set texts (GATE_TECH_SET_TEXTS): with the gate on, the line lists fixed-
// wording texts. A tap confirms the customer and the text, posts only the kind
// for THIS visit, and shows what went out; the Last reply card reads the
// customer's answer for this visit, or says it can't be matched.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import VisitBriefPanel from './VisitBriefPanel';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const SERVICE = {
  id: '11111111-1111-4111-8111-111111111111',
  status: 'confirmed',
  customerName: 'Pat Sample',
  customerPhone: '(941) 555-0100',
  address: '123 Palm Ave, Bradenton, FL 34205',
  serviceType: 'Quarterly Pest Control',
};
const stopFor = (service) => ({ key: 'row:1', isVisit: false, services: [service], primary: service, liveCount: 1 });
const detail = { status: 'ready', byService: {} };
const OPTIONS = [
  { kind: 'gate_locked', label: 'Back gate locked' },
  { kind: 'dog_outside', label: 'Dog outside' },
  { kind: 'garage_access', label: 'Need garage access' },
];
const LINE = { line: { number: '+19413529161', formatted: '(941) 352-9161', label: 'Tech line 1' }, canCall: true };
const SENT_BODY = "Hi Pat, your back gate is locked. If you can unlock it in the next few minutes, reply here and we'll treat the backyard before we leave.";
const NONE = { setText: null, reply: null, ambiguous: false };
const SET_TEXT = { kind: 'gate_locked', label: 'Back gate locked', sentAt: '2026-11-02T15:00:00Z' };

function makeRequest({ replies = () => NONE, send = async () => ({ success: true, kind: 'gate_locked', body: SENT_BODY }) } = {}) {
  return vi.fn(async (path) => {
    if (path.startsWith('/tech/line/replies')) return replies();
    if (path === '/tech/line/set-text') return send();
    return {};
  });
}
const replyCalls = (request) => request.mock.calls.filter(([p]) => p.startsWith('/tech/line/replies'));

describe('VisitBriefPanel — set texts', () => {
  it('without set texts on the line: no buttons and no reply lookup', async () => {
    const request = makeRequest();
    await act(async () => { render(<VisitBriefPanel stop={stopFor(SERVICE)} detail={detail} techLine={LINE} request={request} />); });
    expect(screen.queryByTestId('set-text-row')).not.toBeInTheDocument();
    expect(replyCalls(request)).toHaveLength(0);
  });

  it('a tap confirms the customer and the text, then posts only the kind for this visit and shows what went out', async () => {
    const request = makeRequest();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await act(async () => { render(<VisitBriefPanel stop={stopFor(SERVICE)} detail={detail} techLine={{ ...LINE, setTexts: OPTIONS }} request={request} />); });
    expect(screen.getByTestId('set-text-row')).toHaveTextContent('Set texts from your line');
    expect(replyCalls(request)).toHaveLength(1);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Back gate locked' })); });
    expect(window.confirm).toHaveBeenCalledWith('Text Pat Sample "Back gate locked" from (941) 352-9161?');
    expect(request).toHaveBeenCalledWith('/tech/line/set-text', {
      method: 'POST',
      body: JSON.stringify({ scheduledServiceId: SERVICE.id, kind: 'gate_locked' }),
    });
    expect(await screen.findByRole('status')).toHaveTextContent(`Sent: ${SENT_BODY}`);
    // The Last reply card reads again after a send.
    expect(replyCalls(request)).toHaveLength(2);
    expect(replyCalls(request)[1][0]).toBe(`/tech/line/replies?scheduledServiceId=${SERVICE.id}`);
  });

  it('a declined confirm sends nothing; a refusal shows inline', async () => {
    const request = makeRequest({ send: async () => { throw new Error('This text just went out to the customer'); } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await act(async () => { render(<VisitBriefPanel stop={stopFor(SERVICE)} detail={detail} techLine={{ ...LINE, setTexts: OPTIONS }} request={request} />); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Dog outside' })); });
    expect(request.mock.calls.some(([p]) => p === '/tech/line/set-text')).toBe(false);
    confirm.mockReturnValue(true);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Dog outside' })); });
    expect(await screen.findByRole('alert')).toHaveTextContent('This text just went out to the customer');
  });

  it('a finished visit shows no set texts', async () => {
    const request = makeRequest();
    await act(async () => { render(<VisitBriefPanel stop={stopFor({ ...SERVICE, status: 'completed' })} detail={detail} techLine={{ ...LINE, setTexts: OPTIONS }} request={request} />); });
    expect(screen.queryByTestId('set-text-row')).not.toBeInTheDocument();
    expect(replyCalls(request)).toHaveLength(0);
  });

  it('Last reply shows the customer\'s answer with the sender and time', async () => {
    const request = makeRequest({ replies: () => ({ setText: SET_TEXT, reply: { body: 'Unlocked it, go ahead', receivedAt: '2026-11-02T15:04:00Z', mediaCount: 1 }, ambiguous: false }) });
    await act(async () => { render(<VisitBriefPanel stop={stopFor(SERVICE)} detail={detail} techLine={{ ...LINE, setTexts: OPTIONS }} request={request} />); });
    const card = await screen.findByTestId('set-text-reply');
    expect(card).toHaveTextContent('Reply from Pat Sample · 10:04 AM (1 photo)');
    expect(card).toHaveTextContent('Unlocked it, go ahead');
  });

  it('an answer that could belong to another visit is not shown', async () => {
    const request = makeRequest({ replies: () => ({ setText: SET_TEXT, reply: null, ambiguous: true }) });
    await act(async () => { render(<VisitBriefPanel stop={stopFor(SERVICE)} detail={detail} techLine={{ ...LINE, setTexts: OPTIONS }} request={request} />); });
    expect(await screen.findByTestId('set-text-reply')).toHaveTextContent("Back gate locked sent 10:00 AM. A reply can't be matched to one visit — check your texts.");
  });

  it('no answer yet: Check again reads again', async () => {
    const request = makeRequest({ replies: () => ({ setText: SET_TEXT, reply: null, ambiguous: false }) });
    await act(async () => { render(<VisitBriefPanel stop={stopFor(SERVICE)} detail={detail} techLine={{ ...LINE, setTexts: OPTIONS }} request={request} />); });
    expect(await screen.findByTestId('set-text-reply')).toHaveTextContent('Back gate locked sent 10:00 AM. No reply yet.');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check again' })); });
    expect(replyCalls(request)).toHaveLength(2);
  });
});
