// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PropertyGroupSwitcher } from './EstimateViewPage';

afterEach(cleanup);

describe('property group navigation', () => {
  const group = [
    { token: 'anchortoken', address: '1 Group Lane', status: 'expired', isCurrent: true },
    { token: 'livesiblingtoken', address: '2 Group Lane', status: 'sent', isCurrent: false },
    { address: '3 Group Lane', status: 'expired', isCurrent: false },
  ];

  it('keeps active siblings navigable and expired siblings as labeled summaries', () => {
    render(<PropertyGroupSwitcher group={group} />);
    expect(screen.getByText('This estimate covers 3 properties')).toBeInTheDocument();
    expect(screen.getAllByText('Expired', { exact: false })).toHaveLength(2);
    expect(screen.getByRole('link', { name: /2 Group Lane/ })).toHaveAttribute('href', '/estimate/livesiblingtoken');
    expect(screen.queryByRole('link', { name: /3 Group Lane/ })).not.toBeInTheDocument();
    expect(within(screen.getByText('3 Group Lane').closest('div')).queryByText('View')).not.toBeInTheDocument();
  });

  it('keeps preview navigation on reachable siblings', () => {
    render(<PropertyGroupSwitcher group={group} preview />);
    expect(screen.getByRole('link', { name: /2 Group Lane/ })).toHaveAttribute('href', '/estimate/livesiblingtoken?adminPreview=1');
  });
});
