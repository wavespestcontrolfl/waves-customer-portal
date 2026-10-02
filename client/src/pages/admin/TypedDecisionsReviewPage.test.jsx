// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import TypedDecisionsReviewPage from './TypedDecisionsReviewPage';
import { adminFetch } from '../../utils/admin-fetch';

vi.mock('../../utils/admin-fetch', () => ({ adminFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const yesNoRow = (over = {}) => ({
  id: 'r1',
  capability: 'sms_wants_callback',
  question: 'Does the customer want a call back?',
  subjectType: 'sms_log',
  jevAnswer: { p: 0.91, yes: true, confident: true },
  baselineAnswers: { production: { yes: false } },
  sampledFor: 'disagreement',
  label: null,
  labelStatus: 'unreviewed',
  createdAt: '2026-10-01T13:00:00Z',
  subject: { type: 'sms_log', text: 'Fixture customer text', previousText: 'Fixture Waves text', direction: 'inbound', at: '2026-10-01T12:00:00Z' },
  ...over,
});

const mockList = (reviews) => adminFetch.mockImplementation(async (url, options) => {
  if (options?.method === 'POST') return { review: { ...reviews[0], labelStatus: 'confirmed_error' } };
  return { reviews, count: reviews.length };
});

it('requests unreviewed rows by default and renders answers, baseline, evidence and badge', async () => {
  mockList([yesNoRow()]);
  render(<MemoryRouter><TypedDecisionsReviewPage embedded /></MemoryRouter>);
  expect(await screen.findByText('Does the customer want a call back?')).toBeInTheDocument();
  expect(adminFetch.mock.calls[0][0]).toContain('/admin/typed-decisions/reviews?status=unreviewed');
  expect(adminFetch.mock.calls[0][0]).toContain('sampled_for=disagreement%2Crandom_audit');
  expect(screen.getByText('Jev: Yes (0.91)')).toBeInTheDocument();
  expect(screen.getByText('production: No')).toBeInTheDocument();
  expect(screen.queryByText(/Outcome/)).toBeNull(); // outcome evidence was dropped (owner, 2026-10-01)
  expect(screen.getByText('Disagreement', { selector: 'span' })).toBeInTheDocument();
  expect(screen.getByText('Fixture Waves text')).toBeInTheDocument();
  expect(screen.getByText('Fixture customer text')).toBeInTheDocument();
});

it('shows the empty state', async () => {
  mockList([]);
  render(<MemoryRouter><TypedDecisionsReviewPage embedded /></MemoryRouter>);
  expect(await screen.findByText('Nothing to review.')).toBeInTheDocument();
});

it('sends the inverse correct_value on Jev wrong and removes the row', async () => {
  mockList([yesNoRow()]);
  render(<MemoryRouter><TypedDecisionsReviewPage embedded /></MemoryRouter>);
  await screen.findByText('Does the customer want a call back?');
  fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: 'asked for text only' } });
  fireEvent.click(screen.getByRole('button', { name: 'Jev wrong' }));
  await waitFor(() => expect(adminFetch).toHaveBeenCalledWith('/admin/typed-decisions/reviews/r1/label', {
    method: 'POST',
    body: JSON.stringify({ verdict: 'jev_wrong', seen_answer: { p: 0.91, yes: true, confident: true }, seen_subject: null, correct_value: false, note: 'asked for text only' }),
  }));
  await waitFor(() => expect(screen.getByText('Nothing to review.')).toBeInTheDocument());
});

it('sends the tapped reason with Jev wrong and shows it on a labeled row', async () => {
  mockList([yesNoRow()]);
  render(<MemoryRouter><TypedDecisionsReviewPage embedded /></MemoryRouter>);
  await screen.findByText('Does the customer want a call back?');
  fireEvent.click(screen.getByRole('button', { name: 'Wrong tone' }));
  fireEvent.click(screen.getByRole('button', { name: 'Jev wrong' }));
  await waitFor(() => expect(adminFetch).toHaveBeenCalledWith('/admin/typed-decisions/reviews/r1/label', {
    method: 'POST',
    body: JSON.stringify({ verdict: 'jev_wrong', seen_answer: { p: 0.91, yes: true, confident: true }, seen_subject: null, correct_value: false, reason: 'wrong_tone' }),
  }));
  cleanup();
  mockList([yesNoRow({ label: { verdict: 'jev_wrong', note: 'asked for text only', reason: 'wrong_tone' }, labelStatus: 'confirmed_error' })]);
  render(<MemoryRouter><TypedDecisionsReviewPage embedded /></MemoryRouter>);
  await screen.findByText(/Labeled Jev Wrong — asked for text only \(Wrong tone\)/);
});

it('a chip tapped before Jev right is left out of that request and cleared, so a later Jev wrong does not reuse it', async () => {
  mockList([yesNoRow()]);
  render(<MemoryRouter><TypedDecisionsReviewPage embedded /></MemoryRouter>);
  await screen.findByText('Does the customer want a call back?');
  fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'all' } }); // the row stays mounted after a label
  await screen.findByText('Does the customer want a call back?');
  const chip = screen.getByRole('button', { name: 'Wrong tone' });
  fireEvent.click(chip);
  fireEvent.click(screen.getByRole('button', { name: 'Jev right' }));
  await waitFor(() => expect(adminFetch).toHaveBeenLastCalledWith('/admin/typed-decisions/reviews/r1/label', {
    method: 'POST',
    body: JSON.stringify({ verdict: 'jev_right', seen_answer: { p: 0.91, yes: true, confident: true }, seen_subject: null }),
  }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Wrong tone' })).toHaveAttribute('aria-pressed', 'false'));
  fireEvent.click(screen.getByRole('button', { name: 'Jev wrong' }));
  await waitFor(() => expect(adminFetch).toHaveBeenLastCalledWith('/admin/typed-decisions/reviews/r1/label', {
    method: 'POST',
    body: JSON.stringify({ verdict: 'jev_wrong', seen_answer: { p: 0.91, yes: true, confident: true }, seen_subject: null, correct_value: false }),
  }));
});

it('offers no Jev wrong button for choice questions', async () => {
  mockList([yesNoRow({ jevAnswer: { choice: 'reschedule' }, baselineAnswers: {} })]);
  render(<MemoryRouter><TypedDecisionsReviewPage embedded /></MemoryRouter>);
  await screen.findByText('Jev: Reschedule');
  expect(screen.queryByRole('button', { name: 'Jev wrong' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Jev right' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Unclear' })).toBeInTheDocument();
});

it('on 409 asks to replace and resends with force', async () => {
  const conflict = Object.assign(new Error('already'), { status: 409, details: { labelStatus: 'confirmed_correct' } });
  let posts = 0;
  adminFetch.mockImplementation(async (url, options) => {
    if (options?.method === 'POST') {
      posts += 1;
      if (posts === 1) throw conflict;
      return { review: yesNoRow({ labelStatus: 'confirmed_correct' }) };
    }
    return { reviews: [yesNoRow()], count: 1 };
  });
  render(<MemoryRouter><TypedDecisionsReviewPage embedded /></MemoryRouter>);
  await screen.findByText('Does the customer want a call back?');
  fireEvent.click(screen.getByRole('button', { name: 'Jev right' }));
  expect(await screen.findByText('Already labeled (confirmed correct) — replace?')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
  await waitFor(() => expect(adminFetch).toHaveBeenLastCalledWith('/admin/typed-decisions/reviews/r1/label', {
    method: 'POST',
    body: JSON.stringify({ verdict: 'jev_right', seen_answer: { p: 0.91, yes: true, confident: true }, seen_subject: null, force: true }),
  }));
});

it('collapses long call transcripts and refetches on status change', async () => {
  const long = 'x'.repeat(400);
  mockList([yesNoRow({ subject: { type: 'call_log', text: long, at: '2026-10-01T12:00:00Z' } })]);
  render(<MemoryRouter><TypedDecisionsReviewPage embedded /></MemoryRouter>);
  const toggle = await screen.findByRole('button', { name: /Show full transcript/ });
  expect(screen.queryByText(long)).toBeNull();
  fireEvent.click(toggle);
  expect(screen.getByText(long)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'disagreement' } });
  await waitFor(() => expect(adminFetch.mock.calls.at(-1)[0]).toContain('status=disagreement'));
});

it('drops sampled_for when Sampled only is toggled off', async () => {
  mockList([yesNoRow()]);
  render(<MemoryRouter><TypedDecisionsReviewPage embedded /></MemoryRouter>);
  await screen.findByText('Does the customer want a call back?');
  expect(adminFetch.mock.calls[0][0]).toContain('sampled_for=');
  fireEvent.click(screen.getByLabelText('Sampled only'));
  await waitFor(() => expect(adminFetch.mock.calls.at(-1)[0]).not.toContain('sampled_for'));
  expect(adminFetch.mock.calls.at(-1)[0]).toContain('status=unreviewed');
});

it('Load older sends before_id=<last id>, appends, and hides when a short page returns', async () => {
  const page = Array.from({ length: 50 }, (_, i) => yesNoRow({
    id: `p${i}`,
    question: `Question ${i}`,
    createdAt: new Date(Date.UTC(2026, 9, 1, 12, 0, 0) - i * 60000).toISOString(),
  }));
  adminFetch.mockImplementation(async (url) => {
    if (url.includes('before_id=')) return { reviews: [yesNoRow({ id: 'old1', question: 'Older question', createdAt: '2026-09-01T00:00:00Z' })], count: 1 };
    return { reviews: page, count: 50 };
  });
  render(<MemoryRouter><TypedDecisionsReviewPage embedded /></MemoryRouter>);
  await screen.findByText('Question 0');
  fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
  expect(await screen.findByText('Older question')).toBeInTheDocument();
  expect(adminFetch.mock.calls.at(-1)[0]).toContain('before_id=p49');
  expect(screen.getByText('Question 0')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Load older' })).toBeNull();
});

it('hides Load older when the first page is short', async () => {
  mockList([yesNoRow()]);
  render(<MemoryRouter><TypedDecisionsReviewPage embedded /></MemoryRouter>);
  await screen.findByText('Does the customer want a call back?');
  expect(screen.queryByRole('button', { name: 'Load older' })).toBeNull();
});

it('on 409 answer_changed shows the notice and reloads the list without a replace prompt', async () => {
  const stale = Object.assign(new Error('changed'), { status: 409, code: 'answer_changed', details: { code: 'answer_changed' } });
  let lists = 0;
  adminFetch.mockImplementation(async (url, options) => {
    if (options?.method === 'POST') throw stale;
    lists += 1;
    return { reviews: [yesNoRow(lists > 1 ? { jevAnswer: { p: 0.2, yes: false, confident: true } } : {})], count: 1 };
  });
  render(<MemoryRouter><TypedDecisionsReviewPage embedded /></MemoryRouter>);
  await screen.findByText('Jev: Yes (0.91)');
  fireEvent.click(screen.getByRole('button', { name: 'Jev right' }));
  expect(await screen.findByText("Jev's answer changed since this loaded — reloaded")).toBeInTheDocument();
  expect(await screen.findByText('Jev: No (0.20)')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Replace' })).toBeNull();
  expect(lists).toBe(2);
});

it('labeling the whole loaded page fetches the next page instead of dead-ending', async () => {
  const page = Array.from({ length: 50 }, (_, i) => yesNoRow({ id: `p${i}`, question: `Question ${i}` }));
  adminFetch.mockImplementation(async (url, options) => {
    if (options?.method === 'POST') return { review: { labelStatus: 'confirmed_correct' } };
    if (url.includes('before_id=p49')) return { reviews: [yesNoRow({ id: 'next1', question: 'Next page question' })], count: 1 };
    return { reviews: page, count: 50 };
  });
  render(<MemoryRouter><TypedDecisionsReviewPage embedded /></MemoryRouter>);
  await screen.findByText('Question 0');
  for (let i = 0; i < 50; i += 1) {
    fireEvent.click(screen.getAllByRole('button', { name: 'Jev right' })[0]);
    await waitFor(() => expect(screen.queryByText(`Question ${i}`)).toBeNull());
  }
  expect(await screen.findByText('Next page question')).toBeInTheDocument();
  expect(adminFetch.mock.calls.at(-1)[0]).toContain('before_id=p49');
}, 30000);

it('shows the call direction, and the swapped-speaker warning on outbound calls', async () => {
  mockList([
    yesNoRow({ id: 'c1', question: 'Outbound question', subjectType: 'call_log', subject: { type: 'call_log', direction: 'outbound-api', text: 'Agent: hi', at: '2026-10-01T12:00:00Z' } }),
    yesNoRow({ id: 'c2', question: 'Inbound question', subjectType: 'call_log', subject: { type: 'call_log', direction: 'inbound', text: 'Caller: hi', at: '2026-10-01T12:00:00Z' } }),
  ]);
  render(<MemoryRouter><TypedDecisionsReviewPage embedded /></MemoryRouter>);
  await screen.findByText('Outbound question');
  expect(screen.getByText(/^Outbound call/)).toBeInTheDocument();
  expect(screen.getByText(/^Inbound call/)).toBeInTheDocument();
  expect(screen.getAllByText(/Speaker labels can be swapped/)).toHaveLength(1);
});

it('a call reprocessed after Jev answered shows why and offers no label buttons', async () => {
  mockList([yesNoRow({ id: 'm1', question: 'Moved question', subjectChanged: true })]);
  render(<MemoryRouter><TypedDecisionsReviewPage embedded /></MemoryRouter>);
  await screen.findByText('Moved question');
  expect(screen.getByText(/changed after Jev answered/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Jev right' })).toBeNull();
});

it('a 409 subject_changed from the server locks the row instead of offering Replace', async () => {
  adminFetch.mockImplementation(async (url, options) => {
    if (options?.method === 'POST') { const e = new Error('changed'); e.status = 409; e.code = 'subject_changed'; throw e; }
    return { reviews: [yesNoRow({ id: 's1', question: 'Live question' })], count: 1 };
  });
  render(<MemoryRouter><TypedDecisionsReviewPage embedded /></MemoryRouter>);
  await screen.findByText('Live question');
  fireEvent.click(screen.getByRole('button', { name: 'Jev right' }));
  expect(await screen.findByText(/changed after Jev answered/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Replace' })).toBeNull();
});
