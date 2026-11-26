import { createContext, useContext } from 'react';

// The sign-in context lives in its own file so the Face ID lock can read it
// without importing the API client (which reads localStorage at load and
// breaks node-environment tests that render the lock).
export const AuthContext = createContext(null);

// Same as useAuth, but null outside an AuthProvider.
export function useOptionalAuth() {
  return useContext(AuthContext);
}
