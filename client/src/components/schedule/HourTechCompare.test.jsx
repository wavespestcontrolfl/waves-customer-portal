// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import HourTechCompare from './HourTechCompare';
import { normalizePickedByTech } from './useBestTimes';

afterEach(cleanup);

const ROWS = [
  { start: '13:00', technicianId: 't-b', technicianName: 'Tech B', detourMinutes: 12, driveInMinutes: 9, fromHomeBase: false, fromName: 'Sample Stop' },
  { start: '13:00', technicianId: 't-a', technicianName: 'Tech A', detourMinutes: 34, driveInMinutes: 30, fromHomeBase: true, fromName: null },
];

describe('HourTechCompare', () => {
  it('lists each free tech with the drive it adds, best first, and books the tapped one', () => {
    const onPick = vi.fn();
    render(<HourTechCompare rows={ROWS} onPick={onPick} />);
    expect(screen.getByText('Free at 1:00 PM')).toBeInTheDocument();
    expect(screen.getByText('Best fit')).toBeInTheDocument();
    expect(screen.getByText('9 min drive from Sample Stop · +12 min added to route')).toBeInTheDocument();
    expect(screen.getByText('30 min drive from home base · +34 min added to route')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Tech A/ }));
    expect(onPick).toHaveBeenCalledWith(ROWS[1]);
  });

  it('withholds "Best fit" when the first route was not priced', () => {
    render(<HourTechCompare rows={[{ ...ROWS[0], detourMinutes: null }, { ...ROWS[1], detourMinutes: null }]} />);
    expect(screen.queryByText('Best fit')).toBeNull();
  });

  it('renders nothing without rows and no "Best fit" for a single tech', () => {
    const { container, rerender } = render(<HourTechCompare rows={[]} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<HourTechCompare rows={[ROWS[0]]} />);
    expect(screen.queryByText('Best fit')).toBeNull();
  });
});

describe('normalizePickedByTech', () => {
  it('keeps fits with a tech and maps the server fields', () => {
    expect(normalizePickedByTech([
      { start: '13:00', fits: true, detour_minutes: 12, drive_in_minutes: 9, from_home_base: false, from_name: 'S', technician: { id: 't-b', name: 'Tech B' } },
      { start: '13:00', fits: false, technician: { id: 't-c', name: 'Tech C' } },
      { start: '13:00', fits: true, technician: null },
    ])).toEqual([{ start: '13:00', technicianId: 't-b', technicianName: 'Tech B', detourMinutes: 12, driveInMinutes: 9, fromHomeBase: false, fromName: 'S' }]);
    expect(normalizePickedByTech(undefined)).toEqual([]);
  });
});
