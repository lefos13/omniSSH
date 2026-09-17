import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CustomSelect } from "../CustomSelect";

const OPTIONS = [
  { value: "alpha", label: "Alpha Server" },
  { value: "beta", label: "Beta Server" },
  { value: "gamma", label: "Gamma Server" },
];

describe("CustomSelect — searchable", () => {
  beforeEach(() => {
    // jsdom has no scrollIntoView; the highlight effect calls it.
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it("filters options by the search box and reports the picked value", () => {
    const onChange = vi.fn();
    render(
      <CustomSelect
        value=""
        options={OPTIONS}
        onChange={onChange}
        searchable
        searchPlaceholder="Search servers..."
        data-testid="picker"
      />,
    );

    fireEvent.click(screen.getByTestId("picker"));

    // All options are present before filtering.
    expect(screen.getByRole("option", { name: "Alpha Server" })).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("picker-search"), { target: { value: "bet" } });

    expect(screen.queryByRole("option", { name: "Alpha Server" })).toBeNull();
    expect(screen.getByRole("option", { name: "Beta Server" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: "Beta Server" }));
    expect(onChange).toHaveBeenCalledWith("beta");
  });

  it("shows a no-matches message when the filter excludes everything", () => {
    render(
      <CustomSelect
        value=""
        options={OPTIONS}
        onChange={vi.fn()}
        searchable
        data-testid="picker"
      />,
    );
    fireEvent.click(screen.getByTestId("picker"));
    fireEvent.change(screen.getByTestId("picker-search"), { target: { value: "zzz" } });

    expect(screen.queryByRole("option")).toBeNull();
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });

  it("picks the only remaining match on Enter", () => {
    const onChange = vi.fn();
    render(
      <CustomSelect
        value=""
        options={OPTIONS}
        onChange={onChange}
        searchable
        data-testid="picker"
      />,
    );
    fireEvent.click(screen.getByTestId("picker"));
    const input = screen.getByTestId("picker-search");
    fireEvent.change(input, { target: { value: "gamma" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("gamma");
  });

  it("does not render a search box when not searchable", () => {
    render(
      <CustomSelect value="" options={OPTIONS} onChange={vi.fn()} data-testid="picker" />,
    );
    fireEvent.click(screen.getByTestId("picker"));
    expect(screen.queryByTestId("picker-search")).toBeNull();
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });
});
