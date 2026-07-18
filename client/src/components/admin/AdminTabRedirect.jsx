import React from "react";
import { Navigate, useLocation } from "react-router-dom";

export default function AdminTabRedirect({
  to,
  tab,
  preserveTabs = [],
  queryKey = "tab",
  remapQuery,
}) {
  const location = useLocation();
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

  if (!preserveTabs.includes(requestedTab)) {
    params.set(queryKey, tab);
  }

  const search = params.toString();
  const destination = `${to}${search ? `?${search}` : ""}${location.hash}`;

  return <Navigate to={destination} replace />;
}
