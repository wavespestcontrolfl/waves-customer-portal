// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import WinLossSlicesCard from "./WinLossSlicesCard";

vi.mock("../../utils/admin-fetch", () => ({ adminFetch: vi.fn() }));
import { adminFetch } from "../../utils/admin-fetch";

afterEach(cleanup);

const payload = (stillDeciding) => ({
  resolved: 0,
  byFlagField: [],
  recurringBandsByFlag: [],
  byDisposition: [],
  byServiceLine: [],
  byLeadSource: [],
  byWaveguardTier: [],
  sentCohorts: { cohorts: [] },
  stillDeciding,
});

describe("WinLossSlicesCard still-deciding block", () => {
  it("shows accepted rows alone in 'Accepted afterwards' and the booked wins as '+N booked another way'", async () => {
    adminFetch.mockResolvedValue(payload({ signaled: 4, wonAfter: 2, wonBookedAfter: 1, lostAfter: 1, expiredViewedAfter: 0 }));
    render(<WinLossSlicesCard />);
    const row = (await screen.findByText("Accepted afterwards")).closest("tr");
    expect(row).toHaveTextContent("2");
    expect(row).toHaveTextContent("+1 booked another way");
  });

  it("shows no booked note when there are none (older payloads too)", async () => {
    adminFetch.mockResolvedValue(payload({ signaled: 2, wonAfter: 2, lostAfter: 0, expiredViewedAfter: 0 }));
    render(<WinLossSlicesCard />);
    const row = (await screen.findByText("Accepted afterwards")).closest("tr");
    expect(row).not.toHaveTextContent("booked another way");
  });
});
