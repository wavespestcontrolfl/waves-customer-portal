// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import Library from './Library';
import DocumentReader from './DocumentReader';
import { request } from './common';

vi.mock('./common', async () => ({ ...await vi.importActual('./common'), request: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);
const wording = (body = 'Current wording') => ({ title: 'QA policy', kind: 'policy', body, unresolved: [], metadata: { owner_role: 'Office Manager', review_on: '2099-01-01', citations: [], fields: [] }, sections: [{ id: 'scope', number: 1, title: 'Scope', html: `<p>${body}</p>` }] });
const draft = () => ({ document: { id: 'doc', template_key: 'qa', staff_kind: 'policy' }, version: { id: 'v1', version_number: 1 }, rendered: wording(), versions: [{ id: 'v1', number: 1 }], acknowledgments: [], records: [] });
const props = detail => ({ detail, people: [{ id: 'tech', name: 'QA Staff' }], selfId: 'tech', manage: true, onVersion: vi.fn(), onEdit: vi.fn(), onSaved: vi.fn() });

test('a delayed successful list request preserves an inaccessible-document error', async () => {
  let finishList;
  request.mockImplementation(path => {
    if (path === '/people') return Promise.resolve({ self_id: 'tech', people: [], can_manage: false });
    if (path.startsWith('/?')) return new Promise(resolve => { finishList = resolve; });
    return Promise.reject(new Error('Document not found'));
  });
  render(<MemoryRouter initialEntries={['/?document=missing']}><Library /></MemoryRouter>);
  expect(await screen.findByRole('alert')).toHaveTextContent('Document not found');
  await waitFor(() => expect(finishList).toBeTypeOf('function'));
  await act(async () => finishList({ documents: [] }));
  expect(screen.getByRole('alert')).toHaveTextContent('Document not found');
  expect(screen.queryByText('Loading document…')).not.toBeInTheDocument();
});

test('effective-date changes invalidate approval and ignore stale wording responses', async () => {
  const previews = [];
  request.mockImplementation((path, body) => path.endsWith('/preview') ? new Promise(resolve => previews.push({ body, resolve })) : Promise.resolve({}));
  render(<DocumentReader {...props(draft())} />);
  const approve = screen.getByLabelText('I reviewed the wording, authority, owner, citations and next-review date.');
  const issue = screen.getByRole('button', { name: 'Issue version 1' });
  await act(async () => previews[0].resolve({ rendered: wording('Reviewed wording'), preview_hash: 'first' }));
  fireEvent.click(approve);
  expect(issue).toBeEnabled();
  const date = screen.getByLabelText('Effective date and time (Eastern)');
  fireEvent.change(date, { target: { value: '2099-01-02T09:00' } });
  expect(approve).not.toBeChecked();
  expect(issue).toBeDisabled();
  fireEvent.change(date, { target: { value: '2099-01-03T09:00' } });
  await act(async () => previews[2].resolve({ rendered: wording('Future approved wording'), preview_hash: 'final' }));
  await act(async () => previews[1].resolve({ rendered: wording('Stale wording'), preview_hash: 'stale' }));
  expect(screen.getByText('Future approved wording')).toBeInTheDocument();
  expect(screen.queryByText('Stale wording')).not.toBeInTheDocument();
  fireEvent.click(approve); fireEvent.click(issue);
  await waitFor(() => expect(request).toHaveBeenCalledWith('/doc/issue', { version_id: 'v1', effective_at: '2099-01-03T09:00', preview_hash: 'final' }));
});

test('historical policies retain acknowledgment exports and cannot accept a new signature', () => {
  const detail = draft(); detail.version.content_hash = 'old'; detail.current_version_id = 'v2';
  detail.acknowledgments = [{ id: 'ack', technician_id: 'tech', signed_name: 'QA Staff', acknowledged_at: '2020-01-01T12:00:00Z' }];
  render(<DocumentReader {...props(detail)} />);
  expect(screen.getByRole('button', { name: 'Export signed acknowledgment' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Sign acknowledgment' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open current version' })).toBeEnabled();
});

test('historical form records remain readable and exportable with editing disabled', () => {
  const detail = draft(); detail.document.staff_kind = 'form'; detail.rendered.kind = 'form'; detail.version.content_hash = 'old'; detail.current_version_id = 'v2';
  detail.rendered.metadata.fields = [{ id: 'evidence', label: 'Evidence', type: 'text' }];
  detail.records = [{ id: 'record', owner_id: 'tech', answers: { evidence: 'QA evidence' }, completed_steps: [], created_at: '2020-01-01T12:00:00Z', due_at: '2020-01-02T12:00:00Z' }];
  render(<DocumentReader {...props(detail)} />);
  fireEvent.change(screen.getByLabelText('Saved records'), { target: { value: 'record' } });
  expect(screen.getByLabelText('Evidence')).toHaveValue('QA evidence');
  expect(screen.getByLabelText('Evidence')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Export record PDF' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Complete record' })).not.toBeInTheDocument();
});
