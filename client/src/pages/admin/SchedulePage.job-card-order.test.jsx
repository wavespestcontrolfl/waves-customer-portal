// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { JobCardOrderButton } from "./SchedulePage";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const D = { text: "#000", muted: "#666", heading: "#000" };
const order = { quantity: 2, unit: "gal", packSize: "1 gal", lastPrice: 41.5 };

function renderButton() {
  return render(<JobCardOrderButton productId="p1" name="Synthetic Product" order={order} D={D} compact />);
}

describe("job card order button", () => {
  // Owner 2026-10-03: "Order more" (a restock REQUEST) stays on the technician's
  // job card; the route is on the technician allow-list.
  it.each(["admin", "technician"])("is offered to a %s", (role) => {
    localStorage.setItem("waves_admin_user", JSON.stringify({ role }));
    renderButton();
    expect(screen.getByRole("button")).toBeInTheDocument();
  });
});
