import type { ITheme } from "@xterm/xterm";

/*
 * Bundled terminal color schemes for per-host theming.
 *
 * A saved host stores only the scheme id below; the palette itself lives here so
 * the database and Rust layer stay theme-agnostic. Palettes are literal hex and
 * intentionally do NOT react to the app's dark/light mode — a host pinned to
 * Dracula stays Dracula in either app theme. Hosts with no scheme (`null`) keep
 * the app-derived look produced by `getTerminalTheme()`.
 */
export interface TerminalColorScheme {
  /** Stable, persisted value stored on the host record. */
  id: string;
  /** Human-readable label shown in the picker. */
  name: string;
  /** Full xterm palette. */
  theme: ITheme;
}

function scheme(
  id: string,
  name: string,
  palette: {
    background: string;
    foreground: string;
    cursor: string;
    selection: string;
    ansi: [
      string, string, string, string, string, string, string, string,
      string, string, string, string, string, string, string, string,
    ];
  },
): TerminalColorScheme {
  const [black, red, green, yellow, blue, magenta, cyan, white,
    brightBlack, brightRed, brightGreen, brightYellow,
    brightBlue, brightMagenta, brightCyan, brightWhite] = palette.ansi;
  return {
    id,
    name,
    theme: {
      background: palette.background,
      foreground: palette.foreground,
      cursor: palette.cursor,
      cursorAccent: palette.background,
      selectionBackground: palette.selection,
      selectionForeground: palette.foreground,
      black, red, green, yellow, blue, magenta, cyan, white,
      brightBlack, brightRed, brightGreen, brightYellow,
      brightBlue, brightMagenta, brightCyan, brightWhite,
    },
  };
}

export const TERMINAL_SCHEMES: TerminalColorScheme[] = [
  scheme("matrix", "Matrix", {
    background: "#070d08",
    foreground: "#a5f3bc",
    cursor: "#00ff66",
    selection: "#12381e",
    ansi: [
      "#040805", "#ff5252", "#00ff66", "#b8ff52",
      "#00e5ff", "#d670ff", "#26ffc9", "#c6fadc",
      "#1b3824", "#ff7b7b", "#4dff8f", "#d2ff85",
      "#52f0ff", "#e499ff", "#66ffda", "#ffffff",
    ],
  }),
  scheme("berserk", "Berserk", {
    background: "#0a0507",
    foreground: "#e8d7c3",
    cursor: "#c1121f",
    selection: "#3a0d10",
    ansi: [
      "#1a0d10", "#c1121f", "#6b7f3a", "#d4a017",
      "#4a5a7a", "#8a3a5a", "#5a7a72", "#d9cdbf",
      "#3a2a2a", "#ff3b30", "#9db35a", "#ffcc4d",
      "#6b84b0", "#c25a7a", "#8fb3a8", "#ffffff",
    ],
  }),
  scheme("dracula", "Dracula", {
    background: "#282a36",
    foreground: "#f8f8f2",
    cursor: "#f8f8f2",
    selection: "#44475a",
    ansi: [
      "#21222c", "#ff5555", "#50fa7b", "#f1fa8c",
      "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2",
      "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5",
      "#d6acff", "#ff92df", "#a4ffff", "#ffffff",
    ],
  }),
  scheme("nord", "Nord", {
    background: "#2e3440",
    foreground: "#d8dee9",
    cursor: "#d8dee9",
    selection: "#434c5e",
    ansi: [
      "#3b4252", "#bf616a", "#a3be8c", "#ebcb8b",
      "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0",
      "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b",
      "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4",
    ],
  }),
  scheme("solarized-dark", "Solarized Dark", {
    background: "#002b36",
    foreground: "#839496",
    cursor: "#839496",
    selection: "#073642",
    ansi: [
      "#073642", "#dc322f", "#859900", "#b58900",
      "#268bd2", "#d33682", "#2aa198", "#eee8d5",
      "#002b36", "#cb4b16", "#586e75", "#657b83",
      "#839496", "#6c71c4", "#93a1a1", "#fdf6e3",
    ],
  }),
  scheme("solarized-light", "Solarized Light", {
    background: "#fdf6e3",
    foreground: "#657b83",
    cursor: "#586e75",
    selection: "#eee8d5",
    ansi: [
      "#073642", "#dc322f", "#859900", "#b58900",
      "#268bd2", "#d33682", "#2aa198", "#eee8d5",
      "#002b36", "#cb4b16", "#586e75", "#657b83",
      "#839496", "#6c71c4", "#93a1a1", "#fdf6e3",
    ],
  }),
  scheme("gruvbox-dark", "Gruvbox Dark", {
    background: "#282828",
    foreground: "#ebdbb2",
    cursor: "#ebdbb2",
    selection: "#504945",
    ansi: [
      "#282828", "#cc241d", "#98971a", "#d79921",
      "#458588", "#b16286", "#689d6a", "#a89984",
      "#928374", "#fb4934", "#b8bb26", "#fabd2f",
      "#83a598", "#d3869b", "#8ec07c", "#ebdbb2",
    ],
  }),
  scheme("one-dark", "One Dark", {
    background: "#282c34",
    foreground: "#abb2bf",
    cursor: "#528bff",
    selection: "#3e4451",
    ansi: [
      "#282c34", "#e06c75", "#98c379", "#e5c07b",
      "#61afef", "#c678dd", "#56b6c2", "#abb2bf",
      "#5c6370", "#e06c75", "#98c379", "#e5c07b",
      "#61afef", "#c678dd", "#56b6c2", "#ffffff",
    ],
  }),
  scheme("tokyo-night", "Tokyo Night", {
    background: "#1a1b26",
    foreground: "#c0caf5",
    cursor: "#c0caf5",
    selection: "#33467c",
    ansi: [
      "#15161e", "#f7768e", "#9ece6a", "#e0af68",
      "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6",
      "#414868", "#f7768e", "#9ece6a", "#e0af68",
      "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5",
    ],
  }),
  scheme("catppuccin-mocha", "Catppuccin Mocha", {
    background: "#1e1e2e",
    foreground: "#cdd6f4",
    cursor: "#f5e0dc",
    selection: "#585b70",
    ansi: [
      "#45475a", "#f38ba8", "#a6e3a1", "#f9e2af",
      "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de",
      "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af",
      "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8",
    ],
  }),
  scheme("monokai", "Monokai", {
    background: "#272822",
    foreground: "#f8f8f2",
    cursor: "#f8f8f0",
    selection: "#49483e",
    ansi: [
      "#272822", "#f92672", "#a6e22e", "#f4bf75",
      "#66d9ef", "#ae81ff", "#a1efe4", "#f8f8f2",
      "#75715e", "#f92672", "#a6e22e", "#f4bf75",
      "#66d9ef", "#ae81ff", "#a1efe4", "#f9f8f5",
    ],
  }),
];

/** Look up a bundled scheme by id; returns undefined for null/empty/unknown. */
export function getTerminalScheme(
  id: string | null | undefined,
): TerminalColorScheme | undefined {
  if (!id) return undefined;
  return TERMINAL_SCHEMES.find((s) => s.id === id);
}
