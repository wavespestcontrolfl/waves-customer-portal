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
import {
  MemoryRouter,
  useLocation,
  useNavigate,
} from "react-router-dom";
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

function RouterState() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location">
        {location.search}{location.hash}
      </output>
      <button type="button" onClick={() => navigate(-1)}>
        Browser Back
      </button>
    </>
  );
}

function renderPage(initialEntries = ["/admin/seo"]) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <SEOPage />
      <RouterState />
    </MemoryRouter>,
  );
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
    const { container } = renderPage();

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
    renderPage();
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

  it("deep-links both navigation levels and restores them with browser history", async () => {
    renderPage([
      "/admin/seo?workspace=performance&view=rankings-monitor&source=audit#evidence",
    ]);

    const workspaceNav = screen.getByRole("navigation", {
      name: "SEO section",
    });
    expect(
      within(workspaceNav).getByRole("button", { name: "Rankings" }),
    ).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Monitor" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    fireEvent.click(
      within(workspaceNav).getByRole("button", { name: "Command" }),
    );
    expect(screen.getByTestId("location")).toHaveTextContent(
      "?workspace=command&view=dashboard&source=audit#evidence",
    );

    fireEvent.click(screen.getByRole("button", { name: "SEO Advisor" }));
    expect(screen.getByTestId("location")).toHaveTextContent(
      "?workspace=command&view=advisor&source=audit#evidence",
    );
    fireEvent.click(
      within(workspaceNav).getByRole("button", { name: "Rankings" }),
    );
    expect(screen.getByTestId("location")).toHaveTextContent(
      "?workspace=performance&view=rankings-monitor&source=audit#evidence",
    );

    fireEvent.click(screen.getByRole("button", { name: "Browser Back" }));
    expect(await screen.findByRole("button", { name: "SEO Advisor" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it.each(["unknown", "constructor", "__proto__", "toString"])("falls back to the command dashboard for invalid URL state %s", async (workspace) => {
    renderPage([`/admin/seo?workspace=${workspace}&view=rankings`]);
    expect(screen.getByRole("button", { name: "Command" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "Dashboard" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(await screen.findByText("SEO dashboard fixture")).toBeInTheDocument();
  });
});
