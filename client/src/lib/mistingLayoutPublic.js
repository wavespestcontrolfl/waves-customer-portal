// The customer estimate page's view of a saved misting layout (GATE_MISTING_LAYOUT_DESIGNER): turns the public
// `mistingLayout.geometry` block of GET /api/estimates/:token/data into what the spray engine needs, using the same
// aim rules as the staff designer and the saved picture (mistingLayoutAim). React-free.
import { effectiveAim } from './mistingLayoutAim';

export const LAYOUT_MAP_WIDTH = 1280;
export const LAYOUT_MAP_HEIGHT = 960;

const isPoint = (p) => Boolean(p) && Number.isFinite(p.x) && Number.isFinite(p.y);

/**
 * @param {object|null|undefined} geometry the public block: { center:{lat,lng}, zoom, lines, nozzles, risers, pump, zones }
 * @returns {{nozzles: Array<{key:string,x:number,y:number}>, aims: Map<string, object>, lat: number, zoom: number}|null}
 *   null when the block cannot be drawn (the page then shows the still picture only)
 */
export function buildSprayModel(geometry) {
  const lat = Number(geometry?.center?.lat);
  const zoom = Number(geometry?.zoom);
  if (!Number.isFinite(lat) || !Number.isFinite(zoom)) return null;
  const lines = Array.isArray(geometry.lines) ? geometry.lines : [];
  const zones = Array.isArray(geometry.zones) ? geometry.zones : [];
  const map = { lat, zoom };
  const sprayers = [];
  const aims = new Map();
  // Every nozzle sprays, and so does every riser (it carries a nozzle): the designer's own rule.
  const add = (prefix, list) => (Array.isArray(list) ? list : []).forEach((item, i) => {
    if (!isPoint(item)) return;
    const key = `${prefix}${i}`;
    sprayers.push({ key, x: item.x, y: item.y });
    aims.set(key, effectiveAim(item, lines, zones, map));
  });
  add('n', geometry.nozzles);
  add('r', geometry.risers);
  // `nozzles` is every sprayer (nozzles and risers): the shape the spray engine reads.
  return sprayers.length ? { nozzles: sprayers, aims, lat, zoom } : null;
}
