import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { registerSearchAddon, unregisterSearchAddon } from "./terminal-registry";
import { useSettingsStore } from "./settings-store";
import {
  useSessionStore,
  findTabForSession,
  collectSessionIds,
} from "./session-store";
import { useHostsStore } from "./hosts-store";
import { parseOsc7Cwd } from "../lib/osc7";
import { getTerminalScheme } from "../lib/terminal-themes";
import { TerminalKeywordHighlighter } from "../lib/terminal-highlighter";

/**
 * Module-level registry of live xterm.js instances, keyed by sessionId.
 *
 * xterm holds the scrollback buffer (the user's commands + output history) in
 * memory. React unmounts/remounts the <Terminal> component whenever the layout
 * tree changes shape — e.g. a single pane becoming a split — because the
 * component type at that tree position changes. If the xterm instance were
 * owned by the component's effect, that remount would dispose the buffer and
 * the user would lose their history on every split.
 *
 * So the instance and its host DOM element live here instead, decoupled from
 * the component lifecycle. The component only attaches/detaches the cached
 * element. The instance is disposed only when the session itself is removed.
 */
export interface TerminalEntry {
  term: XTerm;
  /** The element xterm renders into; reparented as the component remounts. */
  element: HTMLDivElement;
  fitAddon: FitAddon;
  /** Pending debounced PTY-resize timer, cleared on dispose. */
  resizeTimer: ReturnType<typeof setTimeout> | null;
  /** Real-time keyword highlighter for matching patterns and colors. */
  highlighter?: TerminalKeywordHighlighter;
}

const instances = new Map<string, TerminalEntry>();

/**
 * Open a URL clicked in the terminal via the OS default browser.
 *
 * xterm's built-in OSC 8 handler (and a naive WebLinksAddon) would fall back to
 * `window.open()`, which does not work inside the Tauri webview and surfaces a
 * browser error. Route through the Tauri opener instead. The plugin is
 * lazy-imported per project convention (no module-level Tauri imports).
 */
function openTerminalLink(uri: string): void {
  void (async () => {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(uri);
    } catch {
      /* Opener unavailable (e.g. not running in Tauri) */
    }
  })();
}

/**
 * ANSI 16-color palettes. xterm.js falls back to its built-in palette when
 * these are unset, and that default green (#0DBC79) is nearly illegible on a
 * light background — so we ship palettes tuned for each background's contrast.
 */
const ANSI_PALETTE_DARK = {
  black: "#2e3436",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#ffffff",
};

const ANSI_PALETTE_LIGHT = {
  black: "#24292e",
  red: "#cf222e",
  green: "#116329",
  yellow: "#953800",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#633c01",
  brightBlue: "#0550ae",
  brightMagenta: "#8250df",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
};

/*
 * High-contrast cyber phosphor palette for Matrix theme terminal sessions.
 * Preserves standard ANSI color meaning with neon green bias and bright indicators.
 */
const ANSI_PALETTE_MATRIX = {
  black: "#040805",
  red: "#ff5252",
  green: "#00ff66",
  yellow: "#b8ff52",
  blue: "#00e5ff",
  magenta: "#d670ff",
  cyan: "#26ffc9",
  white: "#c6fadc",
  brightBlack: "#1b3824",
  brightRed: "#ff7b7b",
  brightGreen: "#4dff8f",
  brightYellow: "#d2ff85",
  brightBlue: "#52f0ff",
  brightMagenta: "#e499ff",
  brightCyan: "#66ffda",
  brightWhite: "#ffffff",
};

/*
 * Blood-and-ember palette for Berserk theme terminal sessions.
 * Keeps standard ANSI color meaning while biasing toward blood crimson, ember
 * gold, and bone-white indicators over a dark-fantasy base.
 */
const ANSI_PALETTE_BERSERK = {
  black: "#1a0d10",
  red: "#c1121f",
  green: "#6b7f3a",
  yellow: "#d4a017",
  blue: "#4a5a7a",
  magenta: "#8a3a5a",
  cyan: "#5a7a72",
  white: "#d9cdbf",
  brightBlack: "#3a2a2a",
  brightRed: "#ff3b30",
  brightGreen: "#9db35a",
  brightYellow: "#ffcc4d",
  brightBlue: "#6b84b0",
  brightMagenta: "#c25a7a",
  brightCyan: "#8fb3a8",
  brightWhite: "#ffffff",
};

/*
 * Abyssal palette for Deep Sea theme sessions: cool cyan/teal bias with a bright
 * aqua accent, keeping standard ANSI colour meaning.
 */
const ANSI_PALETTE_DEEPSEA = {
  black: "#030814",
  red: "#ff6b81",
  green: "#2fd8bd",
  yellow: "#ffd97a",
  blue: "#3fa9f5",
  magenta: "#8f7cff",
  cyan: "#4fe0ff",
  white: "#cfe6f2",
  brightBlack: "#1b3550",
  brightRed: "#ff8fa3",
  brightGreen: "#5df0d6",
  brightYellow: "#ffe9a8",
  brightBlue: "#6fc2ff",
  brightMagenta: "#b0a4ff",
  brightCyan: "#8af0ff",
  brightWhite: "#ffffff",
};

/*
 * Starlight palette for Starfield theme sessions: cool blue/white bias with a
 * familiar mid-blue "blue" slot so standard ANSI meaning is preserved.
 */
const ANSI_PALETTE_STARFIELD = {
  black: "#05060d",
  red: "#ff6b81",
  green: "#4fe0a0",
  yellow: "#ffe08a",
  blue: "#6f8fd8",
  magenta: "#c084fc",
  cyan: "#7fd8ff",
  white: "#dbe7ff",
  brightBlack: "#1c2436",
  brightRed: "#ff8fa3",
  brightGreen: "#7ff0bd",
  brightYellow: "#fff0b8",
  brightBlue: "#9fb8ff",
  brightMagenta: "#d8a8ff",
  brightCyan: "#a8e8ff",
  brightWhite: "#ffffff",
};

/*
 * Desaturated palette for Fog theme sessions: muted, low-saturation tones that
 * match the theme's deliberate lack of bright highlights.
 */
const ANSI_PALETTE_FOG = {
  black: "#0b0d0c",
  red: "#c96b5a",
  green: "#8aa06a",
  yellow: "#c2ad72",
  blue: "#6f8593",
  magenta: "#9a7c8a",
  cyan: "#7f9a93",
  white: "#c3ccc6",
  brightBlack: "#3d463f",
  brightRed: "#e08a76",
  brightGreen: "#a8c084",
  brightYellow: "#ddc98f",
  brightBlue: "#8fa8b8",
  brightMagenta: "#b89cae",
  brightCyan: "#a0c0b8",
  brightWhite: "#eef2ef",
};

/*
 * Light-contrast palette for the Sakura theme's light base — mirroring
 * ANSI_PALETTE_LIGHT (dark inks for legibility on an off-white background) with
 * a warmed, rose-biased neutral.
 */
const ANSI_PALETTE_SAKURA = {
  black: "#3a2e33",
  red: "#c9255a",
  green: "#116329",
  yellow: "#8a5a10",
  blue: "#3a5bbf",
  magenta: "#a03a86",
  cyan: "#1b7c83",
  white: "#8a7a80",
  brightBlack: "#6b5c62",
  brightRed: "#e0436e",
  brightGreen: "#1a7f37",
  brightYellow: "#a06a18",
  brightBlue: "#5573d6",
  brightMagenta: "#c25aa6",
  brightCyan: "#3192aa",
  brightWhite: "#b0a2a8",
};

/*
 * Dark, warmly-lit palette for the Sakura Night theme: pale ink over a near-black
 * rose base, matching that theme's moonlit petals and violet shafts.
 */
const ANSI_PALETTE_SAKURA_NIGHT = {
  black: "#140a12",
  red: "#ff6b8a",
  green: "#8ad8a8",
  yellow: "#ffd18a",
  blue: "#7f9ae0",
  magenta: "#d88ad8",
  cyan: "#7fd8d0",
  white: "#f2dae4",
  brightBlack: "#3a2436",
  brightRed: "#ff94ac",
  brightGreen: "#a8f0c0",
  brightYellow: "#ffe8b0",
  brightBlue: "#a0b8ff",
  brightMagenta: "#f0a8f0",
  brightCyan: "#a8f0ea",
  brightWhite: "#ffffff",
};

/*
 * Golden-order palette for Erdtree theme sessions: ember gold and pale bone over
 * a warm dark base, with the standard ANSI roles intact.
 */
const ANSI_PALETTE_ERDTREE = {
  black: "#0d0a04",
  red: "#c25a4a",
  green: "#9aa84c",
  yellow: "#e0b040",
  blue: "#6f7fa8",
  magenta: "#a86a8a",
  cyan: "#7fa8a0",
  white: "#e8dcc0",
  brightBlack: "#4a3d1c",
  brightRed: "#e07a5a",
  brightGreen: "#c0d06a",
  brightYellow: "#ffd45e",
  brightBlue: "#93a8d8",
  brightMagenta: "#c89ab8",
  brightCyan: "#a8d0c8",
  brightWhite: "#fff6d8",
};

/** Theme id → contrast-tuned ANSI palette. Unknown ids fall back to dark. */
const ANSI_PALETTES: Record<string, typeof ANSI_PALETTE_DARK> = {
  matrix: ANSI_PALETTE_MATRIX,
  berserk: ANSI_PALETTE_BERSERK,
  deepsea: ANSI_PALETTE_DEEPSEA,
  starfield: ANSI_PALETTE_STARFIELD,
  fog: ANSI_PALETTE_FOG,
  sakura: ANSI_PALETTE_SAKURA,
  "sakura-night": ANSI_PALETTE_SAKURA_NIGHT,
  erdtree: ANSI_PALETTE_ERDTREE,
};

/** Read OKLCH CSS custom properties and convert to hex for xterm.js. */
export function getTerminalTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement);
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) return {};

  function toHex(cssVar: string): string {
    const value = styles.getPropertyValue(cssVar).trim();
    if (!value) return "#000000";
    ctx!.clearRect(0, 0, 1, 1);
    ctx!.fillStyle = value;
    ctx!.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx!.getImageData(0, 0, 1, 1).data;
    if (a < 255) {
      return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}${a.toString(16).padStart(2, "0")}`;
    }
    return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
  }

  const themeAttr = document.documentElement.dataset.theme;
  const ansi =
    themeAttr === "light"
      ? ANSI_PALETTE_LIGHT
      : themeAttr
        ? ANSI_PALETTES[themeAttr] ?? ANSI_PALETTE_DARK
        : ANSI_PALETTE_DARK;

  return {
    background: toHex("--color-bg-base"),
    foreground: toHex("--color-text-primary"),
    cursor: toHex("--color-accent"),
    cursorAccent: toHex("--color-bg-base"),
    selectionBackground: toHex("--color-accent-muted"),
    selectionForeground: toHex("--color-text-primary"),
    ...ansi,
  };
}

/*
 * Resolve the palette for a host's stored scheme id, falling back to the
 * app-derived theme when the host has no scheme (or an unknown one, e.g. from a
 * newer build). Kept separate from getTerminalTheme so callers that only know
 * the id (the modal preview) don't need a live session.
 */
export function resolveTerminalTheme(schemeId?: string | null): ITheme {
  const scheme = getTerminalScheme(schemeId);
  return scheme ? scheme.theme : getTerminalTheme();
}

/*
 * Palette for a live session. A session carries its saved host id, which we
 * resolve against the hosts store to recover the scheme. Quick (unsaved)
 * connections have no saved host and fall back to the app theme.
 */
export function terminalThemeForSession(sessionId: string): ITheme {
  const savedHostId = useSessionStore.getState().sessions.get(sessionId)?.hostConfig.savedHostId;
  const schemeId = savedHostId
    ? useHostsStore.getState().hosts.find((h) => h.id === savedHostId)?.terminal_theme ?? null
    : null;
  return resolveTerminalTheme(schemeId);
}

function createEntry(sessionId: string): TerminalEntry {
  const settings = useSettingsStore.getState();

  const element = document.createElement("div");
  element.className = "h-full w-full";

  const term = new XTerm({
    cursorBlink: settings.terminalCursorBlink,
    cursorStyle: settings.terminalCursorStyle,
    fontSize: settings.terminalFontSize,
    fontFamily: settings.terminalFontFamily,
    fontWeight: "400",
    fontWeightBold: "600",
    lineHeight: settings.terminalLineHeight,
    letterSpacing: 0,
    scrollback: settings.terminalScrollback,
    theme: terminalThemeForSession(sessionId),
    allowProposedApi: true,
    allowTransparency: true,
    // Open OSC 8 hyperlinks (emitted by ls --hyperlink, git, etc.) through the
    // OS browser instead of xterm's window.open() fallback, which errors in the
    // Tauri webview.
    linkHandler: {
      activate: (_event, uri) => openTerminalLink(uri),
    },
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(element);

  /*
   * Handle OSC 7 working-directory notifications emitted by remote shells.
   * Updates remoteCwd in session-store so linked tools (e.g. explorer) stay in sync.
   */
  term.parser.registerOscHandler(7, (data) => {
    try {
      const r = parseOsc7Cwd(data);
      if (r) {
        useSessionStore.getState().setRemoteCwd(sessionId, r.path);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  });

  const highlighter = new TerminalKeywordHighlighter(sessionId, term);
  const entry: TerminalEntry = { term, element, fitAddon, resizeTimer: null, highlighter };

  // Load search addon asynchronously.
  import("@xterm/addon-search")
    .then(({ SearchAddon }) => {
      // Guard against disposal while the dynamic import was in flight.
      if (!instances.has(sessionId)) return;
      const searchAddon = new SearchAddon();
      term.loadAddon(searchAddon);
      registerSearchAddon(sessionId, searchAddon);
    })
    .catch(() => {
      /* Search unavailable */
    });

  // Load web-links addon asynchronously — makes plain-text URLs in the output
  // clickable (OSC 8 hyperlinks are handled by the linkHandler option above).
  import("@xterm/addon-web-links")
    .then(({ WebLinksAddon }) => {
      if (!instances.has(sessionId)) return;
      term.loadAddon(new WebLinksAddon((_event, uri) => openTerminalLink(uri)));
    })
    .catch(() => {
      /* Web links unavailable */
    });

  term.attachCustomKeyEventHandler((e) => {
    if (e.metaKey && e.shiftKey && e.key === "s") return false;
    if (e.metaKey && e.shiftKey && e.key.toLowerCase() === "e") return false;
    if (e.metaKey && !e.shiftKey && e.key === "t") return false;
    if (e.metaKey && !e.shiftKey && e.key === "b") return false;
    if (e.metaKey && !e.shiftKey && e.key === "w") return false;
    if (e.metaKey && !e.shiftKey && e.key >= "1" && e.key <= "9") return false;
    if (e.metaKey && (e.key === "[" || e.key === "]")) return false;
    if (e.metaKey && !e.shiftKey && e.key === "f") return false;
    // Cmd+K — snippet palette
    if (e.metaKey && !e.shiftKey && e.key === "k") return false;
    if (e.metaKey && e.key.toLowerCase() === "d") return false;
    if (e.metaKey && e.shiftKey && e.key === "Enter") return false;
    if (e.metaKey && e.altKey && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key))
      return false;
    // Opt+Cmd+S / Alt+Ctrl+S — sync split panes toggle
    if (e.metaKey && e.altKey && e.key.toLowerCase() === "s") return false;
    return true;
  });

  /*
   * Forward input to the active session or broadcast in parallel across all split
   * panes in the tab when parallel input synchronization is enabled.
   */
  term.onData((data) => {
    (async () => {
      const sessionStore = useSessionStore.getState();
      const tabId = findTabForSession(sessionStore.tabs, sessionId);
      const isSynced = tabId ? sessionStore.isTabSynced(tabId) : false;

      let targetSessionIds = [sessionId];
      if (isSynced && tabId) {
        const tab = sessionStore.tabs.get(tabId);
        if (tab) {
          const allIds = collectSessionIds(tab.layout);
          if (allIds.length > 1) {
            targetSessionIds = allIds;
          }
        }
      }

      const { invoke } = await import("@tauri-apps/api/core");
      const bytes = Array.from(new TextEncoder().encode(data));

      await Promise.allSettled(
        targetSessionIds.map(async (targetId) => {
          const s = sessionStore.sessions.get(targetId);
          if (s && (s.status === "Disconnected" || s.status === "Error")) return;
          try {
            await invoke("ssh_send_input", { sessionId: targetId, data: bytes });
          } catch {
            /* Per-session input dispatch failure ignored */
          }
        }),
      );
    })();
  });

  // Debounce PTY resize requests; the timer lives on the entry (not a closure
  // local) so disposeTerminal can cancel a pending resize that would otherwise
  // fire ssh_resize_pty against an already-removed session.
  term.onResize(({ cols, rows }) => {
    if (entry.resizeTimer) clearTimeout(entry.resizeTimer);
    entry.resizeTimer = setTimeout(() => {
      entry.resizeTimer = null;
      (async () => {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("ssh_resize_pty", { sessionId, cols, rows });
      })().catch(() => {
        /* session may have been torn down between schedule and fire */
      });
    }, 150);
  });

  // E2E test hook — exposes the xterm instance so tests can read the buffer
  // without poking at canvas/DOM internals.
  if (typeof window !== "undefined") {
    const reg = ((window as unknown as { __e2eTerminals?: Map<string, XTerm> }).__e2eTerminals ??=
      new Map<string, XTerm>());
    reg.set(sessionId, term);
  }

  return entry;
}

/** Get the cached terminal for a session, creating it on first request. */
export function ensureTerminal(sessionId: string): TerminalEntry {
  let entry = instances.get(sessionId);
  if (!entry) {
    entry = createEntry(sessionId);
    instances.set(sessionId, entry);
  }
  return entry;
}

/** Get the cached terminal for a session without creating one. */
export function getTerminal(sessionId: string): TerminalEntry | undefined {
  return instances.get(sessionId);
}

/** Dispose a terminal instance and release all associated resources. */
export function disposeTerminal(sessionId: string): void {
  const entry = instances.get(sessionId);
  if (!entry) return;
  instances.delete(sessionId);
  unregisterSearchAddon(sessionId);
  if (typeof window !== "undefined") {
    (window as unknown as { __e2eTerminals?: Map<string, XTerm> }).__e2eTerminals?.delete(sessionId);
  }
  entry.highlighter?.dispose();
  if (entry.resizeTimer) clearTimeout(entry.resizeTimer);
  entry.element.parentElement?.removeChild(entry.element);
  entry.term.dispose();
}

// Garbage-collect xterm instances when their session is removed from the store.
// The instance must outlive React component remounts (splits, tab switches), so
// the store — the source of truth for which sessions exist — drives disposal.
const unsubscribe = useSessionStore.subscribe((state) => {
  for (const sessionId of instances.keys()) {
    if (!state.sessions.has(sessionId)) {
      disposeTerminal(sessionId);
    }
  }
});

// On HMR, tear down the old subscription and dispose live instances so the
// re-evaluated module starts from a clean Map instead of leaking a stale
// subscription that keeps mutating an orphaned one. No-op in production.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribe();
    for (const sessionId of [...instances.keys()]) {
      disposeTerminal(sessionId);
    }
  });
}
