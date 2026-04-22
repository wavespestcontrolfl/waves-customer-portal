import { createContext, useContext } from 'react';

// variant: "customer" | "admin" | null (no shell — treat as customer by default,
// but SerifHeading will warn if it finds an explicit "admin" context).
export const WavesShellContext = createContext({ variant: 'customer' });

export function useWavesShell() {
  return useContext(WavesShellContext);
}
