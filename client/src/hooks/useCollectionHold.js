import { useCallback, useEffect, useRef, useState } from "react";
import { getAdminAuthToken } from "../lib/adminAuth";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

// B10: a collections DISPUTE hold ("stops_charges") halts every off-session
// charge (monthly dues, completion, sweeps) and the customer was told billing
// follow-up is on hold. Staff-ordered charges (Charge now, charge-card) go
// past it via operatorOverride, so every surface that can make one reads the
// hold through THIS hook and shows it beside the charge control.
//
// GET /admin/customers/:id/collection-holds lists the active holds (admin
// only, so the read is skipped for anyone else) and POST .../release lifts
// one (audited server-side; body `{ holdId }` names exactly the hold shown,
// reply `{ released: <rows released> }`). A 409 means that hold changed since
// it was loaded, so the holds are re-read instead of releasing blind.
//
// `status` is explicit so an unknown hold is never mistaken for "no hold":
//   idle    — not an admin / no customer: nothing was read
//   loading — the read is in flight
//   ready   — the read succeeded (`holds` is authoritative)
//   error   — the read failed or timed out (the hold state is UNKNOWN)
async function holdFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${getAdminAuthToken()}`,
      "Content-Type": "application/json",
    },
    ...options,
  });
  if (!res.ok) {
    let message = "";
    try {
      const body = await res.clone().json();
      message = body?.error || body?.reason || body?.message || body?.code || "";
    } catch {
      /* not JSON */
    }
    const err = new Error(message || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

const holdsFrom = (body) => (Array.isArray(body?.holds) ? body.holds : []);

// The ONE read of a customer's active holds; every read below goes through it.
const fetchHolds = (customerId) =>
  holdFetch(`/admin/customers/${customerId}/collection-holds`).then(holdsFrom);

// One-shot read for a flow that confirms imperatively (no mounted hook state).
// Never throws: a failed read is `{ status: "error" }`, not "no hold".
export async function readCollectionHold(customerId) {
  if (!customerId) return { status: "error", holds: [], dispute: null };
  try {
    const holds = await fetchHolds(customerId);
    return { status: "ready", holds, dispute: holds.find((h) => h.stops_charges) || null };
  } catch {
    return { status: "error", holds: [], dispute: null };
  }
}

export function useCollectionHold(customerId, isAdmin) {
  const enabled = Boolean(isAdmin && customerId);
  const [read, setRead] = useState({ customerId: null, status: "idle", holds: [] });
  const [releasing, setReleasing] = useState(false);
  const [releaseErr, setReleaseErr] = useState("");
  const [releaseNote, setReleaseNote] = useState("");
  const seqRef = useRef(0);
  const customerRef = useRef(customerId);
  customerRef.current = customerId;

  const load = useCallback(() => {
    seqRef.current += 1;
    const seq = seqRef.current;
    setRead({ customerId, status: "loading", holds: [] });
    fetchHolds(customerId)
      .then((holds) => {
        if (seqRef.current !== seq) return;
        setRead({ customerId, status: "ready", holds });
      })
      .catch(() => {
        if (seqRef.current !== seq) return;
        // A failed read is UNKNOWN, not "no hold".
        setRead({ customerId, status: "error", holds: [] });
      });
  }, [customerId]);

  useEffect(() => {
    seqRef.current += 1;
    setReleasing(false);
    setReleaseErr("");
    setReleaseNote("");
    if (!enabled) {
      setRead({ customerId: null, status: "idle", holds: [] });
      return undefined;
    }
    load();
    return () => {
      seqRef.current += 1;
    };
  }, [enabled, load]);

  // A read that belongs to a previous customer never shows as this one's.
  const current = read.customerId === customerId ? read : null;
  const status = !enabled ? "idle" : current ? current.status : "loading";
  const holds = current ? current.holds : [];
  const dispute = holds.find((h) => h.stops_charges) || null;

  const release = useCallback(async () => {
    if (!dispute) return;
    const forCustomerId = customerId;
    const seq = seqRef.current;
    const stillViewing = () =>
      seqRef.current === seq &&
      String(customerRef.current) === String(forCustomerId);
    setReleasing(true);
    setReleaseErr("");
    setReleaseNote("");
    try {
      const result = await holdFetch(
        `/admin/customers/${forCustomerId}/collection-holds/release`,
        { method: "POST", body: JSON.stringify({ holdId: dispute.id }) },
      );
      if (!stillViewing()) return;
      setRead({ customerId: forCustomerId, status: "ready", holds: [] });
      setReleaseNote(
        Number(result?.released) > 0
          ? "Billing hold released. Automatic charges resume on their next attempt, and any held-back invoice is sent."
          : "This hold was already released.",
      );
    } catch (err) {
      if (!stillViewing()) return;
      if (err.status === 409) {
        // The hold changed under us (released elsewhere, or replaced by a
        // newer one): show what is current instead of releasing blind.
        setReleaseErr("This hold changed — reload. Nothing was released; the current billing hold status has been reloaded.");
        try {
          const holds = await fetchHolds(forCustomerId);
          if (stillViewing()) setRead({ customerId: forCustomerId, status: "ready", holds });
        } catch {
          if (stillViewing()) setRead({ customerId: forCustomerId, status: "error", holds: [] });
        }
      } else {
        setReleaseErr(
          err.status === 403
            ? "Only an admin can release a billing hold."
            : err.message || "Could not release the billing hold",
        );
      }
    } finally {
      if (stillViewing()) setReleasing(false);
    }
  }, [dispute, customerId]);

  return { status, holds, dispute, releasing, releaseErr, releaseNote, release, reload: load };
}
