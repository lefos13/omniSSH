import { describe, expect, it } from "vitest";
import { hostInitial } from "./format";

describe("hostInitial", () => {
  it("uses one grapheme for surrogate-pair and CJK labels", () => {
    expect(hostInitial("🚀 production")).toBe("🚀");
    expect(hostInitial("東京サーバー")).toBe("東");
  });

  it("does not split a combining sequence", () => {
    expect(hostInitial("e\u0301dge-node")).toBe("E\u0301");
  });

  it("collapses surrounding whitespace and falls back for empty labels", () => {
    expect(hostInitial("  build-box  ")).toBe("B");
    expect(hostInitial("   ")).toBe("?");
  });
});
