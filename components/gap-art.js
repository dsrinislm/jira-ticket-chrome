import { gapArt } from "./ui.js";

// Decorative canvas that occupies the gap between the "Create ticket" CTA
// and the status bar. The gap opens up when no source site (Octane/Spark)
// is detected, because the source-site section is hidden. It's filled with
// a slow field of drifting dots in the popup's indigo palette.
// Pauses (no drawing) while the canvas is hidden and renders a single
// static frame for reduced-motion users.
const PALETTE = [
  [91, 75, 255],
  [145, 132, 255],
  [196, 191, 255],
];

let ctx = null;
let width = 0;
let height = 0;
let particles = [];
let rafId = 0;

const reducedMotion =
  (typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) ||
  false;

function spawn() {
  const count = Math.max(24, Math.round((width * height) / 9000));
  particles = Array.from({ length: count }, () => ({
    x: Math.random() * width,
    y: Math.random() * height,
    r: 0.6 + Math.random() * 1.8,
    vx: (Math.random() - 0.5) * 0.16,
    vy: -(0.05 + Math.random() * 0.2),
    alpha: 0.12 + Math.random() * 0.35,
    color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
  }));
}

function resize() {
  const rect = gapArt.getBoundingClientRect();
  const dpr = Math.min(
    2,
    (typeof window !== "undefined" && window.devicePixelRatio) || 1,
  );
  width = Math.max(1, Math.round(rect.width));
  height = Math.max(1, Math.round(rect.height));
  gapArt.width = Math.round(width * dpr);
  gapArt.height = Math.round(height * dpr);
  ctx = gapArt.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  spawn();
}

function paint() {
  ctx.clearRect(0, 0, width, height);
  for (const p of particles) {
    const [r, g, b] = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${p.alpha.toFixed(3)})`;
    ctx.fill();
  }
}

function update() {
  for (const p of particles) {
    p.x += p.vx;
    p.y += p.vy;
    if (p.y < -4) {
      p.y = height + 4;
      p.x = Math.random() * width;
    }
    if (p.x < -4) p.x = width + 4;
    if (p.x > width + 4) p.x = -4;
  }
}

function frame() {
  const visible = gapArt.clientWidth > 0 && gapArt.clientHeight > 0;
  if (visible) {
    if (gapArt.clientWidth !== width || gapArt.clientHeight !== height) {
      resize();
      paint();
    } else if (!reducedMotion) {
      update();
      paint();
    }
  }
  rafId = requestAnimationFrame(frame);
}

export function startGapArt() {
  resize();
  frame();
}
