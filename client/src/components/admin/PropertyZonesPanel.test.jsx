// @vitest-environment jsdom
// Desk-backfill entry composition (satellite coverage — Customer 360 panel).
// The server contract (PR #2386) is strict: one entry per label, only touched
// labels submit, drawn shapes carry the served image's params as their drift
// ref, and removing a PRELOADED mark must send a clear tombstone.
import { describe, expect, it } from 'vitest';
import { composeZoneShapeEntries } from './Customer360ProfileV2';

const IMAGE = {
  center: { lat: 27.3364, lng: -82.5307 },
  zoom: 20,
  width: 640,
  height: 340,
};
const CAPTURED = '2026-07-05T15:00:00.000Z';
const SHAPE = { type: 'circle', cx: 0.5, cy: 0.5, r: 0.07 };

describe('composeZoneShapeEntries', () => {
  it('drawn shapes submit with the served image params as the drift ref', () => {
    const entries = composeZoneShapeEntries({
      areas: ['Perimeter'],
      marks: { Perimeter: SHAPE },
      dirty: new Set(['Perimeter']),
      preloads: {},
      image: IMAGE,
      capturedAt: CAPTURED,
    });
    expect(entries).toEqual([{
      areaLabel: 'Perimeter',
      shape: {
        ...SHAPE,
        ref: { lat: IMAGE.center.lat, lng: IMAGE.center.lng, zoom: 20, width: 640, height: 340, capturedAt: CAPTURED },
      },
    }]);
  });

  it('removing a preloaded mark sends a clear tombstone; removing a session mark sends nothing', () => {
    const entries = composeZoneShapeEntries({
      areas: ['Perimeter', 'Yard'],
      marks: { Perimeter: null, Yard: null },
      dirty: new Set(['Perimeter']), // Yard was a session mark → un-dirtied on removal
      preloads: { perimeter: { type: 'rect', x: 0.1, y: 0.1, w: 0.3, h: 0.2 } },
      image: IMAGE,
      capturedAt: CAPTURED,
    });
    expect(entries).toEqual([{ areaLabel: 'Perimeter', clear: true }]);
  });

  it('untouched labels never submit (a resubmitted preload would restamp its drift ref)', () => {
    const entries = composeZoneShapeEntries({
      areas: ['Perimeter', 'Yard'],
      marks: { Yard: SHAPE },
      dirty: new Set(['Yard']),
      preloads: { perimeter: { type: 'rect', x: 0.1, y: 0.1, w: 0.3, h: 0.2 } },
      image: IMAGE,
      capturedAt: CAPTURED,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].areaLabel).toBe('Yard');
  });
});
