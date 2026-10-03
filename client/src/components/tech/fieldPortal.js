import { createContext, useContext } from 'react';

// Field dialogs portal onto <body>, outside .tech-field. Inside the
// /admin/today workspace TodayShell provides 'tech-field-portal' here, and
// each field portal root adds it, so the admin font override (index.css)
// skips exactly those roots — never an admin portal such as the
// notification panel, and never the same dialog opened from an admin page
// (Codex #5573 r12).
export const FieldPortalClassContext = createContext('');

export function useFieldPortalClass() {
  return useContext(FieldPortalClassContext);
}
