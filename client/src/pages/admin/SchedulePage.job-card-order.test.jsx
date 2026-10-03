// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobCardOrderButton } from "./SchedulePage";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
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

  // The server accepts a technician's request only from one of their own
  // visits (codex #5733 r2): the button names the job card's visit.
  it("sends the job card's visit with the request", async () => {
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "technician" }));
    localStorage.setItem("waves_admin_token", "fixture-only");
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ success: true, existing: false }) }));
    vi.stubGlobal("fetch", fetchMock);
    render(<JobCardOrderButton productId="p1" name="Synthetic Product" order={order} serviceId="visit-123" D={D} compact />);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/admin/inventory/waveguard-forecast/p1/restock-request");
    expect(JSON.parse(options.body)).toMatchObject({ scheduledServiceId: "visit-123", requestedQuantity: 2 });
  });
});
