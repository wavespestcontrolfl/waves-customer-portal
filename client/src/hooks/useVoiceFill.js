// client/src/hooks/useVoiceFill.js
//
// Fast Complete voice fill, the request half (GATE_FAST_COMPLETE_VOICE_FILL).
// Owner ruling 2026-10-03 ("always our transcriber"): the mic's recording goes to
// POST /admin/dispatch/:serviceId/fast-complete/voice-fill/clip, which
// transcribes it with the sheet's own product names and answers with the
// validated fill (products, visit, customerNote, officeNote, unclear). The sheet
// turns that into taps the tech confirms; nothing here is saved or completed,
// and the words never reach the browser at all.
//
//   status       idle | filling | done | error
//   result       the last fill, or null
//   error        a short message for the tech, or ''
//   unavailable  the gate is off (404): voice fill is not offered, silently
import { useCallback, useEffect, useRef, useState } from 'react';

export const VOICE_FILL_ERROR = "Couldn't fill from your words — tap the answers instead";
export const VOICE_FILL_NOTHING_HEARD = "Didn't catch anything — tap the mic and try again";
export const VOICE_FILL_TOO_LONG = 'That was too long to fill at once — say it in shorter pieces';

const clipExtension = (type) => (type.includes('mp4') ? 'mp4' : type.includes('ogg') ? 'ogg' : type.includes('wav') ? 'wav' : type.includes('mpeg') ? 'mp3' : 'webm');

const IDLE = { status: 'idle', result: null, error: '', unavailable: false };

export default function useVoiceFill({ request, serviceId, sheet }) {
  const [state, setState] = useState(IDLE);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // The recording, sent whole: resolves to the fill, or null when there is none.
  const fillFromClip = useCallback(async (blob, durationSeconds) => {
    if (!blob || !blob.size) return null;
    setState((prev) => ({ ...prev, status: 'filling', error: '' }));
    try {
      const form = new FormData();
      const type = (blob.type || 'audio/webm').split(';')[0];
      form.append('sheet', sheet);
      if (Number.isFinite(durationSeconds) && durationSeconds > 0) form.append('duration_seconds', String(Math.round(durationSeconds)));
      form.append('audio', blob, `voice-fill.${clipExtension(type)}`);
      // The sheet's own request: the page's API origin and sign-in, with the
      // form sent as multipart. A refusal arrives as a thrown { status, code }.
      let result;
      try {
        result = await request(`/admin/dispatch/${encodeURIComponent(serviceId)}/fast-complete/voice-fill/clip`, { method: 'POST', body: form });
      } catch (err) {
        if (!mounted.current) return null;
        // Gate off: 404 { enabled: false }. Not an error.
        if (err?.status === 404) {
          setState({ ...IDLE, unavailable: true });
          return null;
        }
        if (err?.status === 413 && err?.code === 'clip_too_long') {
          setState((prev) => ({ ...prev, status: 'error', error: VOICE_FILL_TOO_LONG }));
          return null;
        }
        throw err;
      }
      if (!mounted.current) return null;
      if (!result || result.enabled === false) {
        setState({ ...IDLE, unavailable: true });
        return null;
      }
      if (result.heardNothing) {
        setState((prev) => ({ ...prev, status: 'error', error: VOICE_FILL_NOTHING_HEARD }));
        return null;
      }
      setState({ status: 'done', result, error: '', unavailable: false });
      return result;
    } catch {
      if (mounted.current) setState((prev) => ({ ...prev, status: 'error', error: VOICE_FILL_ERROR }));
      return null;
    }
  }, [request, serviceId, sheet]);

  return { ...state, fillFromClip };
}
