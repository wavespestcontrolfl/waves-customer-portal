// @vitest-environment jsdom
// Sending a saved estimate from the phone (GATE_TECH_ESTIMATES, step 4): the Send button, its confirm step and what
// each answer of the server looks like. A text cannot be taken back, so nothing is posted before "Send text" and no
// failure is ever retried by the screen.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlag: () => false }));
vi.mock('./fieldPortal', () => ({ useFieldPortalClass: () => '' }));
vi.mock('../../hooks/useModalFocus', () => ({ default: () => ({ current: null }) }));
vi.mock('../../hooks/useIsMobile', () => ({ default: () => true }));
vi.mock('../../lib/adminAuth', () => ({ getAdminAuthToken: () => 'token' }));

import TechEstimateSheet from './TechEstimateSheet';
import { clearSendLocks } from './useTechEstimates';

const SETUP = { oneTimeHoldDollars: 1000, services: [{ key: 'PEST', label: 'Recurring pest control', category: 'pest' }] };
const VISIT = { id: 'visit-1', customer_id: 'customer-1', customerName: 'Sample Customer', address: '100 Sample St' };
const READY = {
  lines: [{ label: 'Recurring pest control', monthly: 45, annual: 540 }],
  monthlyTotal: 45, annualTotal: 540, oneTimeTotal: 0, facts: {}, officeFirst: { required: false, reasons: [] }, digest: 'a'.repeat(64),
};
const ROW = {
  id: 'est-1', status: 'draft', who: 'Sample Customer', addressLine: '100 Sample St', monthlyTotal: 45, annualTotal: 540, oneTimeTotal: 0,
  officeFirst: { required: false, reasons: [] }, canSend: true, needsTextRequest: false,
};
const NEW_PERSON_ROW = { ...ROW, id: 'est-2', who: 'Pat Example', needsTextRequest: true };

let calls;
let replies;
const reply = (key, status, body) => { replies[key] = [{ status, body }]; };
const sendCalls = () => calls.filter((c) => c.path.endsWith('/send'));

beforeEach(() => {
  calls = [];
  replies = {};
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    const method = options.method || 'GET';
    const path = String(url).replace('/api/tech/estimates', '') || '/';
    calls.push({ method, path, body: options.body ? JSON.parse(options.body) : undefined });
    const next = (replies[`${method} ${path}`] || [])[0] || { status: 200, body: {} };
    if (next.drop) throw new TypeError('Failed to fetch');
    return { ok: next.status < 400, status: next.status, json: async () => next.body };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); clearSendLocks(); });

const open = (props = {}) => render(<TechEstimateSheet setup={SETUP} service={VISIT} onClose={() => {}} onHandOff={() => {}} {...props} />);
const openDetail = async (row = ROW, detail = row) => {
  reply('GET /', 200, { estimates: [row] });
  reply(`GET /${row.id}`, 200, { ...detail, lines: READY.lines });
  open({ service: null });
  fireEvent.click(screen.getByRole('button', { name: 'My estimates' }));
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(row.who) }));
  await screen.findByRole('button', { name: 'Back' });
};
const tapSend = () => fireEvent.click(screen.getByRole('button', { name: 'Send to customer' }));
const confirmSend = () => fireEvent.click(screen.getByRole('button', { name: 'Send text' }));

describe('where the Send button shows', () => {
  it('on the detail only while the server says canSend', async () => {
    await openDetail();
    expect(screen.getByRole('button', { name: 'Send to customer' })).toBeInTheDocument();
    cleanup();
    calls = [];
    replies = {};
    await openDetail({ ...ROW, id: 'est-3', canSend: false, status: 'sent' });
    expect(screen.queryByRole('button', { name: 'Send to customer' })).not.toBeInTheDocument();
  });

  it('never on an estimate the office checks first', async () => {
    await openDetail({ ...ROW, canSend: false, officeFirst: { required: true, reasons: ['office_review'] } });
    expect(screen.queryByRole('button', { name: 'Send to customer' })).not.toBeInTheDocument();
  });

  it('tags a sendable row "Ready to send" and no other row', async () => {
    reply('GET /', 200, { estimates: [ROW, { ...ROW, id: 'est-9', who: 'Held One', canSend: false, officeFirst: { required: true, reasons: ['office_review'] } }] });
    open({ service: null });
    fireEvent.click(screen.getByRole('button', { name: 'My estimates' }));
    await screen.findByRole('button', { name: /Sample Customer/ });
    expect(screen.getAllByText('Ready to send')).toHaveLength(1);
  });

  it('right after a ready save, with the new wording, and not after an office-first save', async () => {
    reply('POST /price', 200, READY);
    reply('POST /', 200, { id: 'est-1', status: 'draft', ...READY });
    open();
    fireEvent.click(screen.getByLabelText('Recurring pest control'));
    fireEvent.click(screen.getByRole('button', { name: 'Get price' }));
    await screen.findByText('This estimate is ready. Save it.');
    fireEvent.click(screen.getByRole('button', { name: 'Save estimate' }));
    await screen.findByText('Saved. Send it now, or later from My estimates.');
    expect(screen.getByRole('button', { name: 'Send to customer' })).toBeInTheDocument();
    cleanup();
    replies = {};
    const held = { ...READY, officeFirst: { required: true, reasons: ['office_review'] } };
    reply('POST /price', 200, held);
    reply('POST /', 200, { id: 'est-1', status: 'draft', ...held });
    open();
    fireEvent.click(screen.getByLabelText('Recurring pest control'));
    fireEvent.click(screen.getByRole('button', { name: 'Get price' }));
    await screen.findByText('The office checks this one first.');
    fireEvent.click(screen.getByRole('button', { name: 'Save estimate' }));
    await screen.findByText('Saved. The office checks it and sends it.');
    expect(screen.queryByRole('button', { name: 'Send to customer' })).not.toBeInTheDocument();
  });
});

describe('the confirm step', () => {
  it('posts nothing until Send text, and Not now posts nothing', async () => {
    await openDetail();
    tapSend();
    expect(screen.getByText('Text this estimate to Sample Customer?')).toBeInTheDocument();
    expect(sendCalls()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(sendCalls()).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Send to customer' })).toBeInTheDocument();
  });

  it('for a customer the body is exactly {} and there is no checkbox', async () => {
    reply('POST /est-1/send', 200, { id: 'est-1', status: 'sent', sentAt: '2026-11-09T15:00:00Z' });
    await openDetail();
    tapSend();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    confirmSend();
    await screen.findByText('Sent to Sample Customer.');
    expect(sendCalls()).toEqual([{ method: 'POST', path: '/est-1/send', body: {} }]);
  });

  it('for a new person Send text stays off until the box is ticked, then the body is exactly { askedForText: true }', async () => {
    reply('POST /est-2/send', 200, { id: 'est-2', status: 'sent', sentAt: '2026-11-09T15:00:00Z' });
    await openDetail(NEW_PERSON_ROW);
    tapSend();
    const button = screen.getByRole('button', { name: 'Send text' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(sendCalls()).toHaveLength(0);
    const box = screen.getByLabelText('Pat asked me to text this estimate.');
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    expect(screen.getByRole('button', { name: 'Send text' })).toBeEnabled();
    confirmSend();
    await screen.findByText('Sent to Pat Example.');
    expect(sendCalls()).toEqual([{ method: 'POST', path: '/est-2/send', body: { askedForText: true } }]);
  });

  it('a double tap sends one request', async () => {
    let release;
    await openDetail();
    fetch.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ ok: true, status: 200, json: async () => ({ id: 'est-1', status: 'sent', sentAt: null }) }); }));
    tapSend();
    const button = screen.getByRole('button', { name: 'Send text' });
    fireEvent.click(button);
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Sending…' }));
    expect(fetch).toHaveBeenCalledTimes(3);
    release();
    await screen.findByText('Sent to Sample Customer.');
  });

  it('shows the checkbox when the server asks for the text request anyway', async () => {
    reply('POST /est-1/send', 400, { error: 'Confirm that the person asked for the estimate by text.', code: 'needs_text_request' });
    await openDetail();
    tapSend();
    confirmSend();
    expect(await screen.findByLabelText('Sample asked me to text this estimate.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send text' })).toBeDisabled();
    expect(sendCalls()).toHaveLength(1);
  });
});

describe('what each answer shows', () => {
  // Opens his estimate, then arms the answers the test needs after the list and the first read.
  const fail = async (status, body, { reread, row = ROW } = {}) => {
    await openDetail(row);
    reply(`POST /${row.id}/send`, status, body);
    if (reread) reply(`GET /${row.id}`, 200, { ...row, ...reread, lines: READY.lines });
    tapSend();
    confirmSend();
  };

  it('sent: the new status comes from a fresh read and the button is gone', async () => {
    await openDetail();
    reply('POST /est-1/send', 200, { id: 'est-1', status: 'sent', sentAt: 'x' });
    reply('GET /est-1', 200, { ...ROW, status: 'sent', canSend: false, lines: READY.lines });
    tapSend();
    confirmSend();
    await screen.findByText('Sent to Sample Customer.');
    await screen.findByText(/100 Sample St · Sent/);
    expect(screen.queryByRole('button', { name: 'Send to customer' })).not.toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/est-1' && c.method === 'GET')).toHaveLength(2);
  });

  it('outside hours: the server message, and it stays his to send later', async () => {
    const message = 'Texts go out between 8 AM and 8 PM. Send it then, or ask the office.';
    await fail(409, { error: message, code: 'outside_hours' });
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to customer' })).toBeInTheDocument();
    expect(sendCalls()).toHaveLength(1);
  });

  it('office_sends: the server message, then no Send button after the re-read', async () => {
    await fail(422, { error: 'This estimate has no mobile number. Ask the office to send it.', code: 'office_sends' }, { reread: { status: 'send_failed', canSend: false } });
    expect(await screen.findByText('This estimate has no mobile number. Ask the office to send it.')).toBeInTheDocument();
    await screen.findByText(/Send failed/);
    expect(screen.queryByRole('button', { name: 'Send to customer' })).not.toBeInTheDocument();
    expect(sendCalls()).toHaveLength(1);
  });

  it.each([
    ['office_first', 409, 'The office checks this one first.'],
    ['already_sent', 409, 'This estimate was already sent.'],
  ])('%s: the server message, then a re-read', async (code, status, message) => {
    await fail(status, { error: message, code }, { reread: { canSend: false, status: code === 'already_sent' ? 'sent' : 'draft' } });
    expect(await screen.findByText(message)).toBeInTheDocument();
    await waitForNoSend();
    expect(sendCalls()).toHaveLength(1);
  });

  it('404: says it left his list and goes back to the list', async () => {
    await openDetail();
    reply('POST /est-1/send', 404, { error: 'Estimate not found' });
    reply('GET /', 200, { estimates: [] });
    tapSend();
    confirmSend();
    expect(await screen.findByText('This estimate is no longer in your list.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
  });

  it('a dropped connection: the do-not-resend words, a re-read, and the button never comes back', async () => {
    await openDetail();
    replies['POST /est-1/send'] = [{ drop: true }];
    tapSend();
    confirmSend();
    const words = 'The app cannot tell if the text went. Do not send it again. Ask the office to check.';
    expect(await screen.findByText(words)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send to customer' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByRole('button', { name: /Sample Customer/ });
    expect(screen.queryByText('Ready to send')).not.toBeInTheDocument();
    expect(sendCalls()).toHaveLength(1);
  });

  // "Do not send it again" must hold on every view of the sheet, whatever he taps next. The server still says draft
  // and canSend here (the request never got an answer), so only the lock keeps the button away.
  describe('the do-not-resend lock holds across the sheet', () => {
    const words = 'The app cannot tell if the text went. Do not send it again. Ask the office to check.';
    const dropSendFromDetail = async () => {
      await openDetail();
      replies['POST /est-1/send'] = [{ drop: true }];
      tapSend();
      confirmSend();
      await screen.findByText(words);
    };
    const expectNoSendAnywhere = async () => {
      // The tab at the top (the saved screen has a second button with the same name).
      fireEvent.click(screen.getAllByRole('button', { name: 'My estimates' })[0]);
      const row = await screen.findByRole('button', { name: /Sample Customer/ });
      expect(screen.queryByText('Ready to send')).not.toBeInTheDocument();
      fireEvent.click(row);
      await screen.findByRole('button', { name: 'Back' });
      // The detail has loaded (its heading is the customer's name), and the server said canSend.
      await screen.findByRole('heading', { name: 'Sample Customer' });
      expect(screen.queryByRole('button', { name: 'Send to customer' })).not.toBeInTheDocument();
    };

    it('after a change to New estimate and back', async () => {
      await dropSendFromDetail();
      fireEvent.click(screen.getByRole('button', { name: 'New estimate' }));
      await expectNoSendAnywhere();
      expect(sendCalls()).toHaveLength(1);
    });

    it('after the sheet is closed and opened again', async () => {
      await dropSendFromDetail();
      cleanup();
      open({ service: null });
      await expectNoSendAnywhere();
      expect(sendCalls()).toHaveLength(1);
    });

    it('from the saved screen to My estimates', async () => {
      reply('POST /price', 200, READY);
      reply('POST /', 200, { id: 'est-1', status: 'draft', lines: READY.lines, monthlyTotal: 45, annualTotal: 540, oneTimeTotal: 0, officeFirst: READY.officeFirst });
      reply('GET /', 200, { estimates: [ROW] });
      reply('GET /est-1', 200, { ...ROW, lines: READY.lines });
      replies['POST /est-1/send'] = [{ drop: true }];
      open();
      fireEvent.click(screen.getByLabelText('Recurring pest control'));
      fireEvent.click(screen.getByRole('button', { name: 'Get price' }));
      await screen.findByText('This estimate is ready. Save it.');
      fireEvent.click(screen.getByRole('button', { name: 'Save estimate' }));
      await screen.findByText('Saved. Send it now, or later from My estimates.');
      tapSend();
      confirmSend();
      await screen.findByText(words);
      expect(screen.queryByRole('button', { name: 'Send to customer' })).not.toBeInTheDocument();
      await expectNoSendAnywhere();
      expect(sendCalls()).toHaveLength(1);
    });

    it('another estimate is not locked', async () => {
      await dropSendFromDetail();
      cleanup();
      await openDetail(NEW_PERSON_ROW);
      expect(screen.getByRole('button', { name: 'Send to customer' })).toBeInTheDocument();
    });
  });

  it('after a ready save, a sent text shows "Sent to <who>." and no more Send button', async () => {
    reply('POST /price', 200, READY);
    reply('POST /', 200, { id: 'est-1', status: 'draft', ...READY });
    reply('POST /est-1/send', 200, { id: 'est-1', status: 'sent', sentAt: 'x' });
    open();
    fireEvent.click(screen.getByLabelText('Recurring pest control'));
    fireEvent.click(screen.getByRole('button', { name: 'Get price' }));
    await screen.findByText('This estimate is ready. Save it.');
    fireEvent.click(screen.getByRole('button', { name: 'Save estimate' }));
    await screen.findByText('Saved. Send it now, or later from My estimates.');
    tapSend();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    confirmSend();
    await screen.findByText('Sent to Sample Customer.');
    expect(screen.queryByRole('button', { name: 'Send to customer' })).not.toBeInTheDocument();
    expect(sendCalls()).toEqual([{ method: 'POST', path: '/est-1/send', body: {} }]);
  });
});

async function waitForNoSend() {
  await vi.waitFor(() => expect(screen.queryByRole('button', { name: 'Send to customer' })).not.toBeInTheDocument());
}
