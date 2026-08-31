/*
 * Tests for global keyboard shortcuts and focus handling.
 * Verifies platform-specific modifier key detection (Cmd on macOS vs Ctrl on Win/Linux),
 * proper bypass for input/textarea elements, execution in xterm-helper-textarea,
 * predicate guards, and default event cancellation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useKeyboardShortcuts, type ShortcutDef } from "../use-keyboard-shortcuts";

describe("useKeyboardShortcuts", () => {
  let originalPlatform: string;

  beforeEach(() => {
    originalPlatform = navigator.platform;
  });

  afterEach(() => {
    Object.defineProperty(navigator, "platform", {
      value: originalPlatform,
      configurable: true,
    });
  });

  it("fires shortcut action when modifier and key match on macOS", () => {
    Object.defineProperty(navigator, "platform", {
      value: "MacIntel",
      configurable: true,
    });

    const action = vi.fn();
    const shortcuts: ShortcutDef[] = [
      { key: "b", meta: true, action },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts));

    const event = new KeyboardEvent("keydown", {
      key: "b",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    const preventDefaultSpy = vi.spyOn(event, "preventDefault");
    const stopPropagationSpy = vi.spyOn(event, "stopPropagation");

    document.dispatchEvent(event);

    expect(action).toHaveBeenCalledTimes(1);
    expect(preventDefaultSpy).toHaveBeenCalled();
    expect(stopPropagationSpy).toHaveBeenCalled();
  });

  it("fires shortcut action using Ctrl key on Windows/Linux", () => {
    Object.defineProperty(navigator, "platform", {
      value: "Linux x86_64",
      configurable: true,
    });

    const action = vi.fn();
    const shortcuts: ShortcutDef[] = [
      { key: "t", meta: true, action },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts));

    // Ctrl+T should trigger on Linux
    const event = new KeyboardEvent("keydown", {
      key: "t",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    document.dispatchEvent(event);

    expect(action).toHaveBeenCalledTimes(1);
  });

  it("requires Shift key when shift: true is configured", () => {
    Object.defineProperty(navigator, "platform", {
      value: "MacIntel",
      configurable: true,
    });

    const action = vi.fn();
    const shortcuts: ShortcutDef[] = [
      { key: "e", meta: true, shift: true, action },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts));

    // Cmd+E without shift should NOT trigger
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "e", metaKey: true, shiftKey: false }));
    expect(action).not.toHaveBeenCalled();

    // Cmd+Shift+E SHOULD trigger
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "e", metaKey: true, shiftKey: true }));
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("does not fire when typing inside a normal HTML input or textarea", () => {
    Object.defineProperty(navigator, "platform", {
      value: "MacIntel",
      configurable: true,
    });

    const action = vi.fn();
    const shortcuts: ShortcutDef[] = [
      { key: "k", meta: true, action },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts));

    const input = document.createElement("input");
    document.body.appendChild(input);

    const event = new KeyboardEvent("keydown", {
      key: "k",
      metaKey: true,
      bubbles: true,
    });
    input.dispatchEvent(event);

    expect(action).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });

  it("fires inside xterm's hidden textarea (xterm-helper-textarea)", () => {
    Object.defineProperty(navigator, "platform", {
      value: "MacIntel",
      configurable: true,
    });

    const action = vi.fn();
    const shortcuts: ShortcutDef[] = [
      { key: "w", meta: true, action },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts));

    const xtermTextarea = document.createElement("textarea");
    xtermTextarea.className = "xterm-helper-textarea";
    document.body.appendChild(xtermTextarea);

    const event = new KeyboardEvent("keydown", {
      key: "w",
      metaKey: true,
      bubbles: true,
    });
    xtermTextarea.dispatchEvent(event);

    expect(action).toHaveBeenCalledTimes(1);
    document.body.removeChild(xtermTextarea);
  });

  it("respects when guard function", () => {
    Object.defineProperty(navigator, "platform", {
      value: "MacIntel",
      configurable: true,
    });

    let allowed = false;
    const action = vi.fn();
    const shortcuts: ShortcutDef[] = [
      { key: "d", meta: true, action, when: () => allowed },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts));

    // When condition returns false
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "d", metaKey: true }));
    expect(action).not.toHaveBeenCalled();

    // When condition returns true
    allowed = true;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "d", metaKey: true }));
    expect(action).toHaveBeenCalledTimes(1);
  });
});
