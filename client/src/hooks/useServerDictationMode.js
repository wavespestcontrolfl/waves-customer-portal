import { useCallback, useEffect, useState } from "react";
import { checkServerDictation, forgetServerDictation, knownLiveWords, knownServerDictation } from "./serverDictation";

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
 * mid-session, so the next tap uses the browser's mic again. `liveWords` is true when the
 * server will also show the words while the person talks (GATE_DICTATION_LIVE_WORDS).
 */
export default function useServerDictationMode({ clipMode, recorderSupported }) {
  const [available, setAvailable] = useState(() => knownServerDictation(readToken()) === true);
  const [liveWords, setLiveWords] = useState(() => knownLiveWords(readToken()));
  useEffect(() => {
    if (clipMode || !recorderSupported) {
      setAvailable(false);
      setLiveWords(false);
      return undefined;
    }
    const token = readToken();
    if (!token) return undefined;
    let disposed = false;
    checkServerDictation(token).then((yes) => {
      if (disposed) return;
      setAvailable(yes === true);
      setLiveWords(yes === true && knownLiveWords(token));
    });
    return () => {
      disposed = true;
    };
  }, [clipMode, recorderSupported]);
  const dropServerMode = useCallback(() => {
    forgetServerDictation();
    setAvailable(false);
    setLiveWords(false);
  }, []);
  const serverMode = !clipMode && recorderSupported && available;
  return { serverMode, liveWords: serverMode && liveWords, dropServerMode };
}
