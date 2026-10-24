// @vitest-environment jsdom
// Multi-property invoice rows: each property's address heads its own lines,
// the line-item discount under that property, and a per-property subtotal.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { groupInvoiceLinesByProperty } from '@waves/invoice-property-groups';

import PropertyLineGroups from './PropertyLineGroups';

const fmt = (n) => `$${Number(n).toFixed(2)}`;
const palm = { address_line1: '1842 Palm Harbor Dr', address_line2: null, city: 'Bradenton', state: 'FL', zip: '34209' };
const bay = { address_line1: '410 Bayshore Rd', address_line2: null, city: 'Parrish', state: 'FL', zip: '34219' };
const lineItems = [
  { client_id: 'a', description: 'Quarterly pest control service', quantity: 1, unit_price: 149, amount: 149, property_id: 'p1', property_address: palm },
  { client_id: 'a-d', _kind: 'discount', discount_for: 'a', description: 'Multi-Home Discount (10%)', quantity: 1, unit_price: -14.9, amount: -14.9, property_id: 'p1', property_address: palm },
  { client_id: 'b', description: 'Quarterly pest control service', quantity: 1, unit_price: 149, amount: 149, property_id: 'p2', property_address: bay },
  { client_id: 'b-d', _kind: 'discount', discount_for: 'b', description: 'Multi-Home Discount (10%)', quantity: 1, unit_price: -14.9, amount: -14.9, property_id: 'p2', property_address: bay },
];

afterEach(cleanup);

describe('PropertyLineGroups', () => {
  it('renders a heading per property with its discount row and subtotal', () => {
    const groups = groupInvoiceLinesByProperty(lineItems);
    render(<PropertyLineGroups groups={groups} fmtCurrency={fmt} />);
    const headings = screen.getAllByTestId('property-group-heading').map((el) => el.textContent);
    expect(headings).toEqual(['1842 Palm Harbor Dr, Bradenton, FL 34209', '410 Bayshore Rd, Parrish, FL 34219']);
    expect(screen.getAllByText('Quarterly pest control service')).toHaveLength(2);
    expect(screen.getAllByText('Multi-Home Discount (10%)')).toHaveLength(2);
    expect(screen.getAllByText('− $14.90')).toHaveLength(2);
    expect(screen.getByText('1842 Palm Harbor Dr subtotal')).toBeInTheDocument();
    expect(screen.getByText('410 Bayshore Rd subtotal')).toBeInTheDocument();
    expect(screen.getAllByText('$134.10')).toHaveLength(2);
  });

  it('a single-property invoice has no groups to render', () => {
    expect(groupInvoiceLinesByProperty(lineItems.slice(0, 2))).toBeNull();
  });
});
