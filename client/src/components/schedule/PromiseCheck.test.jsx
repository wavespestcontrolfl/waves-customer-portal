// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import PromiseCheck, { promiseCountLabel, promiseMarksPayload, promiseMarksSignature, promiseSourceLabel, STILL_LEFT_MAX } from './PromiseCheck';

const PROMISES = [
  { id: 'p-1', description: 'Check under the dishwasher and the kitchen sink', source: 'call', madeAt: '2026-09-29T15:00:00.000Z', version: '1111111111111111' },
  { id: 'p-2', description: 'Look at the gap under the garage door', source: 'text', madeAt: '2026-09-27T16:00:00.000Z', version: '2222222222222222' },
];

function Harness({ promises = PROMISES, onMarks = () => {} }) {
  const [marks, setMarks] = useState({});
  return (
    <PromiseCheck
      promises={promises}
      marks={marks}
      onChange={(next) => { setMarks(next); onMarks(next); }}
    />
  );
}

afterEach(cleanup);

describe('PromiseCheck', () => {
  it('lists each open promise with where it was made', () => {
    render(<Harness />);
    expect(screen.getByText('Promises we made')).toBeTruthy();
    expect(screen.getByText('2 open')).toBeTruthy();
    expect(screen.getByText('Check under the dishwasher and the kitchen sink')).toBeTruthy();
    expect(screen.getByText('Phone call · Sep 29')).toBeTruthy();
    expect(screen.getByText('Text · Sep 27')).toBeTruthy();
    expect(screen.getByText(/Marking is never required to complete/)).toBeTruthy();
  });

  it('marks a promise, and tapping the same mark again leaves it blank', () => {
    let latest = {};
    render(<Harness onMarks={(next) => { latest = next; }} />);
    const group = screen.getByRole('group', { name: 'Mark: Check under the dishwasher and the kitchen sink' });
    const done = group.querySelector('button');
    fireEvent.click(done);
    expect(done.getAttribute('aria-pressed')).toBe('true');
    expect(latest).toEqual({ 'p-1': { mark: 'done', version: '1111111111111111', stillLeft: '' } });
    fireEvent.click(done);
    expect(done.getAttribute('aria-pressed')).toBe('false');
    expect(latest).toEqual({});
  });

  it('Partly asks what is still left', () => {
    let latest = {};
    render(<Harness onMarks={(next) => { latest = next; }} />);
    expect(screen.queryByText('What’s still left?')).toBeNull();
    const group = screen.getByRole('group', { name: 'Mark: Look at the gap under the garage door' });
    fireEvent.click([...group.querySelectorAll('button')].find((button) => button.textContent === 'Partly'));
    const input = screen.getByLabelText('What’s still left?');
    expect(input.getAttribute('maxLength')).toBe(String(STILL_LEFT_MAX));
    fireEvent.change(input, { target: { value: 'the left side' } });
    expect(latest).toEqual({ 'p-2': { mark: 'partly', version: '2222222222222222', stillLeft: 'the left side' } });
  });

  it('shows nothing without promises', () => {
    const { container } = render(<Harness promises={[]} />);
    expect(container.textContent).toBe('');
  });
});

describe('promise mark helpers', () => {
  it('the request carries marked, listed promises only, with the wording version seen, a still-left note on Partly only', () => {
    expect(promiseMarksPayload({
      'p-1': { mark: 'done', version: '1111111111111111', stillLeft: 'stale text' },
      'p-2': { mark: 'partly', version: '2222222222222222', stillLeft: '  the left side ' },
      'p-9': { mark: 'done', version: '9999999999999999' }, // no longer listed
      'p-3': { mark: 'maybe', version: '3333333333333333' },
    }, [...PROMISES, { id: 'p-3', description: 'x', version: '3333333333333333' }])).toEqual([
      { id: 'p-1', mark: 'done', version: '1111111111111111' },
      { id: 'p-2', mark: 'partly', version: '2222222222222222', stillLeft: 'the left side' },
    ]);
  });

  it('a mark made against older wording reads as unmarked and is never sent', () => {
    const marks = { 'p-1': { mark: 'done', version: '0000000000000000', stillLeft: '' } };
    expect(promiseMarksPayload(marks, PROMISES)).toEqual([]);
    render(<PromiseCheck promises={PROMISES} marks={marks} onChange={() => {}} />);
    const group = screen.getByRole('group', { name: 'Mark: Check under the dishwasher and the kitchen sink' });
    expect([...group.querySelectorAll('button')].some((button) => button.getAttribute('aria-pressed') === 'true')).toBe(false);
  });

  it('says when only the newest promises are shown', () => {
    expect(promiseCountLabel(2, 2)).toBe('2 open');
    expect(promiseCountLabel(10, 14)).toBe('10 of 14 open');
    expect(promiseCountLabel(3, null)).toBe('3 open');
    render(<PromiseCheck promises={PROMISES} total={14} marks={{}} onChange={() => {}} />);
    expect(screen.getByText('2 of 14 open')).toBeTruthy();
  });

  it('the staleness signature ignores whether the list has loaded and the order of entry', () => {
    const a = promiseMarksSignature({ 'p-2': { mark: 'partly', version: 'v2', stillLeft: 'x ' }, 'p-1': { mark: 'done', version: 'v1', stillLeft: 'y' } });
    const b = promiseMarksSignature({ 'p-1': { mark: 'done', version: 'v1' }, 'p-2': { mark: 'partly', version: 'v2', stillLeft: 'x' } });
    expect(a).toEqual(b);
    expect(promiseMarksSignature({ 'p-1': { mark: 'nope' } })).toEqual([]);
  });

  it('labels the source and day', () => {
    expect(promiseSourceLabel({ source: 'email', madeAt: '2026-10-01T14:00:00.000Z' })).toBe('Email · Oct 1');
    expect(promiseSourceLabel({ source: 'call', madeAt: null })).toBe('Phone call');
  });
});
