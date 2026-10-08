// What an existing visit books, for the best-times rows' rain ranking: the
// primary service, the edit form's add-on lines, and a shared stop's other
// services. `serviceKeys` runs in the same order as `serviceTypes` ('' = no
// catalog key on hand; the server then reads the name).
export function visitServiceArgs(service, lines = []) {
  const items = [
    { name: service?.serviceType || service?.service_type, key: service?.serviceKey || service?.service_key },
    ...(lines || []).map((line) => ({ name: line?.serviceType, key: line?.serviceKey })),
    ...(Array.isArray(service?.visit?.serviceTypes) ? service.visit.serviceTypes : []).map((name) => ({ name })),
  ].filter((item) => typeof item.name === 'string' && item.name.trim());
  return { serviceTypes: items.map((item) => item.name), serviceKeys: items.map((item) => item.key || '') };
}
