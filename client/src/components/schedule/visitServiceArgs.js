// What an existing visit books, for the best-times rows' rain ranking: the
// primary service, the edit form's add-on lines, and a shared stop's other
// services. `serviceKeys` runs in the same order as `serviceTypes` ('' = no
// catalog key on hand; the server then reads the name).
export function visitServiceArgs(service, lines = []) {
  const items = [
    { name: service?.serviceType || service?.service_type, key: service?.serviceKey || service?.service_key },
    ...(lines || []).map((line) => ({ name: line?.serviceType, key: line?.serviceKey })),
    // The stop's list names the primary service too: drop that one entry.
    ...(Array.isArray(service?.visit?.serviceTypes) ? service.visit.serviceTypes : [])
      .filter((name, i, all) => i !== all.indexOf(service.serviceType || service.service_type))
      .map((name) => ({ name })),
  ].filter((item) => typeof item.name === 'string' && item.name.trim());
  return { serviceTypes: items.map((item) => item.name), serviceKeys: items.map((item) => item.key || '') };
}
