// @vitest-environment jsdom
import React, { createRef } from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GlobalCommandPalette from './GlobalCommandPalette';
import useIsMobile from '../../hooks/useIsMobile';
import { IntelligenceBarPageDataProvider, usePublishIntelligenceBarPageData } from '../../hooks/useIntelligenceBarPageData';

// The free "Send to Claude" beside Ask (GATE_IB_SEND_TO_CLAUDE): shown only when /admin/claude-ideas/status says enabled, on
// the desktop modal and the phone sheet; posts the idea with the page and record ids; never calls the Ask query; refuses
// photos; and Undo cancels with the answer's `at`.
vi.mock('../../lib/adminUsage', () => ({ markUsageSource: vi.fn(), trackAdminPageView: vi.fn() }));
vi.mock('../../hooks/useIsMobile', () => ({ default: vi.fn(() => false) }));
vi.mock('../tech/DictationButton', () => ({ default: () => null }));
vi.mock('../../utils/imageCompression', () => ({ encodeJpegDataUrl: vi.fn(async () => 'data:image/jpeg;base64,QUJD') }));

const CUSTOMER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_CUSTOMER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const THREAD = '00000000-0000-4000-8000-0000000000b2';
const IDEA_ID = '00000000-0000-4000-8000-0000000000a1';
const AT = '2026-11-03T15:00:00.000Z';
const ANSWER = 'There is no manual prepay option in this bar. Nothing was changed.';
const reply = (status, body) => ({ ok: status < 400, status, statusText: '', headers: { get: () => null }, json: async () => body, clone() { return this; } });
let fetchMock;
let ideaAnswer;
let statusAnswer;
let queryAnswer;

// The page the palette sits on; a test opens another customer with switchPageCustomer.
let switchPageCustomer = () => {};
function Page() {
  const [customerId, setCustomerId] = React.useState(CUSTOMER);
  switchPageCustomer = setCustomerId;
  usePublishIntelligenceBarPageData({ customer_id: customerId, viewed_date: '2026-11-03' });
  return null;
}
async function mount({ mobile = false } = {}) {
  useIsMobile.mockReturnValue(mobile);
  const ref = createRef();
  render(
    <MemoryRouter initialEntries={['/admin/customers']}>
      <IntelligenceBarPageDataProvider>
        <Page />
        <GlobalCommandPalette ref={ref} />
      </IntelligenceBarPageDataProvider>
    </MemoryRouter>,
  );
  act(() => ref.current.open());
  await screen.findByPlaceholderText(/Ask anything/);
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/claude-ideas/status'))).toBe(true));
}
const type = (text) => fireEvent.change(screen.getByPlaceholderText(/Ask anything/), { target: { value: text } });
const callsTo = (suffix) => fetchMock.mock.calls.filter(([url]) => String(url).endsWith(suffix));

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  statusAnswer = () => reply(200, { enabled: true });
  queryAnswer = () => reply(200, { response: ANSWER, toolCalls: [], pendingActions: [], conversationHistory: [] });
  ideaAnswer = () => reply(200, { sent: true, id: IDEA_ID, at: AT, message: 'Sent to Claude.' });
  fetchMock = vi.fn((url) => {
    const u = String(url);
    if (u.includes('/intelligence-bar/query')) return Promise.resolve(queryAnswer());
    if (u.endsWith('/claude-ideas/status')) return Promise.resolve(statusAnswer());
    if (u.endsWith('/claude-ideas')) return Promise.resolve(ideaAnswer());
    if (u.endsWith('/cancel')) return Promise.resolve(reply(200, { cancelled: true }));
    if (u.includes('/threads/latest')) return Promise.resolve(reply(200, { thread: null }));
    return Promise.resolve(reply(200, { actions: [], tasks: [], threads: [] }));
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.clearAllMocks(); });

describe.each([['desktop', false], ['phone sheet', true]])('Send to Claude beside Ask (%s)', (_name, mobile) => {
  it('is hidden when the status says disabled, and when the status call fails', async () => {
    statusAnswer = () => reply(200, { enabled: false });
    await mount({ mobile });
    type('An idea');
    expect(screen.queryByRole('button', { name: /Send to Claude/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Ask uses the paid AI/)).not.toBeInTheDocument();
    cleanup();
    statusAnswer = () => reply(500, { error: 'boom' });
    await mount({ mobile });
    type('An idea');
    expect(screen.queryByRole('button', { name: /Send to Claude/ })).not.toBeInTheDocument();
  });

  it('is shown when enabled, with the help line, and asks the status once per session', async () => {
    await mount({ mobile });
    type('An idea');
    expect(await screen.findByRole('button', { name: 'Send to Claude (free)' })).toBeEnabled();
    expect(screen.getByText('Ask uses the paid AI. Send to Claude opens a tab on the Mac at no cost.')).toBeInTheDocument();
    expect(callsTo('/claude-ideas/status')).toHaveLength(1);
  });

  it('posts the idea with the page and record ids, clears the box, and never calls the Ask query', async () => {
    await mount({ mobile });
    const box = screen.getByPlaceholderText(/Ask anything/);
    fireEvent.paste(box, { clipboardData: { getData: () => 'pasted words' } });
    type('Show the last tech note on this card.');
    fireEvent.click(await screen.findByRole('button', { name: 'Send to Claude (free)' }));
    expect(await screen.findByText('Sent to Claude.')).toBeInTheDocument();
    const posts = callsTo('/claude-ideas').filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0][1].body)).toEqual({
      text: 'Show the last tech note on this card.',
      page: { route: '/admin/customers' },
      ids: { customer_id: CUSTOMER, viewed_date: '2026-11-03' },
      pasted: true,
    });
    expect(callsTo('/query')).toHaveLength(0);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/intelligence-bar/query'))).toBe(false);
    expect(box).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('does nothing for an empty box', async () => {
    await mount({ mobile });
    if (!mobile) fireEvent.click(await screen.findByRole('button', { name: 'Send to Claude (free)' }));
    expect(callsTo('/claude-ideas').filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    if (!mobile) expect(screen.getByRole('button', { name: 'Send to Claude (free)' })).toBeDisabled();
  });

  it('refuses photos with a plain line and sends nothing', async () => {
    await mount({ mobile });
    fireEvent.change(document.querySelector('input[type=file]'), { target: { files: [new File(['x'], 'fixture.png', { type: 'image/png' })] } });
    await screen.findByRole('button', { name: 'Remove fixture.png' });
    type('Look at this');
    fireEvent.click(await screen.findByRole('button', { name: 'Send to Claude (free)' }));
    expect(await screen.findByText("Photos can't go to Claude yet. Describe it in words.")).toBeInTheDocument();
    expect(callsTo('/claude-ideas').filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    expect(screen.getByPlaceholderText(/Ask anything/)).toHaveValue('Look at this');
  });

  it('Undo cancels with the answer\'s time and says so', async () => {
    await mount({ mobile });
    type('An idea');
    fireEvent.click(await screen.findByRole('button', { name: 'Send to Claude (free)' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Cancelled. Your text is back in the box.')).toBeInTheDocument();
    const cancels = callsTo(`/claude-ideas/${IDEA_ID}/cancel`);
    expect(cancels).toHaveLength(1);
    expect(cancels[0][1].method).toBe('POST');
    expect(JSON.parse(cancels[0][1].body)).toEqual({ at: AT });
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('Undo puts the raw typed text back, exactly as typed, and never the photos', async () => {
    await mount({ mobile });
    const raw = '  Show the last tech note\tfirst.\n\n\n\nIt hides today.  ';
    type(raw);
    fireEvent.click(await screen.findByRole('button', { name: 'Send to Claude (free)' }));
    await screen.findByRole('button', { name: 'Undo' });
    expect(screen.getByPlaceholderText(/Ask anything/)).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Cancelled. Your text is back in the box.')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Ask anything/)).toHaveValue(raw);
    expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument();
  });

  it('Undo keeps words typed after the send and says only "Cancelled."', async () => {
    await mount({ mobile });
    type('The first idea');
    fireEvent.click(await screen.findByRole('button', { name: 'Send to Claude (free)' }));
    await screen.findByRole('button', { name: 'Undo' });
    type('A new thought');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Cancelled.')).toBeInTheDocument();
    expect(screen.queryByText(/back in the box/)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Ask anything/)).toHaveValue('A new thought');
  });

  it('a pasted idea keeps its paste mark through Undo, so the next send still says pasted', async () => {
    await mount({ mobile });
    const box = screen.getByPlaceholderText(/Ask anything/);
    fireEvent.paste(box, { clipboardData: { getData: () => 'Pasted words' } });
    type('Pasted words');
    fireEvent.click(await screen.findByRole('button', { name: 'Send to Claude (free)' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Cancelled. Your text is back in the box.')).toBeInTheDocument();
    expect(box).toHaveValue('Pasted words');
    fireEvent.click(screen.getByRole('button', { name: 'Send to Claude (free)' }));
    await waitFor(() => expect(callsTo('/claude-ideas')).toHaveLength(2));
    const sends = callsTo('/claude-ideas').map(([, init]) => JSON.parse(init.body));
    expect(sends[0].pasted).toBe(true);
    expect(sends[1].pasted).toBe(true);
  });

  it('keeps words typed while the send was still running', async () => {
    let finish;
    ideaAnswer = () => new Promise((resolve) => { finish = () => resolve(reply(200, { sent: true, id: IDEA_ID, at: AT })); });
    await mount({ mobile });
    type('The first idea');
    fireEvent.click(await screen.findByRole('button', { name: 'Send to Claude (free)' }));
    await waitFor(() => expect(typeof finish).toBe('function'));
    type('More words typed meanwhile');
    await act(async () => { finish(); });
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Ask anything/)).toHaveValue('More words typed meanwhile');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Cancelled.')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Ask anything/)).toHaveValue('More words typed meanwhile');
  });

  it('a failed Undo restores nothing', async () => {
    await mount({ mobile });
    type('The first idea');
    fireEvent.click(await screen.findByRole('button', { name: 'Send to Claude (free)' }));
    fetchMock.mockImplementationOnce(() => Promise.resolve(reply(409, { error: 'started' })));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Claude already started on it.')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Ask anything/)).toHaveValue('');
  });

  it('says Claude already started when the cancel answers 409 started, and has it for any other failure', async () => {
    await mount({ mobile });
    type('An idea');
    fireEvent.click(await screen.findByRole('button', { name: 'Send to Claude (free)' }));
    fetchMock.mockImplementationOnce(() => Promise.resolve(reply(409, { error: 'started' })));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Claude already started on it.')).toBeInTheDocument();
    cleanup();
    await mount({ mobile });
    type('Another idea');
    fireEvent.click(await screen.findByRole('button', { name: 'Send to Claude (free)' }));
    fetchMock.mockImplementationOnce(() => Promise.resolve(reply(409, { error: 'changed' })));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(await screen.findByText("Couldn't cancel. Claude has it.")).toBeInTheDocument();
  });

  it('answers a duplicate and any other failure in plain words, keeping the typed idea', async () => {
    await mount({ mobile });
    type('An idea');
    ideaAnswer = () => reply(200, { duplicate: true, id: IDEA_ID });
    fireEvent.click(await screen.findByRole('button', { name: 'Send to Claude (free)' }));
    expect(await screen.findByText('You already sent this idea. Claude has it.')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Ask anything/)).toHaveValue('An idea');
    ideaAnswer = () => reply(422, { error: 'not_sent' });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Claude (free)' }));
    expect(await screen.findByText("Couldn't send it. Try again.")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Ask anything/)).toHaveValue('An idea');
  });

  it('drops the Undo after ten seconds', async () => {
    await mount({ mobile });
    type('An idea');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send to Claude (free)' })); });
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(10001); });
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(screen.getByText('Sent to Claude.')).toBeInTheDocument();
  });
});

// Under a stuck answer (GATE_IB_ANSWER_SEND_TO_CLAUDE): a gap line, a button, or nothing; and a tap sends only the owner's
// own question for that answer, never the answer.
describe.each([['desktop', false], ['phone sheet', true]])('Send to Claude under a stuck answer (%s)', (_name, mobile) => {
  const stuck = (gapId) => ({ response: ANSWER, toolCalls: [], pendingActions: [], conversationHistory: [], answerClaude: { stuck: true, gapId } });
  const QUESTION = 'Switch Pat Placeholder to annual prepay';
  async function askQuestion(question = QUESTION, { paste = false } = {}) {
    const box = screen.getByPlaceholderText(/Ask anything/);
    if (paste) fireEvent.paste(box, { clipboardData: { getData: () => question } });
    type(question);
    fireEvent.keyDown(box, { key: 'Enter' });
    await screen.findByText(ANSWER);
  }
  const answerButton = () => screen.queryByTestId('answer-send-to-claude');
  const ideaPosts = () => callsTo('/claude-ideas').filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(init.body));

  it('shows "Claude has this as gap #N." and no button when a gap row was written', async () => {
    statusAnswer = () => reply(200, { enabled: true, answerButton: true });
    queryAnswer = () => reply(200, stuck(7));
    await mount({ mobile });
    await askQuestion();
    expect(await screen.findByText('Claude has this as gap #7.')).toBeInTheDocument();
    expect(answerButton()).not.toBeInTheDocument();
  });

  it('shows the button when no gap row was written, and a tap sends the question, the page and the paste mark, never the answer', async () => {
    statusAnswer = () => reply(200, { enabled: true, answerButton: true });
    queryAnswer = () => reply(200, stuck(null));
    await mount({ mobile });
    await askQuestion(QUESTION, { paste: true });
    expect(screen.getByPlaceholderText(/Ask anything/)).toHaveValue('');
    const button = await screen.findByTestId('answer-send-to-claude');
    expect(button).toHaveTextContent('Send to Claude (free)');
    expect(screen.getByText("Bar couldn't do it?")).toBeInTheDocument();
    if (mobile) expect(button.style.minHeight).toBe('44px');
    fireEvent.click(button);
    expect(await screen.findByText('Sent to Claude.')).toBeInTheDocument();
    expect(ideaPosts()).toEqual([{
      text: QUESTION,
      page: { route: '/admin/customers' },
      ids: { customer_id: CUSTOMER, viewed_date: '2026-11-03' },
      pasted: true,
    }]);
    expect(JSON.stringify(ideaPosts())).not.toContain('manual prepay');
    expect(answerButton()).not.toBeInTheDocument();
  });

  it('an answer a thread keeps after the page changes sends the page and record ids of its own Ask', async () => {
    statusAnswer = () => reply(200, { enabled: true, answerButton: true });
    queryAnswer = () => reply(200, { ...stuck(null), threadId: THREAD, threadSeq: 1, threadsEnabled: true });
    await mount({ mobile });
    await askQuestion();
    act(() => switchPageCustomer(OTHER_CUSTOMER));
    fireEvent.click(await screen.findByTestId('answer-send-to-claude'));
    expect(await screen.findByText('Sent to Claude.')).toBeInTheDocument();
    expect(ideaPosts()).toEqual([{
      text: QUESTION,
      page: { route: '/admin/customers' },
      ids: { customer_id: CUSTOMER, viewed_date: '2026-11-03' },
      pasted: false,
    }]);
  });

  it('a send that finishes after a newer answer arrived shows nothing under the newer answer', async () => {
    statusAnswer = () => reply(200, { enabled: true, answerButton: true });
    queryAnswer = () => reply(200, stuck(null));
    let finishSend = () => {};
    ideaAnswer = () => new Promise((resolve) => { finishSend = () => resolve(reply(200, { sent: true, id: IDEA_ID, at: AT, message: 'Sent to Claude.' })); });
    await mount({ mobile });
    await askQuestion();
    fireEvent.click(await screen.findByTestId('answer-send-to-claude'));
    await waitFor(() => expect(ideaPosts()).toHaveLength(1));
    const NEXT_ANSWER = 'Nothing was changed. The bar found no tool for that request.';
    queryAnswer = () => reply(200, { ...stuck(null), response: NEXT_ANSWER });
    type('Move every Friday visit to Thursday');
    fireEvent.keyDown(screen.getByPlaceholderText(/Ask anything/), { key: 'Enter' });
    await screen.findByText(NEXT_ANSWER);
    expect(answerButton()).toBeDisabled();
    expect(answerButton()).toHaveTextContent('Send to Claude (free)');
    await act(async () => { finishSend(); });
    expect(screen.queryByText('Sent to Claude.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    await waitFor(() => expect(answerButton()).toBeEnabled());
    expect(ideaPosts()).toHaveLength(1);
  });

  it('a typed question is sent with pasted false', async () => {
    statusAnswer = () => reply(200, { enabled: true, answerButton: true });
    queryAnswer = () => reply(200, stuck(null));
    await mount({ mobile });
    await askQuestion();
    fireEvent.click(await screen.findByTestId('answer-send-to-claude'));
    await screen.findByText('Sent to Claude.');
    expect(ideaPosts()[0]).toMatchObject({ text: QUESTION, pasted: false });
  });

  it('Undo cancels with the send\'s time, says Cancelled, and brings the button back', async () => {
    statusAnswer = () => reply(200, { enabled: true, answerButton: true });
    queryAnswer = () => reply(200, stuck(null));
    await mount({ mobile });
    await askQuestion();
    fireEvent.click(await screen.findByTestId('answer-send-to-claude'));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Cancelled.')).toBeInTheDocument();
    const cancels = callsTo(`/claude-ideas/${IDEA_ID}/cancel`);
    expect(cancels).toHaveLength(1);
    expect(JSON.parse(cancels[0][1].body)).toEqual({ at: AT });
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(answerButton()).toBeInTheDocument();
    // The composer is untouched by an answer-level Undo.
    expect(screen.getByPlaceholderText(/Ask anything/)).toHaveValue('');
  });

  it('answers a duplicate in plain words, and a failure with the button still there to try again', async () => {
    statusAnswer = () => reply(200, { enabled: true, answerButton: true });
    queryAnswer = () => reply(200, stuck(null));
    await mount({ mobile });
    await askQuestion();
    ideaAnswer = () => reply(422, { error: 'not_sent' });
    fireEvent.click(await screen.findByTestId('answer-send-to-claude'));
    expect(await screen.findByText("Couldn't send it. Try again.")).toBeInTheDocument();
    ideaAnswer = () => reply(200, { duplicate: true, id: IDEA_ID });
    fireEvent.click(screen.getByTestId('answer-send-to-claude'));
    expect(await screen.findByText('You already sent this idea. Claude has it.')).toBeInTheDocument();
    expect(answerButton()).not.toBeInTheDocument();
  });

  it('keeps the button, the question and the send note when the task card is refreshed', async () => {
    const TASK = '00000000-0000-4000-8000-0000000000c3';
    const task = { ...stuck(null), taskId: TASK, taskState: 'responded', receipts: [] };
    statusAnswer = () => reply(200, { enabled: true, answerButton: true });
    queryAnswer = () => reply(200, task);
    await mount({ mobile });
    await askQuestion();
    fireEvent.click(await screen.findByTestId('answer-send-to-claude'));
    await screen.findByText('Sent to Claude.');
    const before = fetchMock.mock.calls.length;
    const baseFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((url, init) => (String(url).includes(`/tasks/${TASK}`) ? Promise.resolve(reply(200, task)) : baseFetch(url, init)));
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes(`/tasks/${TASK}?`))).toBe(true));
    expect(screen.getByText('Sent to Claude.')).toBeInTheDocument();
    expect(ideaPosts()).toHaveLength(1);
  });

  it('shows nothing when the status has no answerButton, even for a stuck reply', async () => {
    queryAnswer = () => reply(200, stuck(7));
    await mount({ mobile });
    await askQuestion();
    expect(screen.queryByText(/Claude has this as gap/)).not.toBeInTheDocument();
    expect(answerButton()).not.toBeInTheDocument();
  });

  it('shows nothing when the reply carries no answerClaude', async () => {
    statusAnswer = () => reply(200, { enabled: true, answerButton: true });
    await mount({ mobile });
    await askQuestion();
    expect(screen.queryByText(/Claude has this as gap/)).not.toBeInTheDocument();
    expect(answerButton()).not.toBeInTheDocument();
  });

  it('a question that came from a tapped choice or quick action is not the owner\'s words: no button', async () => {
    statusAnswer = () => reply(200, { enabled: true, answerButton: true });
    queryAnswer = () => reply(200, { ...stuck(null), choices: ['Annual prepay (model wrote this)', 'Monthly'] });
    await mount({ mobile });
    await askQuestion();
    expect(await screen.findByTestId('answer-send-to-claude')).toBeInTheDocument();
    queryAnswer = () => reply(200, { ...stuck(null), response: 'Second answer from a tap.' });
    fireEvent.click(screen.getByRole('button', { name: 'Annual prepay (model wrote this)' }));
    await screen.findByText('Second answer from a tap.');
    expect(answerButton()).not.toBeInTheDocument();
    expect(ideaPosts()).toHaveLength(0);
  });
});
