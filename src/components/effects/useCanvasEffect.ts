/*
 * Canvas lifecycle for an effect theme.
 *
 * Owns everything that is not theme-specific and was previously copy-pasted into
 * each effect component: 2D context setup, high-DPI scaling (DPR clamped to 2),
 * debounced resize → scene rebuild, a frame-rate-throttled requestAnimationFrame
 * loop, tab-hidden pausing, and pointer-proximity tracking. Theme-specific work
 * is delegated to `def.createScene` / `def.draw`.
 *
 * All mutable values are read through refs so the loop is initialized exactly
 * once; the scene is rebuilt only when the viewport size or density changes.
 */

import { useEffect, useRef, type RefObject } from "react";
import type { EffectControls, EffectDefinition } from "./types";

interface PointerState {
  x: number;
  y: number;
  lastActive: number;
}

export function useCanvasEffect<S>(
  def: EffectDefinition<S>,
  controls: EffectControls
): RefObject<HTMLCanvasElement | null> {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<S | null>(null);
  const rebuildRef = useRef<() => void>(() => {});
  const pointerRef = useRef<PointerState>({ x: -9999, y: -9999, lastActive: 0 });

  const defRef = useRef(def);
  const controlsRef = useRef(controls);
  defRef.current = def;
  controlsRef.current = controls;

  // Rebuild the scene when density changes: density controls scene population,
  // which is only sampled at scene-creation time.
  useEffect(() => {
    rebuildRef.current();
  }, [controls.density]);

  // Recolor live elements in place so a palette change reads instantly instead
  // of waiting for each element to recycle with the new colours.
  useEffect(() => {
    const scene = sceneRef.current;
    if (scene !== null) defRef.current.recolor?.(scene, controlsRef.current.palette);
  }, [controls.paletteKey]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    let width = window.innerWidth;
    let height = window.innerHeight;

    const buildScene = () => {
      const current = controlsRef.current;
      sceneRef.current = defRef.current.createScene(
        { w: width, h: height },
        { palette: current.palette, density: current.density, toggles: current.toggles }
      );
    };
    rebuildRef.current = buildScene;

    const resizeCanvas = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      if (typeof ctx.setTransform === "function") {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
      if (typeof ctx.scale === "function") {
        ctx.scale(dpr, dpr);
      }
      buildScene();
    };

    resizeCanvas();

    let resizeTimer: ReturnType<typeof setTimeout>;
    const handleResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resizeCanvas, 150);
    };

    const handlePointerMove = (e: PointerEvent) => {
      pointerRef.current = { x: e.clientX, y: e.clientY, lastActive: Date.now() };
    };

    const handlePointerLeave = () => {
      pointerRef.current = { x: -9999, y: -9999, lastActive: 0 };
    };

    window.addEventListener("resize", handleResize);
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    window.addEventListener("pointerleave", handlePointerLeave);

    const frameInterval = 1000 / defRef.current.fps;
    let lastFrameTime = performance.now();
    let animFrameId = 0;

    const drawFrame = (currentTime: number) => {
      animFrameId = requestAnimationFrame(drawFrame);

      if (!controlsRef.current.isVisible) return;

      const elapsed = currentTime - lastFrameTime;
      if (elapsed < frameInterval) return;
      lastFrameTime = currentTime - (elapsed % frameInterval);

      if (!controlsRef.current.isRunning) return;

      const scene = sceneRef.current;
      if (scene === null) return;

      const current = controlsRef.current;
      const pointer = pointerRef.current;

      ctx.clearRect(0, 0, width, height);
      defRef.current.draw(ctx, scene, {
        width,
        height,
        dt: elapsed,
        speed: current.speed,
        brightness: current.brightness,
        density: current.density,
        toggles: current.toggles,
        palette: current.palette,
        pointer: {
          x: pointer.x,
          y: pointer.y,
          active: Date.now() - pointer.lastActive < 2000,
        },
      });
    };

    animFrameId = requestAnimationFrame(drawFrame);

    // Pause when the window/tab is hidden to save energy.
    const handleVisibilityChange = () => {
      if (document.hidden) {
        cancelAnimationFrame(animFrameId);
      } else {
        /*
         * Cancel any prior frame to maintain the single-chain invariant
         * before scheduling, preventing redundant events from spawning loops.
         */
        cancelAnimationFrame(animFrameId);
        lastFrameTime = performance.now();
        animFrameId = requestAnimationFrame(drawFrame);
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelAnimationFrame(animFrameId);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerleave", handlePointerLeave);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      clearTimeout(resizeTimer);
    };
  }, []);

  return canvasRef;
}
