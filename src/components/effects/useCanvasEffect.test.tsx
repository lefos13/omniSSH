/*
 * Tests for the shared canvas lifecycle hook.
 *
 * Verifies frame drawing, prefers-reduced-motion suppression, tab-hidden pausing
 * and resuming, high-DPI backing-store scaling (clamped to 2x), and cleanup on
 * unmount — the behaviour every effect theme inherits from the framework.
 */

import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render } from "@testing-library/react";
import { Sparkles } from "lucide-react";
import type { EffectDefinition, Palette } from "./types";
import { useCanvasEffect } from "./useCanvasEffect";
import { useEffectControls } from "./useEffectControls";
import { installCanvasMock } from "./canvasTestUtils";

const PALETTE: Palette = {
  head: "#ffffff",
  glow: "rgba(255,255,255,1)",
  lead: "#eeeeee",
  mid: "#999999",
  deep: "#333333",
  accent: "#aaaaaa",
};

function makeDef(draw: (ctx: CanvasRenderingContext2D, scene: { n: number }) => void) {
  const def: EffectDefinition<{ n: number }> = {
    id: "testfx",
    label: "Test FX",
    icon: Sparkles,
    backgroundColor: "#000000",
    panelLabel: "Test FX settings",
    palettes: { a: PALETTE, b: PALETTE },
    defaultPalette: "a",
    defaults: { speed: 1, brightness: 0.5, density: "medium", toggles: { on: true } },
    fps: 30,
    controls: { palettes: [{ key: "a", label: "A", dot: "bg-white" }] },
    createScene: () => ({ n: 0 }),
    draw: (ctx, scene, env) => {
      scene.n += 1;
      draw(ctx, scene);
      void env;
    },
  };
  return def;
}

function Harness({ def }: { def: EffectDefinition<{ n: number }> }) {
  const controls = useEffectControls(def);
  const canvasRef = useCanvasEffect(def, controls);
  return <canvas ref={canvasRef} />;
}

const originalMatchMedia = window.matchMedia;
let frames: ((time: number) => void)[] = [];
let activeFrames = new Map<number, (time: number) => void>();
let nextFrameId = 1;

const makeRafSpy = () =>
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
    const id = nextFrameId++;
    const callback: FrameRequestCallback = (time) => {
      activeFrames.delete(id);
      cb(time);
    };
    activeFrames.set(id, callback as (time: number) => void);
    frames.push(callback as (time: number) => void);
    return id;
  });
const makeCancelSpy = () =>
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id: number) => {
    activeFrames.delete(id);
  });

let rafSpy: ReturnType<typeof makeRafSpy>;
let cancelSpy: ReturnType<typeof makeCancelSpy>;

beforeAll(installCanvasMock);

beforeEach(() => {
  frames = [];
  activeFrames.clear();
  nextFrameId = 1;
  rafSpy = makeRafSpy();
  cancelSpy = makeCancelSpy();
  window.localStorage.clear();
});

afterEach(() => {
  rafSpy.mockRestore();
  cancelSpy.mockRestore();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
  vi.restoreAllMocks();
});

function stubMatchMedia(reduced: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: reduced,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

describe("useCanvasEffect", () => {
  it("schedules a frame and draws when motion is allowed", () => {
    const draw = vi.fn();
    render(<Harness def={makeDef(draw)} />);

    expect(frames.length).toBeGreaterThan(0);
    frames[0](performance.now() + 1000);
    expect(draw).toHaveBeenCalled();
  });

  it("suppresses drawing when prefers-reduced-motion is set", () => {
    stubMatchMedia(true);
    const draw = vi.fn();
    render(<Harness def={makeDef(draw)} />);

    const initial = frames[0];
    initial(performance.now() + 1000);
    expect(draw).not.toHaveBeenCalled();
  });

  it("pauses on tab hide and resumes on show", () => {
    render(<Harness def={makeDef(vi.fn())} />);
    const scheduleCount = rafSpy.mock.calls.length;

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(cancelSpy).toHaveBeenCalled();

    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(rafSpy.mock.calls.length).toBeGreaterThan(scheduleCount);
  });

  it("scales the backing store by devicePixelRatio, clamped to 2x", () => {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 3 });
    const { container } = render(<Harness def={makeDef(vi.fn())} />);
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;

    expect(canvas.width).toBe(window.innerWidth * 2);
    expect(canvas.height).toBe(window.innerHeight * 2);
  });

  it("cancels the pending frame on unmount", () => {
    const { unmount } = render(<Harness def={makeDef(vi.fn())} />);
    cancelSpy.mockClear();
    unmount();
    expect(cancelSpy).toHaveBeenCalled();
  });

  it("does not spawn orphaned animation loops on repeated visible events", () => {
    const draw = vi.fn();
    const { unmount } = render(<Harness def={makeDef(draw)} />);

    expect(frames.length).toBeGreaterThan(0);
    frames[0](performance.now() + 1000);
    expect(draw).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));

    unmount();

    expect(activeFrames.size).toBe(0);
    for (const frame of Array.from(activeFrames.values())) {
      frame(performance.now() + 2000);
    }
    expect(draw).toHaveBeenCalledTimes(1);
  });
});
