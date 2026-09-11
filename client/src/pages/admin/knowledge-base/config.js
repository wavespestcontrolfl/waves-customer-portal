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
  return includeTime ? date.toLocaleString() : date.toLocaleDateString();
}

export function sentenceCase(value, fallback = "Unknown") {
  if (!value) return fallback;
  const normalized = String(value).replace(/[_-]+/g, " ");
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
}
