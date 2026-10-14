import { useCallback, useEffect, useState } from "react";
import { checkServerDictation, forgetServerDictation, knownServerDictation } from "./serverDictation";

// A storage read can throw (private window, blocked site data): no token, no server dictation.
export function readToken() {
  try {
    return localStorage.getItem("waves_admin_token");
  } catch {
    return null;
  }
}

/**
 * Whether this mic sends its clips to our server (GATE_SERVER_DICTATION).
 * Asked once per session on any browser that can record (serverDictation.js
 * caches the answer per login). Clip-mode mics (Fast Complete voice fill) never
 * ask. `dropServerMode()` is for a 404 from the clip route: the gate went off
 * mid-session, so the next tap uses the browser's mic again.
 */
export default function useServerDictationMode({ clipMode, recorderSupported }) {
  const [available, setAvailable] = useState(() => knownServerDictation(readToken()) === true);
  useEffect(() => {
    if (clipMode || !recorderSupported) {
      setAvailable(false);
      return undefined;
    }
    const token = readToken();
    if (!token) return undefined;
    let disposed = false;
    checkServerDictation(token).then((yes) => {
      if (!disposed) setAvailable(yes === true);
    });
    return () => {
      disposed = true;
    };
  }, [clipMode, recorderSupported]);
  const dropServerMode = useCallback(() => {
    forgetServerDictation();
    setAvailable(false);
  }, []);
  return { serverMode: !clipMode && recorderSupported && available, dropServerMode };
}
