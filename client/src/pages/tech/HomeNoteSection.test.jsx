// @vitest-environment jsdom
// "About this home": read, add, edit, the stale-save notice, and the quiet states. Staff only; the customer never sees it.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import HomeNoteSection, { homeNoteFor } from './HomeNoteSection';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const PATH = '/admin/customers/c1/home-note';
const CUSTOMER = 'c1';
const NOTE = { body: 'Side gate sticks. Dog stays inside.', revision: 3, updatedAt: '2026-11-26T15:00:00.000Z', updatedByFirstName: 'Ada' };
const refusal = (status, details, message = 'refused') => Object.assign(new Error(message), { status, details });
const puts = (request) => request.mock.calls.filter(([, options]) => options?.method === 'PUT');

describe('HomeNoteSection (office page: reads its own path)', () => {
  it('shows the note with who changed it and when', async () => {
    render(<HomeNoteSection request={vi.fn(async () => ({ note: NOTE, editable: true, customerId: CUSTOMER }))} path={PATH} />);
    expect(await screen.findByText(NOTE.body)).toBeInTheDocument();
    expect(screen.getByText('About this home')).toBeInTheDocument();
    expect(screen.getByText(/Updated Nov 26, 2026 by Ada/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('with no note shows one muted line and an Add note button', async () => {
    render(<HomeNoteSection request={vi.fn(async () => ({ note: null, editable: true, customerId: CUSTOMER }))} path={PATH} />);
    expect(await screen.findByText('No note yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add note' })).toBeInTheDocument();
  });

  it('saves an edit against the time the note had when editing started, and shows Saved.', async () => {
    const request = vi.fn(async (_path, options) => (options?.method === 'PUT'
      ? { note: { ...NOTE, body: 'New text', updatedAt: '2026-11-26T16:00:00.000Z' } }
      : { note: NOTE, editable: true, customerId: CUSTOMER }));
    render(<HomeNoteSection request={request} path={PATH} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const box = screen.getByLabelText('About this home');
    expect(box).toHaveValue(NOTE.body);
    fireEvent.change(box, { target: { value: 'New text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(screen.getByText('New text')).toBeInTheDocument();
    expect(puts(request)[0][0]).toBe(PATH);
    expect(JSON.parse(puts(request)[0][1].body)).toEqual({ body: 'New text', expectedRevision: NOTE.revision, expectedCustomerId: CUSTOMER });
  });

  it('counts past 1000 (a joined note can be longer), and will not save until it is shortened', async () => {
    const long = { ...NOTE, body: 'x'.repeat(1500) };
    const request = vi.fn(async () => ({ note: long, editable: true, customerId: CUSTOMER }));
    render(<HomeNoteSection request={request} path={PATH} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('About this home')).toHaveValue(long.body);
    expect(screen.getByText('1500/1000')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('About this home'), { target: { value: 'y'.repeat(1000) } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('on a stale save shows their newer text; Keep editing pins their time, Cancel drops the draft', async () => {
    const theirs = { ...NOTE, body: 'Their newer text', revision: 4, updatedAt: '2026-11-26T15:30:00.000Z', updatedByFirstName: 'Sam' };
    let calls = 0;
    const request = vi.fn(async (_path, options) => {
      if (options?.method !== 'PUT') return { note: NOTE, editable: true, customerId: CUSTOMER };
      calls += 1;
      if (calls === 1) throw refusal(409, { code: 'note_changed', note: theirs });
      return { note: { ...NOTE, body: 'Mine', updatedAt: '2026-11-26T16:00:00.000Z' } };
    });
    render(<HomeNoteSection request={request} path={PATH} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('About this home'), { target: { value: 'Mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Someone else changed this note.')).toBeInTheDocument();
    expect(screen.getByText('Their newer text')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('About this home')).toHaveValue('Mine');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(JSON.parse(puts(request)[0][1].body).expectedRevision).toBe(NOTE.revision);
    expect(JSON.parse(puts(request)[1][1].body).expectedRevision).toBe(4);
  });

  it('Cancel on a stale save shows the newer note and closes the editor', async () => {
    const theirs = { ...NOTE, body: 'Their newer text' };
    const request = vi.fn(async (_path, options) => {
      if (options?.method === 'PUT') throw refusal(409, { note: theirs });
      return { note: NOTE, editable: true, customerId: CUSTOMER };
    });
    render(<HomeNoteSection request={request} path={PATH} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(within(await screen.findByTestId('home-note-conflict')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('home-note-conflict')).toBeNull());
    expect(screen.getByText('Their newer text')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('shows the server\'s reason when a save is refused, and keeps the editor open', async () => {
    const request = vi.fn(async (_path, options) => {
      if (options?.method === 'PUT') throw refusal(400, {}, 'The note must be text.');
      return { note: null, editable: true, customerId: CUSTOMER };
    });
    render(<HomeNoteSection request={request} path={PATH} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add note' }));
    fireEvent.change(screen.getByLabelText('About this home'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The note must be text.')).toBeInTheDocument();
    expect(screen.getByLabelText('About this home')).toBeInTheDocument();
  });

  it('an unreadable success answer (no note field) keeps the draft and says the save is unconfirmed', async () => {
    const request = vi.fn(async (_path, options) => (options?.method === 'PUT' ? {} : { note: NOTE, editable: true, customerId: CUSTOMER }));
    render(<HomeNoteSection request={request} path={PATH} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('About this home'), { target: { value: 'Mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Could not confirm the save/)).toBeInTheDocument();
    expect(screen.getByLabelText('About this home')).toHaveValue('Mine');
    expect(screen.queryByText('Saved.')).toBeNull();
  });

  it('renders nothing for a 403 and offers Retry when the read fails', async () => {
    const { container } = render(<HomeNoteSection request={vi.fn(async () => { throw refusal(403, {}); })} path={PATH} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    cleanup();
    const flaky = vi.fn().mockRejectedValueOnce(refusal(500, {})).mockResolvedValueOnce({ note: NOTE, editable: true, customerId: CUSTOMER });
    render(<HomeNoteSection request={flaky} path={PATH} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(NOTE.body)).toBeInTheDocument();
  });
});

describe('HomeNoteSection inside the Visit Brief (note rides the brief answer)', () => {
  const services = [{ id: 'a' }, { id: 'b' }];
  const answered = (note) => ({ b: { brief: { homeNote: { note, customerId: CUSTOMER } } } });

  it('shows the note the brief carried without asking the server, and refreshes the brief after a save', async () => {
    const request = vi.fn(async () => ({ note: { ...NOTE, body: 'New text' } }));
    const onSaved = vi.fn();
    render(<HomeNoteSection request={request} services={services} byService={answered(NOTE)} onSaved={onSaved} />);
    expect(screen.getByText(NOTE.body)).toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(puts(request)[0][0]).toBe('/admin/schedule/b/home-note');
  });

  it('a brief that refreshes under an open editor does not move the pinned revision: Save sends the ORIGINAL one', async () => {
    const request = vi.fn(async () => ({ note: { ...NOTE, body: 'Mine' } }));
    const newer = { ...NOTE, body: 'Changed by someone', revision: 4, updatedAt: '2026-11-26T15:45:00.000Z' };
    const { rerender } = render(<HomeNoteSection request={request} services={services} byService={answered(NOTE)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('About this home'), { target: { value: 'Mine' } });
    rerender(<HomeNoteSection request={request} services={services} byService={answered(newer)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts(request)).toHaveLength(1));
    expect(JSON.parse(puts(request)[0][1].body)).toEqual({ body: 'Mine', expectedRevision: NOTE.revision, expectedCustomerId: CUSTOMER });
  });

  it('a refreshed brief brings a newer note down when no editor is open', async () => {
    const { rerender } = render(<HomeNoteSection request={vi.fn()} services={services} byService={answered(NOTE)} />);
    rerender(<HomeNoteSection request={vi.fn()} services={services} byService={answered({ ...NOTE, body: 'From the refreshed brief' })} />);
    expect(await screen.findByText('From the refreshed brief')).toBeInTheDocument();
  });

  it('null note reads No note yet; no member that carried the key shows nothing', () => {
    const { container, rerender } = render(<HomeNoteSection request={vi.fn()} services={services} byService={answered(null)} />);
    expect(screen.getByText('No note yet.')).toBeInTheDocument();
    rerender(<HomeNoteSection request={vi.fn()} services={services} byService={{ a: { brief: { brief: null } } }} />);
    expect(container).toBeEmptyDOMElement();
    expect(homeNoteFor(services, { a: { brief: { homeNote: { note: null, customerId: CUSTOMER } } }, b: { brief: { homeNote: { note: NOTE, customerId: CUSTOMER } } } })).toEqual({ id: 'a', note: null, customerId: CUSTOMER });
  });

  it('switching to another stop drops the open draft, and a late answer from the old stop is ignored', async () => {
    let release;
    const request = vi.fn((_path, options) => (options?.method === 'PUT' ? new Promise((resolve) => { release = () => resolve({ note: { ...NOTE, body: 'Mine' } }); }) : Promise.resolve({})));
    const onSaved = vi.fn();
    const { rerender } = render(<HomeNoteSection request={request} services={services} byService={answered(NOTE)} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('About this home'), { target: { value: 'Mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByLabelText('About this home')).toBeDisabled();
    const other = [{ id: 'z' }];
    rerender(<HomeNoteSection request={request} services={other} byService={{ z: { brief: { homeNote: { note: null, customerId: 'c2' } } } }} onSaved={onSaved} />);
    release();
    await waitFor(() => expect(screen.getByText('No note yet.')).toBeInTheDocument());
    expect(screen.queryByText('Saved.')).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
    expect(puts(request)[0][0]).toBe('/admin/schedule/b/home-note');
  });

  it('a visit that moved to another customer is refused: the error shows, no conflict card', async () => {
    const request = vi.fn(async () => { throw refusal(409, { code: 'customer_changed' }, 'This visit now belongs to another customer. Reload it.'); });
    render(<HomeNoteSection request={request} services={services} byService={answered(null)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    fireEvent.change(screen.getByLabelText('About this home'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/now belongs to another customer/)).toBeInTheDocument();
    expect(screen.queryByTestId('home-note-conflict')).toBeNull();
  });

  it('a refresh that omits the note (lookup failed) leaves an open draft exactly as typed, pinned route and revision intact', async () => {
    const request = vi.fn(async () => ({ note: { ...NOTE, body: 'Mine' } }));
    const { rerender } = render(<HomeNoteSection request={request} services={services} byService={answered(NOTE)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('About this home'), { target: { value: 'Half typed note' } });
    rerender(<HomeNoteSection request={request} services={services} byService={{ b: { brief: { brief: null } } }} />);
    expect(screen.getByLabelText('About this home')).toHaveValue('Half typed note');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts(request)).toHaveLength(1));
    expect(puts(request)[0][0]).toBe('/admin/schedule/b/home-note');
    expect(JSON.parse(puts(request)[0][1].body)).toEqual({ body: 'Half typed note', expectedRevision: NOTE.revision, expectedCustomerId: CUSTOMER });
  });

  it('a grouped stop that switches which member supplies the note (same customer) keeps the draft and its pin', async () => {
    const request = vi.fn(async () => ({ note: { ...NOTE, body: 'Mine' } }));
    const { rerender } = render(<HomeNoteSection request={request} services={services} byService={answered(NOTE)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('About this home'), { target: { value: 'Still mine' } });
    rerender(<HomeNoteSection request={request} services={services} byService={{ a: { brief: { homeNote: { note: { ...NOTE, revision: 5 }, customerId: CUSTOMER } } } }} />);
    expect(screen.getByLabelText('About this home')).toHaveValue('Still mine');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts(request)).toHaveLength(1));
    // Saved against the revision and route it was started from; the server answers 409 if the note moved on.
    expect(puts(request)[0][0]).toBe('/admin/schedule/b/home-note');
    expect(JSON.parse(puts(request)[0][1].body).expectedRevision).toBe(NOTE.revision);
  });
});
