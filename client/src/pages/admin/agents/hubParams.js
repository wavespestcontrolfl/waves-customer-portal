import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

// URL = state for the Agents hub. The hub owns ?tab=; the tabs that read an
// area / window / status / lane / run read and write them here so a deep link
// reproduces the exact view and a defaulted value never litters the URL.
// The hub's tab beacon keys on ?tab= only, so these params never re-fire it.

export const WINDOWS = [
  { key: "today", label: "Today" },
  { key: "7d", label: "7D" },
  { key: "30d", label: "30D" },
];

export const PARAM_DEFAULTS = { area: null, window: "7d", status: "all", lane: null, run: null, by: null };

export function useHubParams() {
  const [searchParams, setSearchParams] = useSearchParams();
  const read = (key) => searchParams.get(key) || PARAM_DEFAULTS[key];
  const set = useCallback(
    (patch) => {
      setSearchParams(
        (current) => {
          const params = new URLSearchParams(current);
          for (const [key, value] of Object.entries(patch)) {
            if (value == null || value === "" || value === PARAM_DEFAULTS[key]) params.delete(key);
            else params.set(key, String(value));
          }
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  return {
    tab: searchParams.get("tab"),
    area: read("area"),
    window: WINDOWS.some((w) => w.key === read("window")) ? read("window") : PARAM_DEFAULTS.window,
    status: read("status"),
    lane: read("lane"),
    run: read("run"),
    by: read("by"),
    set,
  };
}
