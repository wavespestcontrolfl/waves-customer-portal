import React from "react";
import { Navigate, useLocation } from "react-router-dom";

export default function AdminTabRedirect({
  to,
  tab,
  preserveTabs = [],
  queryKey = "tab",
}) {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const requestedTab = params.get(queryKey);

  if (!preserveTabs.includes(requestedTab)) {
    params.set(queryKey, tab);
  }

  const search = params.toString();
  const destination = `${to}${search ? `?${search}` : ""}${location.hash}`;

  return <Navigate to={destination} replace />;
}
