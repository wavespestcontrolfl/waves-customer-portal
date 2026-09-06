// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import VisitProtocol from './VisitProtocol';

const D = { card: '#fff', heading: '#18181b', muted: '#71717a', border: '#e4e4e7', bg: '#f4f4f5', white: '#fff', red: '#c8312f' };
const procedure = { name: 'Synthetic procedure', source: 'Service template', title: 'Visit 9 · Sep', objective: 'Document conditions.', steps: ['Inspect the marked area.'], conditional: ['Take a detail photo if needed.'], notes: ['Reference note for this procedure.'] };
const card = { strip: { program: 'Synthetic booked service' }, planBlocks: [{ message: 'Fixture block remains unresolved.' }], protocol: { procedure, addons: [{ name: 'Unmatched add-on', procedure: null, note: 'No protocol matched this add-on' }] } };
beforeEach(() => { vi.stubGlobal('scrollTo', vi.fn()); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('reads the selected procedure in place, keeps blocks visible, and restores focus after Escape', () => {
  const onJobCard = vi.fn();
  render(<VisitProtocol card={card} D={D} onJobCard={onJobCard} />);
  expect(screen.getByRole('alert')).toHaveTextContent('Fixture block remains unresolved.');
  expect(screen.getByText('No protocol matched this add-on')).toBeVisible();
  const opener = screen.getByRole('button', { name: 'Read SOP' });
  opener.focus();
  fireEvent.click(opener);
  const sheet = screen.getByRole('dialog', { name: 'Service SOP' });
  expect(within(sheet).getByText('Reference note for this procedure.')).toBeVisible();
  expect(sheet).toHaveFocus();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(opener).toHaveFocus();
  fireEvent.click(screen.getByRole('button', { name: 'View product checks and mixing amounts' }));
  expect(onJobCard).toHaveBeenCalledTimes(1);
});

it('does not offer a readable SOP for a missing published procedure', () => {
  render(<VisitProtocol card={{ ...card, protocol: { procedure: null, addons: [] } }} D={D} onJobCard={() => {}} />);
  expect(screen.getByText('No published procedure is available for this booked service.')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Read SOP' })).not.toBeInTheDocument();
});
