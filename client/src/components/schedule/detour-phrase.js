// How a slot's added drive reads in the schedule surfaces (the availability
// strip's hour comparison and the Find-a-Time result detail).
//
// null detour = the engine could not price the route (a coordless anchor)
// — say so rather than claiming the stop is free.
export function detourPhrase(slot) {
  if (slot.detourMinutes == null) return 'route cost unknown';
  const detour = Math.round(Number(slot.detourMinutes) || 0);
  return detour > 0 ? `+${detour} min added to route` : 'no added drive';
}
