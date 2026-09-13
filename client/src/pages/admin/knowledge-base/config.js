export const CATEGORIES = [
  "operations",
  "pricing",
  "agronomics",
  "equipment",
  "apis",
  "sops",
  "pest-ecology",
  "customer-lifecycle",
  "chemicals",
  "scheduling",
  "credentials",
  "integrations",
  "protocols",
  "general",
];

export function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function parseObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

export function formatDate(value, includeTime = false) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unavailable";
  // Wall-clock fields render in the portal's canonical Eastern time, not the
  // admin's browser zone (AGENTS.md America/New_York discipline).
  const options = { timeZone: "America/New_York" };
  return includeTime ? date.toLocaleString(undefined, options) : date.toLocaleDateString(undefined, options);
}

