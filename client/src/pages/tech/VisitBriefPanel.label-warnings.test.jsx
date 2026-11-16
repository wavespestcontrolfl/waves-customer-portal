// @vitest-environment jsdom
// "Label warnings" section of the tech Visit Brief (facts.labelAnimalWarnings, lawn treatment visits only; the server picks
// the lines). The panel shows what the server sends and nothing else.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import VisitBriefPanel from './VisitBriefPanel';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const LAWN = { id: 'svc-1', status: 'confirmed', customerName: 'Pat Sample', customerPhone: '(941) 555-0100', address: '123 Palm Ave, Bradenton, FL 34205', serviceType: 'Lawn Care Treatment' };
const PEST = { id: 'svc-2', status: 'confirmed', customerName: 'Pat Sample', customerPhone: '(941) 555-0100', address: '123 Palm Ave, Bradenton, FL 34205', serviceType: 'Quarterly Pest Control' };

const GRAZING = 'Labels say no grazing on the treated lawn and no clippings as feed: Stonewall, Merit 2F.';
const WARNINGS = [
  { kind: 'grass_eater', label: 'Animals that eat grass', names: ['Shelly', 'tortoise'], lines: [GRAZING] },
  { kind: 'birds', label: 'Chickens or other birds', names: ['Henny'], lines: ['Toxic to birds: Topchoice (spread evenly to reduce the risk to birds) and Dylox.'] },
  { kind: 'fish_pond', label: 'Fish pond', names: ['Koi'], lines: ['Toxic to fish: Dimension, Talstar P.'] },
  { kind: 'beehives', label: 'Beehives', names: ['no name'], lines: ['Toxic to bees: Talstar P, Tetrino.'] },
];

function renderPanel(members) {
  const byService = Object.fromEntries(members.map(([svc, facts]) => [svc.id, { estimate: null, brief: { brief: null, facts } }]));
  const services = members.map(([svc]) => svc);
  render(
    <VisitBriefPanel
      stop={{ key: 'row:x', isVisit: services.length > 1, services, primary: services[0], liveCount: services.length }}
      detail={{ status: 'ready', byService }}
      request={vi.fn(async () => ({}))}
      onRetry={vi.fn()} onPhotos={vi.fn()} onProject={vi.fn()} onZone={vi.fn()} onLead={vi.fn()}
    />,
  );
}

describe('VisitBriefPanel label warnings', () => {
  it('a lawn visit shows each kind: heading with the names on file, then its lines', () => {
    renderPanel([[LAWN, { access: null, last_visit: null, labelAnimalWarnings: WARNINGS }]]);
    const section = screen.getByTestId('visit-brief-label-warnings');
    expect(section).toHaveTextContent('Label warnings');
    expect(screen.getByText('Animals that eat grass on file (Shelly, tortoise)')).toBeInTheDocument();
    expect(screen.getByText(GRAZING)).toBeInTheDocument();
    expect(screen.getByText('Chickens or other birds on file (Henny)')).toBeInTheDocument();
    expect(screen.getByText(/^Toxic to birds: Topchoice/)).toBeInTheDocument();
    expect(screen.getByText('Fish pond on file (Koi)')).toBeInTheDocument();
    expect(screen.getByText('Toxic to fish: Dimension, Talstar P.')).toBeInTheDocument();
    expect(screen.getByText('Beehives on file (no name)')).toBeInTheDocument();
    expect(screen.getByText('Toxic to bees: Talstar P, Tetrino.')).toBeInTheDocument();
  });

  it.each([
    ['no field (dogs, cats, Other, or a non-lawn visit)', { access: null, last_visit: null }],
    ['an empty list', { access: null, last_visit: null, labelAnimalWarnings: [] }],
    ['a shape it does not know', { access: null, last_visit: null, labelAnimalWarnings: [{ foo: 1 }, null, 'x'] }],
    ['a value that is not a list', { access: null, last_visit: null, labelAnimalWarnings: 'Toxic to fish' }],
  ])('%s: no section', (_label, facts) => {
    renderPanel([[PEST, facts]]);
    expect(screen.queryByTestId('visit-brief-label-warnings')).toBeNull();
    expect(screen.queryByText('Label warnings')).toBeNull();
  });

  it('a grouped stop shows the lawn member\'s warnings once, while the other member carries none', () => {
    renderPanel([
      [PEST, { access: null, last_visit: null }],
      [LAWN, { access: null, last_visit: null, labelAnimalWarnings: [WARNINGS[0]] }],
    ]);
    expect(screen.getAllByTestId('visit-brief-label-warnings')).toHaveLength(1);
    expect(screen.getAllByText(GRAZING)).toHaveLength(1);
  });
});
