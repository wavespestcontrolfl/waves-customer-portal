import { describe, expect, it, vi } from 'vitest';
import { buildSprayModel } from './mistingLayoutPublic';
import { createSprayEngine } from './mistingSprayEngine';

const GEOMETRY = {
  center: { lat: 27.5, lng: -82.5 },
  zoom: 20,
  lines: [{ kind: 'eave', points: [{ x: 400, y: 400 }, { x: 800, y: 400 }, { x: 800, y: 600 }, { x: 400, y: 600 }, { x: 400, y: 400 }] }],
  nozzles: [{ x: 600, y: 400, kind: 'eave', lineIndex: 0 }, { x: 700, y: 400, kind: 'eave', lineIndex: 0, aim: 90 }, { x: 'bad', y: 1 }],
  risers: [{ x: 450, y: 700, source: 'manual' }],
  pump: { x: 1, y: 1 },
  zones: [],
};

describe('buildSprayModel', () => {
  it('gives every nozzle and riser an aim: manual wins, the default points away from the house', () => {
    const model = buildSprayModel(GEOMETRY);
    expect(model.nozzles.map((n) => n.key)).toEqual(['n0', 'n1', 'r0']);
    expect(model.aims.get('n0')).toMatchObject({ heading: 0, manual: false, throwFt: 10 }); // top edge: away from the house is up
    expect(model.aims.get('n1')).toMatchObject({ heading: 90, manual: true });
    expect(model.aims.get('r0').manual).toBe(false);
    expect(model.lat).toBe(27.5);
    expect(model.zoom).toBe(20);
  });

  it('is null when the block cannot be drawn', () => {
    expect(buildSprayModel(null)).toBeNull();
    expect(buildSprayModel({ ...GEOMETRY, center: {} })).toBeNull();
    expect(buildSprayModel({ ...GEOMETRY, nozzles: [], risers: [] })).toBeNull();
  });
});

describe('createSprayEngine', () => {
  const recording = () => ({ clearRect: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), fillStyle: '' });

  it('spawns puffs at the nozzles and clears the frame on every tick', () => {
    const ctx = recording();
    const engine = createSprayEngine(ctx, () => buildSprayModel(GEOMETRY));
    engine.tick(1000);
    engine.tick(1050);
    engine.tick(1100);
    expect(ctx.clearRect).toHaveBeenCalledTimes(3);
    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 1280, 960);
    expect(ctx.arc).toHaveBeenCalled();
    engine.clear();
    expect(ctx.clearRect).toHaveBeenCalledTimes(4);
  });

  it('draws nothing when there are no nozzles', () => {
    const ctx = recording();
    const engine = createSprayEngine(ctx, () => ({ nozzles: [], aims: new Map(), lat: 27.5, zoom: 20 }));
    engine.tick(1000);
    engine.tick(1200);
    expect(ctx.arc).not.toHaveBeenCalled();
  });

  it('erases the mist around every nozzle when keepClearRadius is set, and not otherwise', () => {
    const model = buildSprayModel(GEOMETRY);
    const withClear = { ...recording(), save: vi.fn(), restore: vi.fn(), globalCompositeOperation: 'source-over' };
    const ops = [];
    Object.defineProperty(withClear, 'globalCompositeOperation', { set: (v) => ops.push(v), get: () => ops[ops.length - 1] });
    createSprayEngine(withClear, () => model, { keepClearRadius: 21 }).tick(1000);
    expect(ops).toContain('destination-out');
    model.nozzles.forEach((n) => expect(withClear.arc).toHaveBeenCalledWith(n.x, n.y, 21, 0, Math.PI * 2));

    const plain = recording();
    createSprayEngine(plain, () => model).tick(1000);
    expect(plain.arc.mock.calls.some((c) => c[2] === 21)).toBe(false);
  });
});

