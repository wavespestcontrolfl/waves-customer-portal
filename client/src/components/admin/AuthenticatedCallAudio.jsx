import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

/**
 * Call-recording player backed by an authenticated, user-initiated fetch.
 * Media tags cannot attach a Bearer header themselves, so the response is
 * converted to a same-page Blob URL. The staff JWT never appears in the DOM
 * or request URL, and recordings are not downloaded until someone asks for
 * one.
 *
 * Optional playback hooks for a synced transcript:
 * - `onTimeUpdate(seconds)` fires on the audio element's timeupdate.
 * - the forwarded ref exposes `seekTo(seconds)`. On a loaded recording it
 *   seeks and plays (inside the click's user activation). Before the
 *   recording is loaded it triggers the same user-initiated load (the
 *   caller's click IS the intent) and POSITIONS the playhead once the audio
 *   mounts — it does not try to play then: that would run after the fetch,
 *   outside any user gesture, and browsers reject audible autoplay there.
 *   The controls are visible at the seeked position; one press plays.
 */
const AuthenticatedCallAudio = forwardRef(function AuthenticatedCallAudio(
  {
    recordingId,
    controls = true,
    preload = "none",
    title,
    className,
    style,
    onTimeUpdate,
    ...audioProps
  },
  ref,
) {
  const id = recordingId == null ? "" : String(recordingId);
  const requestNumberRef = useRef(0);
  const audioRef = useRef(null);
  const pendingSeekRef = useRef(null);
  const [request, setRequest] = useState(null);
  const [loaded, setLoaded] = useState({
    id: "",
    sourceUrl: null,
    status: "idle",
  });

  const current = loaded.id === id
    ? loaded
    : { id, sourceUrl: null, status: "idle" };

  const loadRecording = useCallback(() => {
    if (!id || current.status === "loading" || current.status === "ready") return;
    setLoaded({ id, sourceUrl: null, status: "loading" });
    requestNumberRef.current += 1;
    setRequest({ id, number: requestNumberRef.current });
  }, [current.status, id]);

  const applySeek = useCallback((seconds, { play } = { play: true }) => {
    const el = audioRef.current;
    if (!el) return false;
    el.currentTime = Math.max(0, seconds);
    if (play) {
      const played = el.play?.();
      if (played && typeof played.catch === "function") played.catch(() => {});
    }
    return true;
  }, []);

  useImperativeHandle(ref, () => ({
    seekTo(seconds) {
      const target = Number(seconds);
      if (!Number.isFinite(target)) return;
      if (current.status === "ready" && applySeek(target)) return;
      pendingSeekRef.current = target;
      loadRecording();
    },
  }), [applySeek, current.status, loadRecording]);

  // A seek requested before the audio existed positions the playhead once
  // it mounts. No play() here — this runs after the fetch, outside the
  // click's user activation, where autoplay is commonly rejected.
  useEffect(() => {
    if (current.status !== "ready" || pendingSeekRef.current == null) return;
    const target = pendingSeekRef.current;
    pendingSeekRef.current = null;
    applySeek(target, { play: false });
  }, [applySeek, current.status]);

  useEffect(() => {
    if (!request || request.id !== id) return undefined;

    let disposed = false;
    let objectUrl = null;
    const controller = new AbortController();
    const token = localStorage.getItem("waves_admin_token");

    if (!token) {
      setLoaded({ id, sourceUrl: null, status: "error" });
      return () => controller.abort();
    }

    async function fetchRecording() {
      try {
        const response = await fetch(
          `${API_BASE}/admin/call-recordings/audio/${encodeURIComponent(id)}`,
          {
            headers: {
              Accept: "audio/mpeg,audio/*;q=0.9",
              Authorization: `Bearer ${token}`,
            },
            cache: "no-store",
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          throw new Error(`Unable to load recording (HTTP ${response.status})`);
        }

        const blob = await response.blob();
        if (disposed) return;

        objectUrl = URL.createObjectURL(blob);
        if (disposed) {
          URL.revokeObjectURL(objectUrl);
          objectUrl = null;
          return;
        }
        setLoaded({ id, sourceUrl: objectUrl, status: "ready" });
      } catch (error) {
        if (!disposed && error?.name !== "AbortError") {
          setLoaded({ id, sourceUrl: null, status: "error" });
        }
      }
    }

    fetchRecording();

    return () => {
      disposed = true;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, request]);

  const label = audioProps["aria-label"] || "Call recording";

  return (
    <div
      className={className}
      style={style}
      data-audio-state={current.status}
      aria-busy={current.status === "loading"}
    >
      {current.status === "ready" ? (
        <audio
          {...audioProps}
          ref={audioRef}
          controls={controls}
          preload={preload}
          src={current.sourceUrl}
          aria-label={label}
          title={title}
          onTimeUpdate={
            onTimeUpdate
              ? (e) => onTimeUpdate(e.currentTarget.currentTime)
              : undefined
          }
          style={{ width: "100%", height: "100%" }}
        />
      ) : current.status === "loading" ? (
        <div role="status" aria-live="polite" style={{ fontSize: 13 }}>
          Loading recording…
        </div>
      ) : (
        <div>
          {current.status === "error" && (
            <span role="alert" style={{ fontSize: 13, marginRight: 8 }}>
              Recording unavailable.
            </span>
          )}
          <button
            type="button"
            onClick={loadRecording}
            disabled={!id}
            aria-label={`${current.status === "error" ? "Retry" : "Load"} ${label.toLowerCase()}`}
            title={title}
            style={{
              minHeight: 32,
              padding: "5px 12px",
              border: "1px solid currentColor",
              borderRadius: 6,
              background: "transparent",
              color: "inherit",
              font: "inherit",
              fontSize: 13,
              fontWeight: 500,
              cursor: id ? "pointer" : "not-allowed",
            }}
          >
            {current.status === "error" ? "Retry recording" : "Load recording"}
          </button>
        </div>
      )}
    </div>
  );
});

export default AuthenticatedCallAudio;
