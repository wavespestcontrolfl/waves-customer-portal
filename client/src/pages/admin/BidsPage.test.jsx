// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useSearchParams } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { flags } = vi.hoisted(() => ({ flags: { bid_desk: true, bid_kit: true, ready: true } }));
vi.mock("../../hooks/useFeatureFlag", () => ({
  useFeatureFlagReady: (key) => ({ enabled: flags[key] === true, ready: flags.ready, known: true }),
}));
vi.mock("./BidDeskPage", () => ({
  default: function DeskStub({ embedded }) {
    const [params] = useSearchParams();
    return <div data-testid="desk" data-embedded={String(Boolean(embedded))}>desk bid={params.get("bid") || ""}</div>;
  },
}));
vi.mock("./BidKitPage", () => ({
  default: function KitStub({ embedded }) {
    const [params] = useSearchParams();
    return <div data-testid="kit" data-embedded={String(Boolean(embedded))}>kit item={params.get("item") || ""}</div>;
  },
}));

import BidsPage from "./BidsPage";
import BidsLegacyRedirect from "../../components/admin/BidsLegacyRedirect";

function Where() {
  const { pathname, search, hash } = useLocation();
  return <div data-testid="where">{pathname}{search}{hash}</div>;
}

function renderAt(url) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/admin/bids" element={<BidsPage />} />
        <Route path="/admin/bid-desk" element={<BidsLegacyRedirect />} />
        <Route path="/admin/bid-kit" element={<BidsLegacyRedirect tab="kit" />} />
      </Routes>
      <Where />
    </MemoryRouter>,
  );
}

beforeEach(() => { flags.bid_desk = true; flags.bid_kit = true; flags.ready = true; });
afterEach(cleanup);

it("opens on Open bids when there is no tab param", () => {
  renderAt("/admin/bids");
  expect(screen.getByRole("heading", { level: 1, name: "Bids" })).toBeInTheDocument();
  expect(screen.getByTestId("desk")).toHaveAttribute("data-embedded", "true");
  expect(screen.queryByTestId("kit")).toBeNull();
  expect(screen.getByRole("button", { name: "Open bids" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("button", { name: "Bid kit" })).not.toHaveAttribute("aria-current");
});

it("opens the Bid kit tab for ?tab=kit", () => {
  renderAt("/admin/bids?tab=kit");
  expect(screen.getByTestId("kit")).toHaveAttribute("data-embedded", "true");
  expect(screen.queryByTestId("desk")).toBeNull();
  expect(screen.getByRole("button", { name: "Bid kit" })).toHaveAttribute("aria-current", "page");
});

it("switching tabs updates the URL and keeps the other params", () => {
  renderAt("/admin/bids?bid=b1&x=1");
  fireEvent.click(screen.getByRole("button", { name: "Bid kit" }));
  const where = screen.getByTestId("where").textContent;
  expect(where.startsWith("/admin/bids?")).toBe(true);
  const params = new URLSearchParams(where.split("?")[1]);
  expect(params.get("tab")).toBe("kit");
  expect(params.get("bid")).toBe("b1");
  expect(params.get("x")).toBe("1");
  expect(screen.getByTestId("kit")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Open bids" }));
  const back = new URLSearchParams(screen.getByTestId("where").textContent.split("?")[1]);
  expect(back.has("tab")).toBe(false);
  expect(back.get("bid")).toBe("b1");
  expect(screen.getByTestId("desk")).toHaveTextContent("bid=b1");
});

it("hides the Bid kit tab while its flag is off, even for ?tab=kit", () => {
  flags.bid_kit = false;
  renderAt("/admin/bids?tab=kit");
  expect(screen.queryByRole("button", { name: "Bid kit" })).toBeNull();
  expect(screen.queryByTestId("kit")).toBeNull();
  expect(screen.getByTestId("desk")).toBeInTheDocument();
});

it("shows only the kit when only bid_kit is on", () => {
  flags.bid_desk = false;
  renderAt("/admin/bids");
  expect(screen.queryByRole("button", { name: "Open bids" })).toBeNull();
  expect(screen.getByTestId("kit")).toBeInTheDocument();
  expect(screen.queryByTestId("desk")).toBeNull();
});

it("fails closed when neither flag is on", () => {
  flags.bid_desk = false;
  flags.bid_kit = false;
  renderAt("/admin/bids");
  expect(screen.getByText("Bids are not turned on yet.")).toBeInTheDocument();
  expect(screen.queryByTestId("desk")).toBeNull();
  expect(screen.queryByTestId("kit")).toBeNull();
});

it("renders nothing until the flags are read", () => {
  flags.ready = false;
  renderAt("/admin/bids");
  expect(screen.queryByText("Bids are not turned on yet.")).toBeNull();
  expect(screen.queryByTestId("desk")).toBeNull();
});

it("redirects /admin/bid-desk to Open bids and keeps ?bid= and the hash", () => {
  renderAt("/admin/bid-desk?bid=abc-123#checklist");
  expect(screen.getByTestId("where")).toHaveTextContent("/admin/bids?bid=abc-123#checklist");
  expect(screen.getByTestId("desk")).toHaveTextContent("bid=abc-123");
});

it("redirects plain /admin/bid-desk to /admin/bids", () => {
  renderAt("/admin/bid-desk");
  expect(screen.getByTestId("where").textContent).toBe("/admin/bids");
  expect(screen.getByTestId("desk")).toBeInTheDocument();
});

it("redirects /admin/bid-kit to the kit tab and keeps ?item= and the hash", () => {
  renderAt("/admin/bid-kit?item=i9#row");
  const where = screen.getByTestId("where").textContent;
  expect(where.startsWith("/admin/bids?")).toBe(true);
  expect(where.endsWith("#row")).toBe(true);
  const params = new URLSearchParams(where.split("?")[1].split("#")[0]);
  expect(params.get("tab")).toBe("kit");
  expect(params.get("item")).toBe("i9");
  expect(screen.getByTestId("kit")).toHaveTextContent("item=i9");
});

it("redirects plain /admin/bid-kit to /admin/bids?tab=kit", () => {
  renderAt("/admin/bid-kit");
  expect(screen.getByTestId("where").textContent).toBe("/admin/bids?tab=kit");
});
