/*
 * Integrity checks for the bundled terminal color schemes. These guard the
 * picker and the xterm palette contract: every scheme must be selectable by a
 * unique id and define the full color set xterm expects.
 */

import { describe, it, expect } from "vitest";
import { TERMINAL_SCHEMES, getTerminalScheme } from "./terminal-themes";

const ANSI_KEYS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow",
  "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

describe("terminal scheme gallery", () => {
  it("has unique ids", () => {
    const ids = TERMINAL_SCHEMES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("defines the full palette for every scheme", () => {
    for (const { id, name, theme } of TERMINAL_SCHEMES) {
      expect(name, `${id} name`).toBeTruthy();
      for (const key of ["background", "foreground", "cursor", "cursorAccent",
        "selectionBackground", "selectionForeground"] as const) {
        expect(theme[key], `${id}.${key}`).toMatch(HEX);
      }
      for (const key of ANSI_KEYS) {
        expect(theme[key], `${id}.${key}`).toMatch(HEX);
      }
    }
  });

  it("looks up schemes by id and rejects unknown ids", () => {
    expect(getTerminalScheme("dracula")?.name).toBe("Dracula");
    expect(getTerminalScheme("nope")).toBeUndefined();
    expect(getTerminalScheme(null)).toBeUndefined();
    expect(getTerminalScheme("")).toBeUndefined();
  });
});
