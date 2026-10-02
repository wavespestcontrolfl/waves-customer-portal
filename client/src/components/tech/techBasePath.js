import { createContext, useContext } from 'react';

// Where the field workspace is mounted: '/admin/today' inside Waves Admin.
// /tech only redirects (TechPortalRedirect, for old bookmarks and installed
// apps), so nothing in the app links there (Codex #5573 r5). Every
// in-app navigation target in the field UI is built from this base. API
// request paths (/tech/services/..., /tech/line, ...) are server routes and
// never use it.
export const TechBasePathContext = createContext('/admin/today');

export function useTechBasePath() {
  return useContext(TechBasePathContext) || '/admin/today';
}
