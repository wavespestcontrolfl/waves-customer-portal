// Writes to the device's own storage (IndexedDB) that are still open. A
// reload cuts such a write off, and a closing page can start one: the
// completion panel saves its draft, photos included, as it unmounts. So an
// out-of-date tab waits for them before it reloads, as for API writes
// (portalReload.js), and the Reload bar names them as a save on its way.
// Each module that writes to IndexedDB counts every write from its call:
// completion-resume-store.js and adminTableViewCatalog.js.
let writes = 0;

export function deviceWritesInFlight() {
  return writes;
}

// Counts `work` from now until it settles, and returns it.
export function countDeviceWrite(work) {
  writes += 1;
  return Promise.resolve(work).finally(() => { writes -= 1; });
}
