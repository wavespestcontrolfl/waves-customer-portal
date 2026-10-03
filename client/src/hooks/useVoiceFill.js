// client/src/hooks/useVoiceFill.js
//
// Fast Complete voice fill, the request half (GATE_FAST_COMPLETE_VOICE_FILL):
// POST /admin/dispatch/:serviceId/fast-complete/voice-fill with what the tech
// said, answered with the validated fill (products, visit, customerNote,
// officeNote, unclear). The sheet turns that into ordinary taps; nothing here
// is saved or completed.
//
//   status       idle | filling | done | error
//   result       the last fill, or null
//   error        a short message for the tech, or ''
//   unavailable  the gate is off (404): voice fill is not offered, silently
//
// The transcript lives only in the call: it is never kept in state, and the
// result never carries it.
import { useCallback, useEffect, useRef, useState } from 'react';

export const VOICE_FILL_ERROR = "Couldn't fill from your words — tap the answers instead";

const IDLE = { status: 'idle', result: null, error: '', unavailable: false };

export default function useVoiceFill({ request, serviceId, sheet }) {
  const [state, setState] = useState(IDLE);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Resolves to the fill, or null when there is none to apply.
  const fill = useCallback(async (transcript) => {
    const words = typeof transcript === 'string' ? transcript.trim() : '';
    if (!words) return null;
    setState((prev) => ({ ...prev, status: 'filling', error: '' }));
    try {
      const result = await request(`/admin/dispatch/${serviceId}/fast-complete/voice-fill`, {
        method: 'POST',
        body: JSON.stringify({ sheet, transcript: words }),
      });
      if (!mounted.current) return null;
      if (result?.enabled === false) {
        setState({ ...IDLE, unavailable: true });
        return null;
      }
      setState({ status: 'done', result, error: '', unavailable: false });
      return result;
    } catch (err) {
      if (!mounted.current) return null;
      // Gate off: the route answers 404 { enabled: false }. Not an error.
      if (Number(err?.status) === 404) setState({ ...IDLE, unavailable: true });
      else setState((prev) => ({ ...prev, status: 'error', error: VOICE_FILL_ERROR }));
      return null;
    }
  }, [request, serviceId, sheet]);

  return { ...state, fill };
}
