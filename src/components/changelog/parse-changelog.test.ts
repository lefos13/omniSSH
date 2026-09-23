import { describe, expect, it } from "vitest";
import { parseChangelog } from "./parse-changelog";

const FIXTURE = `# Changelog

Intro text with [a link](https://example.com) that must be ignored.

---

## [Unreleased]

## [1.6.4] - 2026-09-22

### 🚀 Highlights & New Features

#### 1. Reusable Effect Framework
* **Shared Effect Pipeline**: Every animated background now runs through a single framework.
* **Five New Themes**: Deep Sea, Starfield, Fog, Sakura, and Erdtree.

### 🐛 Fixes

* **Steady Sync History Button**: The toggle has a fixed width.

## [1.0.0] - 2026-09-01

### 🧪 Testing & Quality Assurance
* **8 New End-to-End Test Specs** (\`tests/e2e/specs/\`):
  * \`66-two-independent-explorers.spec.ts\`: Validates concurrent explorers.
  * \`67-ssh-protocol-channels.spec.ts\`: Tests multi-channel SSH.
* **Extensive Unit Coverage**:
  * New Vitest suites for \`osc7\`.

---

[1.6.4]: https://example.com/releases/tag/v1.6.4
`;

describe("parseChangelog", () => {
  it("parses entries with version, date, sections, groups, and items", () => {
    const entries = parseChangelog(FIXTURE);

    expect(entries.map((e) => e.version)).toEqual(["1.6.4", "1.0.0"]);
    expect(entries[0].date).toBe("2026-09-22");

    const first = entries[0];
    expect(first.sections).toHaveLength(2);
    expect(first.sections[0].title).toBe("🚀 Highlights & New Features");
    expect(first.sections[0].groups[0].title).toBe("1. Reusable Effect Framework");
    expect(first.sections[0].groups[0].items[0]).toEqual({
      text: "**Shared Effect Pipeline**: Every animated background now runs through a single framework.",
      depth: 0,
    });
    expect(first.sections[1].groups[0].title).toBeNull();
    expect(first.sections[1].groups[0].items).toHaveLength(1);
  });

  it("skips empty entries such as an unused Unreleased section", () => {
    const entries = parseChangelog(FIXTURE);
    expect(entries.some((e) => e.version === "Unreleased")).toBe(false);
  });

  it("marks nested bullets with depth 1", () => {
    const entries = parseChangelog(FIXTURE);
    const group = entries[1].sections[0].groups[0];

    expect(group.items.map((i) => i.depth)).toEqual([0, 1, 1, 0, 1]);
    expect(group.items[1].text).toContain("66-two-independent-explorers");
  });

  it("ignores intro text, horizontal rules, and link definitions", () => {
    const entries = parseChangelog(FIXTURE);
    const allText = JSON.stringify(entries);

    expect(allText).not.toContain("Intro text");
    expect(allText).not.toContain("https://example.com/releases");
    expect(allText).not.toContain("---");
  });

  it("returns an empty list for markdown without entries", () => {
    expect(parseChangelog("# Changelog\n\nnothing here")).toEqual([]);
  });
});
