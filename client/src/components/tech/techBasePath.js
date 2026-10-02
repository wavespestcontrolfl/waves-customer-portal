import { createContext, useContext } from 'react';

// Where the field workspace is mounted. The legacy /tech portal shell used
// '/tech'; inside Waves Admin the workspace lives at '/admin/today'. Every
// in-app navigation target in the field UI is built from this base. API
// request paths (/tech/services/..., /tech/line, ...) are server routes and
// never use it.
export const TechBasePathContext = createContext('/tech');

export function useTechBasePath() {
  return useContext(TechBasePathContext) || '/tech';
}
