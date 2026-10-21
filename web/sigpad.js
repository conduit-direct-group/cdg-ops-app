// A finger / mouse signature box (Chris, 10-21-2026: Supervisor and witnesses sign injury and first-aid reports).
// Black ink on a white box, like paper; saved as a small PNG. sigPad({ label }) → { el, isEmpty(), png(), clear() }.

import { el } from "./ui.js";

const W = 600, H = 180; // fixed drawing size keeps the PNG small whatever the screen

export function sigPad({ label = "Sign here" } = {}) {
  const canvas = el("canvas", { class: "sigpad-canvas", width: String(W), height: String(H), "aria-label": label, role: "img" });
  const ctx = canvas.getContext("2d");
  const ink = getComputedStyle(document.documentElement).getPropertyValue("--black").trim() || "black";
  let empty = true;
  let drawing = false;
  const reset = () => {
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--white").trim() || "white";
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    empty = true;
  };
  const point = (e) => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
  };
  canvas.addEventListener("pointerdown", (e) => {
    drawing = true;
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = point(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    e.preventDefault();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const [x, y] = point(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    empty = false;
    e.preventDefault();
  });
  const stop = () => { drawing = false; };
  canvas.addEventListener("pointerup", stop);
  canvas.addEventListener("pointercancel", stop);
  reset();
  const wrap = el("div", { class: "sigpad" },
    el("span", { class: "field-label" }, label),
    canvas,
    el("button", { class: "link-btn", type: "button", onclick: reset }, "Clear"));
  return { el: wrap, isEmpty: () => empty, png: () => (empty ? "" : canvas.toDataURL("image/png")), clear: reset };
}
