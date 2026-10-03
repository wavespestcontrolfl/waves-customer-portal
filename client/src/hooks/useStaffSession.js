import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  clearStaffDeviceData,
  getAdminAuthToken,
  loadStaffOfflinePass,
  saveStaffOfflinePass,
} from "../lib/adminAuth";
import { isFieldPath } from "../lib/adminBookmarkMeta";
import { installStaffSessionGuard } from "../lib/staffSessionGuard";
import { adminFetch, adminLoginUrl } from "../utils/admin-fetch";
import { refetchFlags } from "./useFeatureFlag";

// Bound on the staff check so a dead zone cannot hold the field workspace on
// "Verifying staff access" forever (field paths only; see the verify effect).
export const AUTH_CHECK_TIMEOUT_MS = 15000;

const SESSION_KEYS = ["waves_admin_token", "adminToken", "waves_admin_user"];

// The admin shell's staff-session state machine: verifies the stored token
// against /admin/auth/me, and decides which pages the verified (or offline)
// session may open. `status` is checking | ready | error; `offline` is true
// while the shell stands on the offline pass alone (no server answer), which
// is the field workspace's readiness only (Codex #5573 r8). Every transition
// is a patch on that one state, and every way a session ends (401, forced
// password reset, a staff API call answered 401) goes through endSession.
export default function useStaffSession() {
  const navigate = useNavigate();
  const location = useLocation();
  const [session, setSession] = useState({ user: null, status: "checking", offline: false });
  // Bumped to rerun the check: another tab signed in (the old login's answer
  // must not apply), or the page moved between Today and the rest of the app.
  const [verifyRun, setVerifyRun] = useState(0);
  const locationRef = useRef(location);
  locationRef.current = location;
  const onField = isFieldPath(location.pathname);
  const wasOnField = useRef(onField);

  const patch = (next) => setSession((current) => ({ ...current, ...next }));
  const restart = (next) => { patch(next); setVerifyRun((n) => n + 1); };
  // Token, stored profile, saved route and pass go; `to` is where the person
  // lands (sign-in, or the reset flow with its `state`).
  const endSession = (to, state) => {
    SESSION_KEYS.forEach((key) => localStorage.removeItem(key));
    clearStaffDeviceData();
    patch({ user: null, status: "checking" });
    refetchFlags().catch(() => {});
    navigate(to, { replace: true, state });
  };

  useEffect(() => {
    const token = getAdminAuthToken();
    if (!token) {
      navigate(adminLoginUrl(location), { replace: true });
      return undefined;
    }
    // The field workspace (/admin/today) must open with no signal, so only
    // there is the check bounded and allowed to fall back to the offline pass
    // a previous successful check left for THIS token. Every other admin
    // page keeps the plain check and its error state.
    const field = onField;
    let cancelled = false;
    const abort = field && typeof AbortController === "function" ? new AbortController() : null;
    const timer = abort && setTimeout(() => abort.abort(), AUTH_CHECK_TIMEOUT_MS);
    // An answer for a token that is no longer the stored one (another tab
    // signed in) is dropped and the check reruns for the new login.
    const superseded = () => {
      if (cancelled) return true;
      if (getAdminAuthToken() === token) return false;
      setVerifyRun((n) => n + 1);
      return true;
    };
    // Only a failure to REACH the server (or to read a 2xx body) may open from
    // the offline pass: adminFetch throws those with no HTTP status. A server
    // answer of any kind carries a status (or is a profile we reject below).
    // Every path handles the 401 below, after the token check, so an old
    // login's late 401 never sends a newer login (another tab) to the sign-in
    // page (pre-push P1; Codex #5573 r14 for non-field pages).
    adminFetch("/admin/auth/me", { redirectOn401: false, ...(abort ? { signal: abort.signal } : {}) })
      .then((profile) => {
        if (superseded()) return;
        if (!profile) {
          patch({ status: "error" });
          return;
        }
        if (profile.mustChangePassword) {
          // The field workspace keeps the retired /tech shell's flow: the
          // verified session goes to the signed-in change-password page, which
          // adminAuthenticate permits for a rotation (Codex #5573 r11).
          // The token stays for that flow, but the offline pass and route
          // snapshot go: a reopen with no signal before the rotation must not
          // unlock Today from a pass that predates it (Codex #5573 r22).
          if (isFieldPath(locationRef.current.pathname)) {
            clearStaffDeviceData();
            navigate("/admin/change-password", { replace: true });
          } else endSession("/admin/forgot-password", { email: profile.email, resetRequired: true });
          return;
        }
        if (profile.twoStep?.enrollmentRequired) {
          // GATE_ADMIN_MFA_ENFORCE: the server answers only /me and the setup
          // routes until an authenticator is set up. The token stays for that
          // page; the offline pass goes so Today cannot open around it.
          clearStaffDeviceData();
          navigate("/admin/two-step", { replace: true });
          return;
        }
        patch({ user: profile, offline: false, status: "ready" });
        // A failed cache write must not leave a stale copy behind.
        try {
          localStorage.setItem("waves_admin_user", JSON.stringify(profile));
        } catch {
          try { localStorage.removeItem("waves_admin_user"); } catch { /* storage unavailable */ }
        }
        // Every verified check refreshes the pass, so a later offline reopen
        // of the field workspace has one.
        saveStaffOfflinePass(token, profile);
      })
      .catch((err) => {
        if (superseded()) return;
        if (err?.status === 401) {
          endSession(adminLoginUrl(location));
          return;
        }
        // Judged on the path NOW: navigating off Today while the check was
        // pending must not open another admin page from the pass.
        const stored = field && isFieldPath(locationRef.current.pathname) && err?.status === undefined
          ? loadStaffOfflinePass(token)
          : null;
        patch(stored ? { user: stored, offline: true, status: "ready" } : { status: "error" });
      })
      .finally(() => clearTimeout(timer));
    return () => {
      cancelled = true;
      clearTimeout(timer);
      // A superseded field check must not linger in a dead zone.
      abort?.abort();
    };
  }, [navigate, verifyRun]);

  // The whole shell (it stays mounted across admin pages, so a switch made
  // while on another page must not reach Today later; pre-push P1): another
  // tab signing in or out changes the stored token under this shell. Drop the
  // identity verified for the old token at once (the outlet unmounts while
  // "checking") and verify the new one.
  useEffect(() => {
    const onStorage = (event) => {
      if (event.key !== null && event.key !== "waves_admin_token") return;
      restart({ user: null, status: getAdminAuthToken() ? "checking" : "error" });
      refetchFlags().catch(() => {});
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // One rule for moving between Today and the rest of the app (Codex #5573
  // r9, r10, r12, r21): a real move across that boundary with a check that is
  // not ready re-runs it as the destination's check (bounded on Today,
  // unbounded elsewhere). A direct load already started the right one.
  useEffect(() => {
    const moved = onField !== wasOnField.current;
    wasOnField.current = onField;
    if (moved && session.status !== "ready") {
      restart({ status: "checking" });
    }
  }, [onField]);

  // An offline-pass session is ready for the field workspace only: leaving
  // Today re-runs the online check before any other admin page mounts (Codex
  // #5573 r8).
  useEffect(() => {
    if (session.offline && !onField) restart({ user: null, offline: false, status: "checking" });
  }, [session.offline, onField]);

  // Field workspace only: a 401 from ANY staff API call for the current token
  // ends the session here, so an offline reopen cannot unlock from a session
  // the server already refused. A layout effect, so it is installed before
  // Today's children run their first requests (passive effects) when moving
  // in from another admin page (Codex #5573 r16).
  useLayoutEffect(() => {
    if (!onField) return undefined;
    return installStaffSessionGuard({
      getToken: getAdminAuthToken,
      onRejected: () => endSession(adminLoginUrl(locationRef.current)),
      // GATE_ADMIN_MFA_ENFORCE switched on under an open Today: the token
      // stays for the setup page, the offline pass and saved route go.
      onEnrollmentRequired: () => {
        clearStaffDeviceData();
        navigate("/admin/two-step", { replace: true });
      },
    });
  }, [navigate, onField]);

  // On the field workspace a ready session needs a verified identity, an id
  // and a role, however it got ready: verified on Today or on another page
  // before navigating in (Codex #5573 r18, r19). Any staff role is allowed:
  // /admin/today is the landing for every non-admin role, CSR included.
  // Other admin pages keep their existing check.
  const fieldIdentityInvalid = onField && session.status === "ready" && !(session.user?.id && session.user?.role);
  const authStatus = fieldIdentityInvalid ? "error" : session.status;
  return {
    user: session.user,
    // The verified account id flags are read for (null until verified).
    userId: session.user?.id ?? null,
    authStatus,
    // Whether the page is the field workspace (/admin/today).
    onField,
    // Off Today the offline pass is not ready in this very render, before the
    // re-verify effect runs, so no other admin page mounts on it for a frame
    // (pre-push P1).
    sessionReady: authStatus === "ready" && (onField || !session.offline),
  };
}
