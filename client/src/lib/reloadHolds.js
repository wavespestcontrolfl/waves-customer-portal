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

// Every registered work that holds the reload now, in registration order.
export function reloadHoldNames() {
  const names = [];
  for (const [name, isHeld] of checks) {
    let held;
    try { held = Boolean(isHeld()); } catch { held = true; }
    if (held) names.push(name);
  }
  return names;
}

// The first of them, or null.
export function reloadHoldName() {
  return reloadHoldNames()[0] ?? null;
}

// A send that prepares its data before its request starts (photos resized,
// a sketch or a map drawn into an image) has no save open until then. It runs
// through here and holds the reload by name from its start until it settles,
// failed or not. Returns what `work` returns.
const sendsOpen = new Map();

export async function holdReloadWhileSending(name, work) {
  if (!sendsOpen.has(name)) registerReloadHold(name, () => sendsOpen.get(name) > 0);
  sendsOpen.set(name, (sendsOpen.get(name) ?? 0) + 1);
  try {
    return await work();
  } finally {
    sendsOpen.set(name, sendsOpen.get(name) - 1);
  }
}
