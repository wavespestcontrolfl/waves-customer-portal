function latLngToWebMercatorPoint(lat, lng) {
  const siny = Math.sin((Number(lat) * Math.PI) / 180);
  const clampedSiny = Math.min(Math.max(siny, -0.9999), 0.9999);

  return {
    x: 0.5 + Number(lng) / 360,
    y: 0.5 - Math.log((1 + clampedSiny) / (1 - clampedSiny)) / (4 * Math.PI),
  };
}

function latLngToPixel({
  lat,
  lng,
  bounds,
  width,
  height,
}) {
  const nw = latLngToWebMercatorPoint(bounds.north, bounds.west);
  const se = latLngToWebMercatorPoint(bounds.south, bounds.east);
  const p = latLngToWebMercatorPoint(lat, lng);

  return {
    x: ((p.x - nw.x) / (se.x - nw.x)) * width,
    y: ((p.y - nw.y) / (se.y - nw.y)) * height,
  };
}

module.exports = {
  latLngToPixel,
  latLngToWebMercatorPoint,
};
