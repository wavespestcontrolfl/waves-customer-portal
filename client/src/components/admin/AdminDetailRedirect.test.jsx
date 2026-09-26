// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import AdminDetailRedirect from "./AdminDetailRedirect";

afterEach(cleanup);

const app = readFileSync("src/App.jsx", "utf8");

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}{location.hash}</output>;
}

function landAt(entry, route, props) {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path={route} element={<AdminDetailRedirect {...props} />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
  return new URL(screen.getByTestId("location").textContent, "https://fixture.invalid");
}

describe("AdminDetailRedirect", () => {
  it("sends a stored /admin/customers/:id bell link to the Customer 360 query", () => {
    const url = landAt("/admin/customers/cust-1", "/admin/customers/:id", { to: "/admin/customers", queryKey: "customerId" });
    expect(url.pathname).toBe("/admin/customers");
    expect(url.searchParams.get("customerId")).toBe("cust-1");
  });

  it("opens the specific invoice and keeps other query and hash", () => {
    const url = landAt("/admin/invoices/inv-9?from=bell#top", "/admin/invoices/:id", { to: "/admin/invoices", queryKey: "invoice" });
    expect(url.pathname).toBe("/admin/invoices");
    expect(url.searchParams.get("invoice")).toBe("inv-9");
    expect(url.searchParams.get("from")).toBe("bell");
    expect(url.hash).toBe("#top");
  });

  it("opens the estimate on the pipeline Estimates tab", () => {
    const url = landAt("/admin/estimates/est-4", "/admin/estimates/:id", { to: "/admin/pipeline", queryKey: "estimateId", tab: "estimates" });
    expect(url.pathname).toBe("/admin/pipeline");
    expect(url.searchParams.get("estimateId")).toBe("est-4");
    expect(url.searchParams.get("tab")).toBe("estimates");
  });
});

describe("App mounts the detail redirects", () => {
  it.each([
    ['customers/:id', 'to="/admin/customers" queryKey="customerId"'],
    ['estimates/:id', 'to="/admin/pipeline" queryKey="estimateId" tab="estimates"'],
    ['invoices/:id', 'to="/admin/invoices" queryKey="invoice"'],
  ])("%s", (path, props) => {
    expect(app).toContain(`<Route path="${path}" element={<AdminDetailRedirect ${props} />} />`);
  });

  it("routes the portal /billing link to the Billing tab", () => {
    expect(app).toContain('<Route path="/billing" element={<Navigate to="/?tab=billing" replace />} />');
  });
});
