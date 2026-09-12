// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SEOPage from "./SEOPage";

vi.mock("./SEODashboardPage", () => ({
  default: () => <div>SEO dashboard fixture</div>,
}));

function jsonResponse(body = {}) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => body,
    clone() {
      return this;
    },
  });
}

describe("SEOPage workspace navigation", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(
      "waves_admin_user",
      JSON.stringify({ id: "seo-test", role: "admin", name: "SEO operator" }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse({})),
    );
  });

  it("renders the complete SEO shell with comfortable shared navigation", async () => {
    const { container } = render(<SEOPage />);

    expect(
      screen.getByRole("heading", { name: "SEO", level: 1 }),
    ).toBeInTheDocument();
    expect(
      container.querySelector('[data-ui-density="comfortable"]'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "SEO section" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "Command SEO view" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Command" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "Dashboard" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      await screen.findByText("SEO dashboard fixture"),
    ).toBeInTheDocument();
  });

  it("preserves each workspace's selected view while switching workspaces", async () => {
    render(<SEOPage />);
    await screen.findByText("SEO dashboard fixture");

    let viewNav = screen.getByRole("navigation", { name: "Command SEO view" });
    fireEvent.click(
      within(viewNav).getByRole("button", { name: "SEO Advisor" }),
    );
    expect(
      within(viewNav).getByRole("button", { name: "SEO Advisor" }),
    ).toHaveAttribute("aria-current", "page");

    const workspaceNav = screen.getByRole("navigation", {
      name: "SEO section",
    });
    fireEvent.click(
      within(workspaceNav).getByRole("button", {
        name: "Rankings",
        exact: true,
      }),
    );
    expect(
      within(workspaceNav).getByRole("button", {
        name: "Rankings",
        exact: true,
      }),
    ).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Monitor" })).toBeInTheDocument();

    fireEvent.click(
      within(workspaceNav).getByRole("button", { name: "Command" }),
    );
    viewNav = screen.getByRole("navigation", { name: "Command SEO view" });
    expect(
      within(viewNav).getByRole("button", { name: "SEO Advisor" }),
    ).toHaveAttribute("aria-current", "page");

    await waitFor(() => expect(fetch).toHaveBeenCalled());
  });
});
