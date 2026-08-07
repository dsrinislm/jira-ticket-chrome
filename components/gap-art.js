import { gapArt, gapArtBulk } from "./ui.js";

const PALETTE = [
  [91, 75, 255],
  [145, 132, 255],
  [196, 191, 255],
];

const reducedMotion =
  (typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) ||
  false;

const scenes = [gapArt, gapArtBulk].filter(Boolean).map((canvas) => ({
  canvas,
  ctx: null,
  width: 0,
  height: 0,
  particles: [],
}));

function spawn(scene) {
  const count = Math.max(24, Math.round((scene.width * scene.height) / 9000));
  scene.particles = Array.from({ length: count }, () => ({
    x: Math.random() * scene.width,
    y: Math.random() * scene.height,
    r: 0.6 + Math.random() * 1.8,
    vx: (Math.random() - 0.5) * 0.6,
    vy: -(0.2 + Math.random() * 0.5),
    alpha: 0.12 + Math.random() * 0.35,
    color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
  }));
}

function resize(scene) {
  const rect = scene.canvas.getBoundingClientRect();
  const dpr = Math.min(
    2,
    (typeof window !== "undefined" && window.devicePixelRatio) || 1,
  );
  scene.width = Math.max(1, Math.round(rect.width));
  scene.height = Math.max(1, Math.round(rect.height));
  scene.canvas.width = Math.round(scene.width * dpr);
  scene.canvas.height = Math.round(scene.height * dpr);
  scene.ctx = scene.canvas.getContext("2d");
  scene.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  spawn(scene);
}

function paint(scene) {
  scene.ctx.clearRect(0, 0, scene.width, scene.height);
  for (const p of scene.particles) {
    const [r, g, b] = p.color;
    scene.ctx.beginPath();
    scene.ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    scene.ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${p.alpha.toFixed(3)})`;
    scene.ctx.fill();
  }
}

function update(scene) {
  for (const p of scene.particles) {
    p.x += p.vx;
    p.y += p.vy;
    if (p.y < -4) {
      p.y = scene.height + 4;
      p.x = Math.random() * scene.width;
    }
    if (p.x < -4) p.x = scene.width + 4;
    if (p.x > scene.width + 4) p.x = -4;
  }
}

let rafId = 0;
let running = false;
let lastPaintTime = 0;
const FRAME_INTERVAL_MS = 1000 / 30;

function frame(now) {
  if (!running) return;
  if (now - lastPaintTime >= FRAME_INTERVAL_MS) {
    lastPaintTime = now;
    for (const scene of scenes) {
      const visible =
        scene.canvas.clientWidth > 0 && scene.canvas.clientHeight > 0;
      if (!visible) continue;
      if (
        scene.canvas.clientWidth !== scene.width ||
        scene.canvas.clientHeight !== scene.height
      ) {
        resize(scene);
        paint(scene);
      } else if (!reducedMotion) {
        update(scene);
        paint(scene);
      }
    }
  }
  rafId = requestAnimationFrame(frame);
}

function start() {
  if (running) return;
  running = true;
  rafId = requestAnimationFrame(frame);
}

function stop() {
  running = false;
  cancelAnimationFrame(rafId);
}

function syncVisibility() {
  const visible =
    scenes.some(
      (scene) => scene.canvas.clientWidth > 0 && scene.canvas.clientHeight > 0,
    ) &&
    !(typeof document !== "undefined" && document.hidden);
  if (visible) {
    for (const scene of scenes) {
      if (scene.canvas.clientWidth > 0 && scene.canvas.clientHeight > 0) {
        resize(scene);
        paint(scene);
      }
    }
    start();
  } else {
    stop();
  }
}

export function startGapArt() {
  document.addEventListener("visibilitychange", syncVisibility);

  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(syncVisibility);
    scenes.forEach((scene) => observer.observe(scene.canvas));
  }
  syncVisibility();
}
