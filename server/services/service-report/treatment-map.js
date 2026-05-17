const METHOD_LABELS = {
  perimeter_spray: 'Perimeter spray',
  broadcast_spray: 'Broadcast spray',
  pin_stream: 'Pin stream',
  spot_treatment: 'Spot treatment',
  bait_placement: 'Bait placement',
  granular_broadcast: 'Granular broadcast',
  trunk_injection: 'Trunk injection',
  foliar_spray: 'Foliar spray',
  fog_ulv: 'Fog or ULV',
  station_check: 'Station check',
};

const VIEWBOX_W = 640;
const VIEWBOX_H = 340;

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : fallback;
}

function rectAttrs(g) {
  return `x="${num(g.x)}" y="${num(g.y)}" width="${num(g.w)}" height="${num(g.h)}"`;
}

function zoneCenter(zone) {
  const g = zone.geometry || {};
  if (g.cx != null && g.cy != null) return { x: num(g.cx), y: num(g.cy) };
  return { x: num(g.x) + num(g.w) / 2, y: num(g.y) + num(g.h) / 2 };
}

function zoneBox(zone) {
  const g = zone.geometry || {};
  if (g.cx != null && g.cy != null) {
    const r = num(g.r, 8);
    return { x: num(g.cx) - r, y: num(g.cy) - r, w: r * 2, h: r * 2 };
  }
  return { x: num(g.x), y: num(g.y), w: num(g.w), h: num(g.h) };
}

function renderZoneShape(zone, attrs = '') {
  const g = zone.geometry || {};
  if (g.cx != null && g.cy != null) {
    return `<circle cx="${num(g.cx)}" cy="${num(g.cy)}" r="${num(g.r, 8)}" ${attrs}/>`;
  }
  return `<rect ${rectAttrs(zoneBox(zone))} ${attrs}/>`;
}

function renderDefs() {
  return `<defs>
  <pattern id="lot-dot" width="12" height="12" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="0.8" fill="var(--color-border, #d4d4d4)"/></pattern>
  <pattern id="hatch-spray" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="8" stroke="var(--color-text-secondary, #525252)" stroke-width="0.6"/></pattern>
  <pattern id="hatch-light" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="9" stroke="var(--color-text-secondary, #525252)" stroke-width="0.5" opacity="0.6"/></pattern>
  <pattern id="hatch-wide" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="12" stroke="var(--color-text-secondary, #525252)" stroke-width="0.6"/></pattern>
  <pattern id="dots-fine" width="6" height="6" patternUnits="userSpaceOnUse"><circle cx="1.5" cy="1.5" r="0.7" fill="var(--color-text-secondary, #525252)"/></pattern>
  <pattern id="crosshatch" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M0 8L8 0M-2 2L2 -2M6 10L10 6M0 0L8 8M6 -2L10 2M-2 6L2 10" stroke="var(--color-text-secondary, #525252)" stroke-width="0.5"/></pattern>
</defs>`;
}

function renderFootprint(name, g, className) {
  if (!g) return '';
  return `<rect ${rectAttrs(g)} rx="2" class="${className}" data-footprint="${esc(name)}"/>`;
}

function treatmentForMethod(method) {
  if (method === 'pin_stream' || method === 'spot_treatment') return 'url(#dots-fine)';
  if (method === 'granular_broadcast') return 'url(#crosshatch)';
  if (method === 'foliar_spray') return 'url(#hatch-light)';
  if (method === 'fog_ulv') return 'url(#hatch-wide)';
  return 'url(#hatch-spray)';
}

function renderFogArrows(box) {
  const y = num(box.y) + num(box.h) / 2;
  const x = num(box.x);
  const w = num(box.w);
  return [0.25, 0.5, 0.75].map((pct) => {
    const ax = x + w * pct;
    return `<path d="M${num(ax - 10)} ${num(y + 8)}h20m-6 -5 6 5-6 5" fill="none" stroke="var(--color-text-secondary, #525252)" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join('');
}

function renderApplicationBadge(center, number) {
  return `<g class="app-badge" transform="translate(${num(center.x)} ${num(center.y)})"><circle r="8" class="app-badge-fill"/><text y="3.5" text-anchor="middle" class="app-badge-label">${esc(number)}</text></g>`;
}

function renderApplicationLayer(app, zonesById, fallbackSequenceStart, applicationNumber, zoneApplicationIds, applicationId) {
  const method = app.method || 'perimeter_spray';
  if (method === 'station_check') return '';

  let baitSeq = fallbackSequenceStart;
  const zoneIds = Array.isArray(app.zone_ids) ? app.zone_ids : [];
  const zones = zoneIds.map((id) => zonesById.get(String(id))).filter(Boolean);
  if (!zones.length) return '';
  const appId = String(applicationId || app.id || `application-${applicationNumber}`);

  const dataAttrs = [
    `data-application-id="${esc(appId)}"`,
    `data-map-number="${esc(applicationNumber)}"`,
    `data-product-name="${esc(app.product?.name || '')}"`,
    `data-epa-reg="${esc(app.product?.epa_reg || '')}"`,
    `data-method="${esc(method)}"`,
    `data-method-label="${esc(METHOD_LABELS[method] || method)}"`,
  ].join(' ');

  const content = zones.map((zone) => {
    const center = zoneCenter(zone);
    const zoneAppIds = zoneApplicationIds.get(String(zone.id)) || [appId];
    const appPosition = Math.max(0, zoneAppIds.indexOf(appId));
    const badgeCenter = {
      x: center.x,
      y: center.y + (appPosition - ((zoneAppIds.length || 1) - 1) / 2) * 18,
    };
    if (method === 'bait_placement') {
      const label = app.sequence || baitSeq++;
      return `<g class="bait-marker" data-zone-id="${esc(zone.id)}" data-marker-sequence="${esc(label)}"><circle cx="${badgeCenter.x}" cy="${badgeCenter.y}" r="8" class="app-badge-fill"/><text x="${badgeCenter.x}" y="${badgeCenter.y + 3.5}" text-anchor="middle" class="app-badge-label">${esc(applicationNumber)}</text></g>`;
    }
    if (method === 'trunk_injection') {
      return `<g data-zone-id="${esc(zone.id)}"><line x1="${center.x}" y1="${center.y - 7}" x2="${center.x}" y2="${center.y + 7}" class="app-stroke injection-marker"/>${renderApplicationBadge(badgeCenter, applicationNumber)}</g>`;
    }
    const box = zoneBox(zone);
    const arrows = method === 'fog_ulv' ? renderFogArrows(box) : '';
    return `<g data-zone-id="${esc(zone.id)}"><rect ${rectAttrs(box)} fill="${treatmentForMethod(method)}" class="app-overlay"/><rect ${rectAttrs(box)} class="app-overlay-outline"/>${arrows}${renderApplicationBadge(badgeCenter, applicationNumber)}</g>`;
  }).join('');

  return `<g class="app-layer" ${dataAttrs}>${content}</g>`;
}

function renderNorthIndicator(direction) {
  const map = { top: 'M584 42L592 22L600 42Z', right: 'M600 32L580 24V40Z', bottom: 'M584 22L592 42L600 22Z', left: 'M580 32L600 24V40Z' };
  return `<g class="north-indicator"><path d="${map[direction] || map.top}" class="map-ink-fill"/><text x="592" y="58" text-anchor="middle" class="map-small">N</text></g>`;
}

function renderScale(scaleFtPerUnit) {
  const label = scaleFtPerUnit ? `${num(scaleFtPerUnit * 10)} ft` : 'Scale';
  return `<g class="scale-legend"><line x1="532" y1="308" x2="592" y2="308" class="map-ink-stroke"/><line x1="532" y1="304" x2="532" y2="312" class="map-ink-stroke"/><line x1="592" y1="304" x2="592" y2="312" class="map-ink-stroke"/><text x="562" y="324" text-anchor="middle" class="map-small">${esc(label)}</text></g>`;
}

function renderMethodLegend(methods) {
  if (!methods.length) return '';
  const rows = methods.slice(0, 5).map((method, index) => {
    const y = 246 + index * 16;
    const swatch = method === 'bait_placement'
      ? `<circle cx="518" cy="${y - 4}" r="5" class="app-fill app-stroke"/>`
      : `<rect x="512" y="${y - 10}" width="12" height="10" fill="${treatmentForMethod(method)}" class="legend-swatch"/>`;
    return `${swatch}<text x="530" y="${y}" class="map-small">${esc(METHOD_LABELS[method] || method)}</text>`;
  }).join('');
  return `<g class="method-legend"><rect x="500" y="224" width="120" height="${24 + methods.slice(0, 5).length * 16}" rx="3" class="legend-box"/><text x="512" y="240" class="map-small map-label">Methods</text>${rows}</g>`;
}

function renderTreatmentMap(input) {
  const geometry = input.geometry || {};
  const lot = geometry.lot || { w: VIEWBOX_W, h: VIEWBOX_H };
  const zones = (input.zones || []).map((zone) => ({ ...zone, id: String(zone.id) }));
  const zonesById = new Map(zones.map((zone) => [String(zone.id), zone]));
  const applications = input.applications || [];
  const usedMethods = [];
  const seenMethods = new Set();
  for (const app of applications) {
    if (!app.method || app.method === 'station_check' || seenMethods.has(app.method)) continue;
    seenMethods.add(app.method);
    usedMethods.push(app.method);
  }

  let baitSequence = 1;
  const zoneApplicationIds = new Map();
  applications.forEach((app, index) => {
    const appId = String(app.id || `application-${index + 1}`);
    const zoneIds = Array.isArray(app.zone_ids) ? app.zone_ids : [];
    zoneIds.forEach((zoneId) => {
      const key = String(zoneId);
      const ids = zoneApplicationIds.get(key) || [];
      ids.push(appId);
      zoneApplicationIds.set(key, ids);
    });
  });
  const appLayers = applications.map((app, index) => {
    const appId = String(app.id || `application-${index + 1}`);
    const layer = renderApplicationLayer(app, zonesById, baitSequence, index + 1, zoneApplicationIds, appId);
    if (app.method === 'bait_placement') {
      const count = Array.isArray(app.zone_ids) ? app.zone_ids.length : 0;
      baitSequence += count;
    }
    return layer;
  }).join('');

  const zoneOutlines = zones.map((zone) => renderZoneShape(zone, `class="zone-outline" data-zone-id="${esc(zone.id)}"`)).join('');
  const zoneLabels = zones.map((zone) => {
    const box = zoneBox(zone);
    return `<text x="${num(box.x) + 5}" y="${num(box.y) + 13}" class="zone-letter">${esc(zone.letter || '')}</text>`;
  }).join('');
  const flags = (input.flags || []).map((flag) => {
    const zone = zonesById.get(String(flag.zone_id));
    if (!zone) return '';
    const center = zoneCenter(zone);
    return `<g class="flag-marker" data-zone-id="${esc(zone.id)}"><circle cx="${center.x}" cy="${center.y}" r="8" class="flag-fill"/><text x="${center.x}" y="${center.y + 4}" text-anchor="middle" class="flag-mark">!</text><text x="${center.x + 12}" y="${center.y + 4}" class="flag-label">${esc(flag.label)}</text></g>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEWBOX_W} ${VIEWBOX_H}" role="img" aria-label="Treatment map">
${renderDefs()}
<style>
.map-bg{fill:#fafafa}.lot-bg{fill:url(#lot-dot);stroke:#d4d4d4;stroke-width:.5}.footprint{fill:#f5f5f5;stroke:#a3a3a3;stroke-width:.5}.water{fill:#eef2f7;stroke:#a3a3a3;stroke-width:.5}.drive{fill:#f0f0f0;stroke:#a3a3a3;stroke-width:.5}.zone-outline{fill:none;stroke:#737373;stroke-width:.5;stroke-dasharray:4 4}.zone-letter,.map-small{font-family:Inter,Arial,sans-serif;font-size:10px;fill:#404040}.map-label{font-weight:600}.app-layer{cursor:pointer}.app-overlay{opacity:.5}.app-overlay-outline,.app-stroke{fill:none;stroke:#404040;stroke-width:.7}.app-fill{fill:#fff}.app-badge-fill{fill:#262626;stroke:#fff;stroke-width:1}.app-badge-label{font-family:Inter,Arial,sans-serif;font-size:8px;font-weight:700;fill:#fff}.bait-label{font-family:Inter,Arial,sans-serif;font-size:8px;fill:#111}.injection-marker{stroke-width:1.5}.flag-fill{fill:#b91c1c}.flag-mark{font-family:Inter,Arial,sans-serif;font-size:11px;font-weight:700;fill:#fff}.flag-label{font-family:Inter,Arial,sans-serif;font-size:10px;fill:#b91c1c}.map-ink-fill{fill:#262626}.map-ink-stroke{stroke:#262626;stroke-width:.7}.legend-box{fill:rgba(255,255,255,.92);stroke:#d4d4d4;stroke-width:.5}.legend-swatch{stroke:#404040;stroke-width:.5}
</style>
<rect width="${VIEWBOX_W}" height="${VIEWBOX_H}" class="map-bg"/>
<rect x="10" y="10" width="${num(lot.w, VIEWBOX_W - 20)}" height="${num(lot.h, VIEWBOX_H - 20)}" class="lot-bg"/>
${renderFootprint('house', geometry.house, 'footprint')}
${renderFootprint('garage', geometry.garage, 'footprint')}
${renderFootprint('lanai', geometry.lanai, 'footprint')}
${renderFootprint('pool', geometry.pool, 'water')}
${renderFootprint('drive', geometry.drive, 'drive')}
<g class="inspected-zones">${zoneOutlines}</g>
${appLayers}
<g class="zone-labels">${zoneLabels}</g>
<g class="flag-markers">${flags}</g>
${renderNorthIndicator(geometry.north_indicator)}
${renderScale(geometry.scale_ft_per_unit)}
${renderMethodLegend(usedMethods)}
</svg>`;
}

module.exports = {
  METHOD_LABELS,
  renderTreatmentMap,
};
