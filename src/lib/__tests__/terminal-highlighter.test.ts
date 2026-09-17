/*
 * Tests for terminal keyword highlighting engine.
 * Verifies pattern matching, regex support, word boundaries, case-sensitivity,
 * host scoping, color luminance calculation, Unicode cell offsets, and xterm
 * decoration registration and disposal.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  escapeRegex,
  isLightColor,
  stringLengthToBufferSize,
  findHighlightRanges,
  getActiveHighlightRules,
  TerminalKeywordHighlighter,
} from "../terminal-highlighter";
import type { TerminalHighlightRule } from "../../types";
import { useSettingsStore } from "../../stores/settings-store";
import { useSessionStore } from "../../stores/session-store";
import type { IBufferLine, IDecoration, IMarker, Terminal as XTerm } from "@xterm/xterm";

describe("terminal-highlighter — helper utilities", () => {
  it("escapes regex special characters", () => {
    expect(escapeRegex("foo.bar*baz?")).toBe("foo\\.bar\\*baz\\?");
    expect(escapeRegex("[test] (123) {abc}")).toBe("\\[test\\] \\(123\\) \\{abc\\}");
  });

  it("determines whether a hex color is light or dark for text contrast", () => {
    // Light colors (should return true -> black text)
    expect(isLightColor("#ffffff")).toBe(true);
    expect(isLightColor("#fef08a")).toBe(true);
    expect(isLightColor("#fefefe")).toBe(true);
    expect(isLightColor("#fbbf24")).toBe(true);

    // Dark colors (should return false -> white text)
    expect(isLightColor("#000000")).toBe(false);
    expect(isLightColor("#ef4444")).toBe(false);
    expect(isLightColor("#1e1e1e")).toBe(false);
    expect(isLightColor("#1e3a8a")).toBe(false);

    // 3-digit hex shorthand
    expect(isLightColor("#fff")).toBe(true);
    expect(isLightColor("#000")).toBe(false);
  });

  it("translates string length to buffer size with wide unicode and emojis", () => {
    // Plain ASCII text line mock
    const plainLine = {
      getCell: () => ({
        getChars: () => "a",
        getWidth: () => 1,
      }),
    } as unknown as IBufferLine;

    expect(stringLengthToBufferSize(plainLine, 0)).toBe(0);
    expect(stringLengthToBufferSize(plainLine, 5)).toBe(5);

    // Mock with wide CJK character at col 0 (width 2, next cell width 0)
    const wideLine = {
      getCell: (idx: number) => {
        if (idx === 0) return { getChars: () => "中", getWidth: () => 2 };
        if (idx === 1) return { getChars: () => "", getWidth: () => 0 };
        return { getChars: () => "x", getWidth: () => 1 };
      },
    } as unknown as IBufferLine;

    expect(stringLengthToBufferSize(wideLine, 1)).toBe(2);
  });
});

describe("terminal-highlighter — getActiveHighlightRules", () => {
  const rules: TerminalHighlightRule[] = [
    {
      id: "r1",
      pattern: "ERROR",
      color: "#ef4444",
      style: "text",
      scope: "global",
      enabled: true,
    },
    {
      id: "r2",
      pattern: "DEBUG",
      color: "#3b82f6",
      style: "text",
      scope: "global",
      enabled: false, // disabled
    },
    {
      id: "r3",
      pattern: "PROD_HOST",
      color: "#22c55e",
      style: "background",
      scope: "hosts",
      hostIds: ["host-prod-1", "host-prod-2"],
      enabled: true,
    },
  ];

  it("includes enabled global rules and excludes disabled rules", () => {
    const active = getActiveHighlightRules(rules, null);
    expect(active.map((r) => r.id)).toEqual(["r1"]);
  });

  it("includes host-scoped rules only for matching savedHostId", () => {
    const activeForProd = getActiveHighlightRules(rules, "host-prod-1");
    expect(activeForProd.map((r) => r.id)).toEqual(["r1", "r3"]);

    const activeForOther = getActiveHighlightRules(rules, "host-dev-1");
    expect(activeForOther.map((r) => r.id)).toEqual(["r1"]);
  });
});

describe("terminal-highlighter — findHighlightRanges", () => {
  it("matches plain text case-insensitively by default", () => {
    const rules: TerminalHighlightRule[] = [
      {
        id: "r1",
        pattern: "error",
        color: "#ef4444",
        style: "text",
        scope: "global",
        matchCase: false,
        matchWholeWord: false,
        isRegex: false,
      },
    ];

    const text = "Error: something failed, another ERROR occurred";
    const ranges = findHighlightRanges(text, undefined, rules);

    expect(ranges).toHaveLength(2);
    expect(ranges[0]).toEqual({
      col: 0,
      width: 5,
      foregroundColor: "#ef4444",
      backgroundColor: undefined,
    });
    expect(ranges[1]).toEqual({
      col: 33,
      width: 5,
      foregroundColor: "#ef4444",
      backgroundColor: undefined,
    });
  });

  it("respects case sensitivity when matchCase is true", () => {
    const rules: TerminalHighlightRule[] = [
      {
        id: "r1",
        pattern: "ERROR",
        color: "#ef4444",
        style: "text",
        scope: "global",
        matchCase: true,
        matchWholeWord: false,
        isRegex: false,
      },
    ];

    const text = "Error: something failed, another ERROR occurred";
    const ranges = findHighlightRanges(text, undefined, rules);

    expect(ranges).toHaveLength(1);
    expect(ranges[0].col).toBe(33);
  });

  it("enforces whole word matching when matchWholeWord is true", () => {
    const rules: TerminalHighlightRule[] = [
      {
        id: "r1",
        pattern: "err",
        color: "#ef4444",
        style: "text",
        scope: "global",
        matchCase: false,
        matchWholeWord: true,
        isRegex: false,
      },
    ];

    const text = "error with err code";
    const ranges = findHighlightRanges(text, undefined, rules);

    expect(ranges).toHaveLength(1);
    expect(ranges[0].col).toBe(11);
    expect(ranges[0].width).toBe(3);
  });

  it("supports regular expressions", () => {
    const rules: TerminalHighlightRule[] = [
      {
        id: "r1",
        pattern: "\\d+\\.\\d+\\.\\d+\\.\\d+",
        color: "#06b6d4",
        style: "background",
        scope: "global",
        isRegex: true,
      },
    ];

    const text = "Connected to 192.168.1.10 on port 22";
    const ranges = findHighlightRanges(text, undefined, rules);

    expect(ranges).toHaveLength(1);
    expect(ranges[0].col).toBe(13);
    expect(ranges[0].width).toBe(12);
    expect(ranges[0].backgroundColor).toBe("#06b6d4");
    expect(ranges[0].foregroundColor).toBe("#ffffff"); // Cyan #06b6d4 has luminance 0.52 -> white text
  });


  it("handles invalid regular expressions without throwing", () => {
    const rules: TerminalHighlightRule[] = [
      {
        id: "r1",
        pattern: "[unclosed",
        color: "#ef4444",
        style: "text",
        scope: "global",
        isRegex: true,
      },
    ];

    expect(() => findHighlightRanges("some text", undefined, rules)).not.toThrow();
    expect(findHighlightRanges("some text", undefined, rules)).toEqual([]);
  });
});

describe("terminal-highlighter — TerminalKeywordHighlighter lifecycle", () => {
  let registeredMarkers: IMarker[] = [];
  let registeredDecorations: IDecoration[] = [];
  let mockTerm: XTerm;

  beforeEach(() => {
    registeredMarkers = [];
    registeredDecorations = [];

    useSettingsStore.setState({
      terminalHighlightRules: [
        {
          id: "r-test",
          pattern: "ALERT",
          color: "#ef4444",
          style: "text",
          scope: "global",
          enabled: true,
        },
      ],
    });

    useSessionStore.setState({
      sessions: new Map([
        [
          "session-1",
          {
            id: "session-1",
            status: "Connected",
            label: "Test",
            hostConfig: {
              host: "10.0.0.1",
              port: 22,
              username: "user",
              auth_method: { type: "password", password: "pwd" },
              savedHostId: "host-saved-1",
            },
          },
        ],
      ]),
    });

    const mockBufferLine = {
      translateToString: (_trim: boolean) => "System ALERT: high load detected",
      getCell: () => ({
        getChars: () => "a",
        getWidth: () => 1,
      }),
    } as unknown as IBufferLine;

    const mockBuffer = {
      viewportY: 0,
      baseY: 0,
      cursorY: 0,
      length: 1,
      getLine: (_idx: number) => mockBufferLine,
    };

    mockTerm = {
      rows: 24,
      cols: 80,
      buffer: { active: mockBuffer },
      registerMarker: (offset: number) => {
        const marker = {
          id: registeredMarkers.length + 1,
          line: offset,
          isDisposed: false,
          dispose: vi.fn(),
          onDispose: vi.fn(),
        } as unknown as IMarker;
        registeredMarkers.push(marker);
        return marker;
      },
      registerDecoration: (options: unknown) => {
        const decoration = {
          options,
          dispose: vi.fn(),
          onDispose: vi.fn(),
        } as unknown as IDecoration;
        registeredDecorations.push(decoration);
        return decoration;
      },
      refresh: vi.fn(),
      onWriteParsed: () => ({ dispose: vi.fn() }),
      onScroll: () => ({ dispose: vi.fn() }),
      onResize: () => ({ dispose: vi.fn() }),
    } as unknown as XTerm;
  });

  it("scans viewport and registers decoration for matched keywords", () => {
    const highlighter = new TerminalKeywordHighlighter("session-1", mockTerm);
    highlighter.scanViewport();

    expect(registeredMarkers).toHaveLength(1);
    expect(registeredDecorations).toHaveLength(1);
    expect((registeredDecorations[0].options as { x: number; width: number }).x).toBe(7);
    expect((registeredDecorations[0].options as { x: number; width: number }).width).toBe(5);

    highlighter.dispose();
  });

  it("disposes decorations on dispose()", () => {
    const highlighter = new TerminalKeywordHighlighter("session-1", mockTerm);
    highlighter.scanViewport();

    expect(registeredDecorations).toHaveLength(1);
    const dec = registeredDecorations[0];

    highlighter.dispose();
    expect(dec.dispose).toHaveBeenCalled();
  });
});
