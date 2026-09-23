import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChangelogPage } from "./ChangelogPage";
import { useUpdaterStore } from "../../stores/updater-store";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

describe("ChangelogPage", () => {
  beforeEach(() => {
    invoke.mockReset();
    useUpdaterStore.setState({ appVersion: null });
  });

  it("renders the parsed changelog entries", () => {
    render(<ChangelogPage />);

    expect(screen.getByTestId("changelog-page")).toBeInTheDocument();
    // Newest entry in CHANGELOG.md — parser must have split it out.
    expect(screen.getByTestId("changelog-entry-1.6.4")).toBeInTheDocument();
    expect(screen.getAllByTestId(/^changelog-entry-/).length).toBeGreaterThan(5);
  });

  it("marks the running version as current", () => {
    useUpdaterStore.setState({ appVersion: "1.6.4" });

    render(<ChangelogPage />);

    const entry = screen.getByTestId("changelog-entry-1.6.4");
    expect(entry).toHaveTextContent("Current");
  });
});
