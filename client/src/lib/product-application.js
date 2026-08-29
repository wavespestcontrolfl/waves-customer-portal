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
  const identity = `${app.product?.product_type || ''} ${app.product?.category || ''} ${app.product?.name || ''}`;
  // Monitoring-DEVICE identity first: a termite / rodent station, cartridge,
  // or monitor row is never an application whatever method the tech picked
  // (bait_placement, station_check, …) — the method shortcut below must not
  // admit it (codex P2 #3600 r7). Scoped to the termite/rodent monitoring
  // lines: an EPA-registered mosquito station (In2Care) IS an application
  // with active ingredients and precautions (codex P1 #3600 r16). Plain
  // "bait" is not a device signal either: an applied pest bait (Advion Ant
  // Bait Gel under bait_placement) is a real application (codex P1 r8).
  const monitoringLine = /\b(termite|termitic\w*|rodent|rodentic\w*|rats?|mouse|mice)\b/i.test(identity);
  const deviceToken = /station|cartridge|monitor/i.test(identity);
  if (monitoringLine && deviceToken) return false;
  // …and a termite / rodent BAIT is device work too, whatever the method: a
  // "Recruit HD Termite Bait" or rodenticide bait row recorded under
  // bait_placement loads a station, it does not treat the property. The
  // server authority (isNonBaitPesticideProduct) already excludes the whole
  // bait family; this mirror must not admit it through the method shortcut
  // (local codex P1 #3600 r36). Ordinary applied pest baits keep passing.
  if (monitoringLine && /bait/i.test(identity)) return false;
  if ((app.method || 'perimeter_spray') !== 'station_check') return true;
  // station_check context: checking a station baited with a registered
  // rodenticide / termiticide bait applies nothing, whatever its EPA number.
  if (/bait/i.test(identity)) return false;
  if (epaReg(app)) return true;
  const kind = `${app.product?.product_type || ''} ${app.product?.category || ''}`.toLowerCase();
  return /pestic|termitic|insectic|herbic|fungic|rodentic/.test(kind);
}
