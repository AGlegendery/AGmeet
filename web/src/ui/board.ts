/**
 * Shared whiteboard.
 *
 * A dark board with light ink, so it belongs to the same surface as the rest
 * of the product rather than punching a white hole in it.
 *
 * Every point is normalised to 0..1 against the board's own box before it is
 * sent. A stroke drawn on a phone therefore lands in the same place on a
 * projector, and resizing the window reflows the drawing instead of cropping
 * it. Nothing on the wire is in pixels.
 */

import { el } from "../dom";
import { icons } from "../icons";
import type { Stroke } from "../types";

/** Light inks, legible on the dark board. Indices are part of the protocol. */
export const PALETTE = [
  "#f2f4ff",
  "#9b8dff",
  "#4cc9f0",
  "#3ddc97",
  "#ffd37a",
  "#ff8fa8",
  "#ffa45c",
  "#b8c0d9",
] as const;

/** Pen widths as a fraction of the board's diagonal, so they scale with it. */
const WIDTHS = [0.0022, 0.0042, 0.0082, 0.016] as const;

/** Points are batched into one frame per animation tick rather than one
 *  message per pointer event, which would flood the socket on a fast mouse. */
const MIN_POINT_DISTANCE = 0.0025;

export interface BoardHandlers {
  onDraw: (id: string, color: number, width: number, erase: boolean, points: [number, number][]) => void;
  onUndo: (id: string) => void;
  onClear: () => void;
  onLock: (locked: boolean) => void;
  onClose: () => void;
}

export interface BoardHandles {
  root: HTMLElement;
  setStrokes: (strokes: Stroke[]) => void;
  applyDraw: (id: string, color: number, width: number, erase: boolean, points: [number, number][]) => void;
  applyUndo: (id: string) => void;
  clear: () => void;
  setLocked: (locked: boolean) => void;
  setCanModerate: (can: boolean) => void;
  resize: () => void;
  destroy: () => void;
}

export function buildBoard(handlers: BoardHandlers): BoardHandles {
  const canvas = el("canvas", { class: "board__canvas" }) as HTMLCanvasElement;
  const context = canvas.getContext("2d");

  const strokes = new Map<string, Stroke>();
  const order: string[] = [];
  /** Strokes this client drew, newest last, for undo. */
  const mine: string[] = [];

  let color = 0;
  let width = 1;
  let erasing = false;
  let locked = false;
  let canModerate = false;

  let active: { id: string; last: [number, number] } | null = null;
  let pending: [number, number][] = [];
  let flushHandle = 0;

  // --- Painting ----------------------------------------------------------

  function scale(): { w: number; h: number; diagonal: number } {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    return { w, h, diagonal: Math.hypot(w, h) };
  }

  function applyPen(stroke: Stroke): void {
    if (!context) return;
    const { diagonal } = scale();
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = Math.max(1, (WIDTHS[stroke.width] ?? WIDTHS[1]) * diagonal);
    if (stroke.erase) {
      // Real erasing, not painting the background colour: the board is
      // translucent over the stage, so a background-coloured stroke would
      // show as a smear.
      context.globalCompositeOperation = "destination-out";
      context.strokeStyle = "rgba(0,0,0,1)";
      context.lineWidth *= 2.4;
    } else {
      context.globalCompositeOperation = "source-over";
      context.strokeStyle = PALETTE[stroke.color] ?? PALETTE[0];
    }
  }

  /**
   * Draws a run of points as a smooth path.
   *
   * Segments are quadratic curves through the midpoints of consecutive
   * samples, which removes the faceted look of a raw polyline without
   * needing to hold the whole stroke in memory to fit a spline.
   */
  function paint(stroke: Stroke, from: number): void {
    if (!context) return;
    const points = stroke.points;
    if (points.length === 0) return;
    const { w, h } = scale();
    applyPen(stroke);

    if (points.length === 1) {
      // A tap still leaves a mark.
      const [x, y] = points[0];
      context.beginPath();
      context.arc(x * w, y * h, context.lineWidth / 2, 0, Math.PI * 2);
      context.fillStyle = context.strokeStyle as string;
      context.fill();
      return;
    }

    const start = Math.max(1, from);
    context.beginPath();
    const prev = points[start - 1];
    context.moveTo(prev[0] * w, prev[1] * h);
    for (let i = start; i < points.length; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      const midX = ((a[0] + b[0]) / 2) * w;
      const midY = ((a[1] + b[1]) / 2) * h;
      context.quadraticCurveTo(a[0] * w, a[1] * h, midX, midY);
    }
    const last = points[points.length - 1];
    context.lineTo(last[0] * w, last[1] * h);
    context.stroke();
  }

  function redraw(): void {
    if (!context) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, w, h);
    for (const id of order) {
      const stroke = strokes.get(id);
      if (stroke) paint(stroke, 1);
    }
  }

  // --- Input -------------------------------------------------------------

  function normalised(event: PointerEvent): [number, number] {
    const rect = canvas.getBoundingClientRect();
    return [(event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height];
  }

  function flush(): void {
    flushHandle = 0;
    if (!active || pending.length === 0) return;
    const points = pending;
    pending = [];
    handlers.onDraw(active.id, color, width, erasing, points);
  }

  function scheduleFlush(): void {
    if (flushHandle === 0) flushHandle = requestAnimationFrame(flush);
  }

  function canDraw(): boolean {
    return !locked || canModerate;
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (!canDraw() || event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    const point = normalised(event);
    const id = crypto.randomUUID();
    const stroke: Stroke = { id, color, width, erase: erasing, points: [point] };
    strokes.set(id, stroke);
    order.push(id);
    mine.push(id);
    active = { id, last: point };
    pending = [point];
    paint(stroke, 0);
    scheduleFlush();
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!active) return;
    const stroke = strokes.get(active.id);
    if (!stroke) return;

    // Coalesced events give the full pointer path on a high-rate device
    // rather than one sample per frame, so fast strokes stay smooth.
    const events = event.getCoalescedEvents?.() ?? [event];
    for (const sample of events) {
      const point = normalised(sample);
      const [lx, ly] = active.last;
      if (Math.hypot(point[0] - lx, point[1] - ly) < MIN_POINT_DISTANCE) continue;
      const from = stroke.points.length;
      stroke.points.push(point);
      pending.push(point);
      active.last = point;
      paint(stroke, from);
    }
    scheduleFlush();
  });

  function finish(): void {
    if (!active) return;
    flush();
    if (flushHandle !== 0) {
      cancelAnimationFrame(flushHandle);
      flushHandle = 0;
    }
    active = null;
  }

  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", finish);
  canvas.addEventListener("pointerleave", finish);

  // --- Toolbar -----------------------------------------------------------

  const swatches = PALETTE.map((hex, index) =>
    el("button", {
      class: `board__swatch${index === 0 ? " is-active" : ""}`,
      type: "button",
      style: `--ink:${hex}`,
      "aria-label": `Ink ${index + 1}`,
      "aria-pressed": String(index === 0),
    })
  );
  swatches.forEach((swatch, index) => {
    swatch.addEventListener("click", () => {
      color = index;
      erasing = false;
      paintToolbar();
    });
  });

  const sizes = WIDTHS.map((_, index) =>
    el("button", {
      class: "board__size",
      type: "button",
      "aria-label": `Pen size ${index + 1}`,
      "aria-pressed": String(index === width),
      html: `<span style="width:${4 + index * 4}px;height:${4 + index * 4}px"></span>`,
    })
  );
  sizes.forEach((button, index) => {
    button.addEventListener("click", () => {
      width = index;
      erasing = false;
      paintToolbar();
    });
  });

  const eraser = el("button", {
    class: "icon-btn tip",
    type: "button",
    "data-tip": "Eraser",
    "aria-label": "Eraser",
    "aria-pressed": "false",
    html: icons.eraser,
  }) as HTMLButtonElement;
  eraser.addEventListener("click", () => {
    erasing = !erasing;
    paintToolbar();
  });

  const undo = el("button", {
    class: "icon-btn tip",
    type: "button",
    "data-tip": "Undo your last stroke",
    "aria-label": "Undo your last stroke",
    html: icons.undo,
  }) as HTMLButtonElement;
  undo.addEventListener("click", () => {
    const id = mine.pop();
    if (!id) return;
    applyUndo(id);
    handlers.onUndo(id);
  });

  const lock = el("button", {
    class: "icon-btn tip",
    type: "button",
    "data-tip": "Lock the board",
    "aria-label": "Lock the board",
    "aria-pressed": "false",
    html: icons.lock,
  }) as HTMLButtonElement;
  lock.addEventListener("click", () => handlers.onLock(!locked));

  const clear = el("button", {
    class: "icon-btn tip",
    type: "button",
    "data-tip": "Clear the board",
    "aria-label": "Clear the board for everyone",
    html: icons.trash,
  }) as HTMLButtonElement;
  clear.addEventListener("click", () => handlers.onClear());

  const close = el("button", {
    class: "icon-btn tip tip--end",
    type: "button",
    "data-tip": "Close the board",
    "aria-label": "Close the board",
    html: icons.close,
  }) as HTMLButtonElement;
  close.addEventListener("click", () => handlers.onClose());

  const moderatorTools = el("span", { class: "board__moderator", hidden: true }, [
    el("span", { class: "board__divider", "aria-hidden": "true" }),
    lock,
    clear,
    close,
  ]);

  const readOnly = el("span", { class: "board__readonly", hidden: true }, [
    el("span", { html: icons.lock, style: "width:14px;height:14px" }),
    el("span", { text: "The host has locked the board" }),
  ]);

  const toolbar = el("div", { class: "board__toolbar glass-4", role: "toolbar", "aria-label": "Whiteboard tools" }, [
    ...swatches,
    el("span", { class: "board__divider", "aria-hidden": "true" }),
    ...sizes,
    el("span", { class: "board__divider", "aria-hidden": "true" }),
    eraser,
    undo,
    moderatorTools,
  ]);

  function paintToolbar(): void {
    swatches.forEach((swatch, index) => {
      const on = index === color && !erasing;
      swatch.classList.toggle("is-active", on);
      swatch.setAttribute("aria-pressed", String(on));
    });
    sizes.forEach((button, index) =>
      button.setAttribute("aria-pressed", String(index === width))
    );
    eraser.setAttribute("aria-pressed", String(erasing));
    eraser.classList.toggle("is-active", erasing);
    lock.setAttribute("aria-pressed", String(locked));
    lock.setAttribute("data-tip", locked ? "Unlock the board" : "Lock the board");
    lock.setAttribute("aria-label", locked ? "Unlock the board" : "Lock the board");

    const drawable = canDraw();
    toolbar.classList.toggle("is-readonly", !drawable);
    readOnly.hidden = drawable;
    canvas.classList.toggle("is-readonly", !drawable);
    for (const control of [...swatches, ...sizes, eraser, undo]) {
      (control as HTMLButtonElement).disabled = !drawable;
    }
  }

  const root = el("div", { class: "board", "aria-label": "Shared whiteboard" }, [
    canvas,
    toolbar,
    readOnly,
  ]);

  const observer = new ResizeObserver(() => redraw());
  observer.observe(canvas);

  // --- Remote application -------------------------------------------------

  function applyDraw(
    id: string,
    inkColor: number,
    inkWidth: number,
    erase: boolean,
    points: [number, number][]
  ): void {
    let stroke = strokes.get(id);
    if (!stroke) {
      stroke = { id, color: inkColor, width: inkWidth, erase, points: [] };
      strokes.set(id, stroke);
      order.push(id);
    }
    const from = stroke.points.length;
    stroke.points.push(...points);
    paint(stroke, from === 0 ? 0 : from);
  }

  function applyUndo(id: string): void {
    if (!strokes.delete(id)) return;
    const index = order.indexOf(id);
    if (index !== -1) order.splice(index, 1);
    // Removing ink from the middle of the stack means repainting the rest.
    redraw();
  }

  paintToolbar();

  return {
    root,
    setStrokes(list) {
      strokes.clear();
      order.length = 0;
      mine.length = 0;
      for (const stroke of list) {
        strokes.set(stroke.id, { ...stroke, points: [...stroke.points] });
        order.push(stroke.id);
      }
      redraw();
    },
    applyDraw,
    applyUndo,
    clear() {
      strokes.clear();
      order.length = 0;
      mine.length = 0;
      redraw();
    },
    setLocked(value) {
      locked = value;
      paintToolbar();
    },
    setCanModerate(can) {
      canModerate = can;
      moderatorTools.hidden = !can;
      paintToolbar();
    },
    resize: redraw,
    destroy() {
      observer.disconnect();
      if (flushHandle !== 0) cancelAnimationFrame(flushHandle);
    },
  };
}
