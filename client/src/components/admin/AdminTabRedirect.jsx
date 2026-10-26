import React from "react";
import { Navigate, useLocation } from "react-router-dom";

export default function AdminTabRedirect({
  to,
  tab,
  preserveTabs = [],
  queryKey = "tab",
  remapQuery,
  tabInHash = false,
}) {
  const location = useLocation();
  if (tabInHash) {
    const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
    if (tab) hash.set(queryKey, tab);
    else hash.delete(queryKey);
    const nextHash = hash.toString();
    return <Navigate to={{ pathname: to, search: location.search, hash: nextHash ? `#${nextHash}` : "" }} replace />;
  }
  const params = new URLSearchParams(location.search);
  if (remapQuery?.from && remapQuery?.to) {
    const remappedValue = params.get(remapQuery.from);
    params.delete(remapQuery.from);
    if (
      remappedValue &&
      (!remapQuery.preserveValues?.length ||
        remapQuery.preserveValues.includes(remappedValue))
    ) {
      params.set(remapQuery.to, remappedValue);
    }
  }
  const requestedTab = params.get(queryKey);

  // No `tab`: the destination's default view, which carries no tab param.
  if (!preserveTabs.includes(requestedTab)) {
    if (tab) params.set(queryKey, tab);
    else params.delete(queryKey);
  }

  const search = params.toString();
  const destination = `${to}${search ? `?${search}` : ""}${location.hash}`;

  return <Navigate to={destination} replace />;
}
