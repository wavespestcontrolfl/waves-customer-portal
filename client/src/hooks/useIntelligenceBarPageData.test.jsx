// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { IntelligenceBarPageDataProvider, useIntelligenceBarPageData, usePublishIntelligenceBarPageData } from './useIntelligenceBarPageData';

function Scope(props) { usePublishIntelligenceBarPageData(props); return null; }
function Read() { const data = useIntelligenceBarPageData(); return <output>{JSON.stringify(data)}</output>; }
afterEach(cleanup);

it('record overlay context replaces the page, restores it on close and never restores a departed page', () => {
  const tree = (page, overlay, appointment = 'appointment-a') => <IntelligenceBarPageDataProvider>
    {page && <Scope key="page" appointment_id={appointment} />}
    {overlay && <Scope key="overlay" overlay customer_id="customer-b" />}
    <Read />
  </IntelligenceBarPageDataProvider>;
  const view = render(tree(true, false));
  expect(screen.getByRole('status')).toHaveTextContent('appointment-a');
  view.rerender(tree(true, true));
  expect(screen.getByRole('status')).toHaveTextContent('customer-b');
  expect(screen.getByRole('status')).not.toHaveTextContent('appointment-a');
  view.rerender(tree(true, true, 'appointment-c'));
  expect(screen.getByRole('status')).toHaveTextContent('customer-b');
  view.rerender(tree(true, false));
  expect(screen.getByRole('status')).toHaveTextContent('appointment-a');
  view.rerender(tree(true, true));
  view.rerender(tree(false, true));
  expect(screen.getByRole('status')).toHaveTextContent('customer-b');
  view.rerender(tree(false, false));
  expect(screen.getByRole('status')).toHaveTextContent('null');
});
