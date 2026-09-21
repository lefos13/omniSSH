/*
 * Shared 2D-canvas test double for the effect-theme tests.
 *
 * jsdom has no real canvas, so the effect framework's draw calls would throw.
 * This installs a no-op context covering every method/property the effect themes
 * use, plus gradient/ImageData factories, so rendering a theme in a unit test
 * exercises the real code paths without a GPU.
 */

import { vi } from "vitest";

export function installCanvasMock(): void {
  if (typeof HTMLCanvasElement === "undefined") return;
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    fillStyle: "",
    strokeStyle: "",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    shadowBlur: 0,
    shadowColor: "",
    lineWidth: 1,
    lineCap: "butt",
    font: "",
    textBaseline: "alphabetic",
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    setTransform: vi.fn(),
    drawImage: vi.fn(),
    fillText: vi.fn(),
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    createImageData: vi.fn((w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4),
      width: w,
      height: h,
    })),
    putImageData: vi.fn(),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) })),
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
}
