// Work that a page reload would lose, or that would make the browser ask
// "Leave site?". Each module that keeps such work past a page move registers
// a check here when it loads, and a reload of an out-of-date staff tab asks
// reloadHoldName() first. A page's own unsaved state needs no entry: that
// reload only comes after a page move has already closed the page. A check
// that throws counts as held.
const checks = new Map();

export function registerReloadHold(name, isHeld) {
  checks.set(name, isHeld);
}

// The first registered work that holds the reload, or null.
export function reloadHoldName() {
  for (const [name, isHeld] of checks) {
    let held;
    try { held = Boolean(isHeld()); } catch { held = true; }
    if (held) return name;
  }
  return null;
}
