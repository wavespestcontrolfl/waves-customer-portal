// Product-application identity for customer report surfaces.
//
// A station check is a device inspection, not an application — but `method`
// alone cannot be trusted: methodFromProduct INFERS 'station_check' for any
// termite or rodent product with a null application_method, and the
// completion panel DEFAULTS methodless termite products to station_check and
// persists it (methodInferred false). So a historical liquid or a freshly
// recorded Termidor Foam row would read as a device check and vanish from
// the record while the advisory says treatment occurred.
//
// Identity decides, and the signal is PESTICIDE identity — an EPA
// registration or a pesticide product type. Bait / station / cartridge /
// monitor product FAMILIES are never applications, whatever their EPA
// number (codex P1 r19). Mirrors the server's isNonBaitPesticideProduct
// (#3516 r11). Shared by the PDF document and the live report so both
// surfaces answer "did a product get applied?" with ONE rule.

// Catalog rows for unregistered products (fertilizers, wetting agents,
// mechanical devices) store the literal "N/A" — printing it under EPA Reg.
// No. reads like missing paperwork. Mirrors applicationEpaReg.
export function epaReg(app) {
  const raw = String(app?.product?.epa_reg || app?.epaReg || '').trim();
  if (/^n\/?a$/i.test(raw) || /^none$/i.test(raw)) return '';
  return raw;
}

export function isProductApplication(app) {
  if (!app) return false;
  if ((app.method || 'perimeter_spray') !== 'station_check') return true;
  const identity = `${app.product?.product_type || ''} ${app.product?.category || ''} ${app.product?.name || ''}`;
  if (/bait|station|cartridge|monitor/i.test(identity)) return false;
  if (epaReg(app)) return true;
  const kind = `${app.product?.product_type || ''} ${app.product?.category || ''}`.toLowerCase();
  return /pestic|termitic|insectic|herbic|fungic|rodentic/.test(kind);
}
