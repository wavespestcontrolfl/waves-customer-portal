export const STATIC_COMPOSER_LINKS = [
  {
    key: "portal_login",
    name: "Portal login",
    url: "portal.wavespestcontrol.com/login",
    clause: "Manage your account and appointments here",
    keywords: "portal login account app sign in manage",
  },
  // Cancellation lands IN the portal (owner ruling 2026-09-03): the cancel
  // flow lives on the My Plan tab behind login, so the link is the login
  // page with the plan tab as its post-login destination (LoginPage's
  // safeNextPath honors ?next=; same encoded form the project emails use).
  {
    key: "cancel_plan",
    name: "Cancel plan link",
    url: "portal.wavespestcontrol.com/login?next=%2F%3Ftab%3Dplan",
    clause: "You can review or cancel your plan from your account here",
    keywords: "cancel cancellation stop plan end service quit",
  },
].map((link) => ({ ...link, category: "customer" }));

// Append a static link clause to the composer body (empty body gets the
// clause alone). Returns the body unchanged when the URL is already present
// — a second click must not stack a duplicate link.
export function appendStaticLinkClause(body, { url, clause }) {
  const b = String(body || "");
  if (b.includes(url)) return b;
  if (!b.trim()) return clause;
  return `${b.replace(/\s+$/, "")}\n\n${clause}`;
}

// The rendered insert text for a library row: "{clause}: {url}" with the
// row's name standing in when no clause was authored (sitemap rows).
export function libraryLinkClause(link) {
  const prefix = String(link.clause || "").trim() || String(link.name || "").trim() || "More info";
  return `${prefix}: ${link.url}`;
}

