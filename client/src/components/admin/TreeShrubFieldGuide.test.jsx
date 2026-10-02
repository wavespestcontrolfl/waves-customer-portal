// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import TreeShrubFieldGuide from './TreeShrubFieldGuide';
import reference from '../../../../server/config/tree-shrub-field-guide.json';
import protocols from '../../../../server/config/protocols.json';
import { protocolCompletionDefaultSelections } from '../../lib/protocol-completion-defaults';
afterEach(cleanup);
const guide = { ...protocols.tree_shrub.visits[0].fieldGuide, month: 'Jan', ...reference };

test('expands one product at a time and never offers the soil kit for granules', () => {
  render(<TreeShrubFieldGuide guide={guide} />);
  fireEvent.click(screen.getByRole('button', { name: /Snapshot 2.5TG/ }));
  const selector = screen.getByLabelText('Equipment for Snapshot 2.5TG');
  expect(within(selector).getAllByRole('option').map(x => x.textContent)).toEqual(['LESCO handheld · 5 lb', 'LESCO push · 50 lb']);
  fireEvent.change(selector, { target: { value: 'push' } });
  expect(screen.getByText(/092807/)).toBeTruthy();
  expect(screen.queryByText(/Calibration needed|Dial setting/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Merit 2F/ }));
  expect(screen.queryByLabelText('Equipment for Snapshot 2.5TG')).toBeNull();
  expect(within(screen.getByLabelText('Equipment for Merit 2F')).getAllByRole('option')).toHaveLength(1);
  expect(screen.getByRole('link', { name: /Envu/ }).getAttribute('href')).toContain('Merit_2F');
});

test('truck amounts switch with equipment and palm quantities remain pounds', () => {
  render(<TreeShrubFieldGuide guide={guide} mode="tech" />);
  expect(screen.getByText('≈ 5¼ fl oz')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /TriTek/ }));
  const equipment = screen.getByLabelText('Equipment for TriTek 1%');
  expect(equipment.value).toBe('flowzone');
  fireEvent.change(equipment, { target: { value: 'bg' } });
  expect(screen.getByLabelText('Mix size').value).toBe('bg');
  expect(screen.getByText('≈ 1½ fl oz')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Mix size'), { target: { value: 'bg' } });
  expect(screen.getByText('≈ 1½ fl oz')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Mix size'), { target: { value: 'rig' } });
  expect(equipment.value).toBe('rig');
  // Fixed label-minimum doses round up, never below the 1% minimum.
  expect(screen.getByText('≈ 141 fl oz')).toBeTruthy();
  expect(screen.getByText('3.8 lb')).toBeTruthy();
  expect(screen.queryByText(/6x only|9x only|Look for scale/)).toBeNull();
});

test('suggested granular identities cannot inherit an unrelated catalog dose or tank total', () => {
  const response = { source: 'protocol_visit', programKey: 'tree_shrub', products: [{ id: 'palm', treeShrubKey: 'f8012', requiresDoseSelection: true }] };
  const rows = protocolCompletionDefaultSelections(response, [{ id: 'palm' }], () => ({ rate: 10, rateUnit: 'lb', totalAmount: 90, carrierGallons: 110 }));
  expect(rows[0]).toMatchObject({ rate: '', rateUnit: 'lb/palm', totalAmount: '', carrierGallons: '', amountUnit: 'lb' });
});
