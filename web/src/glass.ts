/**
 * Liquid glass, gated on what the client can actually afford.
 *
 * The real effect (ybouane/liquidglass) rasterises the scene behind each
 * panel and runs a WebGL refraction shader over it every frame. On capable
 * hardware it is the difference between a blurred rectangle and something
 * that reads as a physical material. On a five-year-old laptop it is a way
 * to turn a video call into a slideshow.
 *
 * So the tier is decided before anything is downloaded:
 *
 *   full      WebGL liquid glass on the floating bars. ~26 KB fetched
 *             lazily, and only here.
 *   enhanced  CSS backdrop-filter, the default look. Nothing extra fetched.
 *   minimal   Near-opaque surfaces, no blur at all. For software renderers,
 *             low-memory devices, and anyone who asked for reduced motion.
 *
 * Nothing in here touches the server: the tier is a property of the browser
 * in front of it, and the whole decision is made and acted on client-side.
 */

import type { GlassTier } from "./types";

export type { GlassTier };

/** Frames per second below which the effect is judged not worth its cost. */
const FPS_FLOOR = 26;
/** Consecutive one-second samples under the floor before downgrading. */
const FPS_STRIKES = 4;
/** Grace period before the watchdog starts judging, in ms. */
const WARMUP_MS = 3500;

const OVERRIDE_KEY = "agmeet.glass";
const DEMOTED_KEY = "agmeet.glass.demoted";

/**
 * Matte tuning.
 *
 * The library's defaults are glossy — a clear lens with a strong Fresnel rim.
 * Matte is mostly subtraction: kill the specular hotspot and most of the
 * Fresnel (the two things that read as "polished"), drop the chromatic
 * fringing, and push the blur hard so the panel frosts what is behind it
 * instead of magnifying it. What is left is refraction at the bevel and a
 * soft rim, which is what a thick piece of sandblasted glass actually does.
 */
export const MATTE_GLASS = {
  blurAmount: 0.82,
  refraction: 0.34,
  chromAberration: 0.012,
  edgeHighlight: 0.16,
  specular: 0.0,
  fresnel: 0.26,
  distortion: 0.02,
  opacity: 1.0,
  saturation: -0.04,
  tintStrength: 0.12,
  brightness: -0.015,
  shadowOpacity: 0.42,
  shadowSpread: 26,
  shadowOffsetY: 8,
  bevelMode: 0,
} as const;

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------

interface Probe {
  tier: GlassTier;
  reason: string;
}

/**
 * Reads the WebGL renderer string. Software rasterisers (SwiftShader on a
 * machine with no usable GPU, llvmpipe on a bare Linux box) advertise
 * themselves here, and they are exactly the clients that must never run a
 * per-frame shader.
 */
function rendererProfile(): { webgl2: boolean; software: boolean; renderer: string } {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2");
  if (!gl) return { webgl2: false, software: true, renderer: "none" };

  let renderer = "";
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  if (info) {
    renderer = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? "");
  }
  // Release the context immediately; browsers cap how many may be live.
  gl.getExtension("WEBGL_lose_context")?.loseContext();

  const software = /swiftshader|llvmpipe|software|basic render|microsoft basic/i.test(renderer);
  return { webgl2: true, software, renderer: renderer || "unknown" };
}

function probe(): Probe {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) {
    return { tier: "minimal", reason: "the system asks for reduced motion" };
  }

  const { webgl2, software, renderer } = rendererProfile();
  if (!webgl2) return { tier: "minimal", reason: "no WebGL2" };
  if (software) return { tier: "minimal", reason: `software renderer (${renderer})` };

  // A display the browser knows it cannot repaint quickly.
  if (window.matchMedia("(update: slow)").matches) {
    return { tier: "minimal", reason: "slow display refresh" };
  }

  // deviceMemory is Chromium-only and rounded down to a power of two; absent
  // elsewhere, which is treated as "unknown", not "weak".
  const memory = (navigator as { deviceMemory?: number }).deviceMemory;
  if (typeof memory === "number" && memory <= 2) {
    return { tier: "minimal", reason: `${memory} GB of memory` };
  }
  if (typeof memory === "number" && memory <= 4) {
    return { tier: "enhanced", reason: `${memory} GB of memory` };
  }

  const cores = navigator.hardwareConcurrency;
  if (typeof cores === "number" && cores > 0 && cores < 4) {
    return { tier: "enhanced", reason: `${cores} CPU cores` };
  }

  // Phones and tablets: the panel is small, the GPU is shared with the video
  // decoder, and the battery cost is real. CSS glass there.
  if (window.matchMedia("(hover: none), (max-width: 900px)").matches) {
    return { tier: "enhanced", reason: "touch or small viewport" };
  }

  return { tier: "full", reason: `GPU: ${renderer}` };
}

/**
 * The tier for this session. An explicit choice in localStorage wins, and a
 * downgrade the watchdog decided earlier in this session is remembered so a
 * machine that has already failed is not asked to fail again on the next
 * room.
 */
export function detectTier(): { tier: GlassTier; reason: string } {
  const override = localStorage.getItem(OVERRIDE_KEY);
  if (override === "full" || override === "enhanced" || override === "minimal") {
    return { tier: override, reason: "set manually" };
  }

  const detected = probe();
  const demoted = sessionStorage.getItem(DEMOTED_KEY);
  if (demoted === "enhanced" || demoted === "minimal") {
    // Never climb back above a tier this machine already failed at.
    const rank: Record<GlassTier, number> = { minimal: 0, enhanced: 1, full: 2 };
    if (rank[demoted] < rank[detected.tier]) {
      return { tier: demoted, reason: "downgraded earlier in this session" };
    }
  }
  return detected;
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

/** The shape of the library we depend on, so the import stays type-checked. */
interface LiquidGlassInstance {
  fps: number;
  destroy(): void;
  markChanged(element?: HTMLElement): void;
}

interface Surface {
  root: HTMLElement;
  elements: HTMLElement[];
  config: Record<string, number | boolean>;
  instance: LiquidGlassInstance | null;
}

/**
 * Owns every WebGL glass surface in the app, plus the watchdog that takes
 * them all away at once if the machine cannot keep up.
 */
export class GlassSurfaces {
  private surfaces = new Map<string, Surface>();
  private tier: GlassTier;
  private watchdog: number | undefined;
  private strikes = 0;
  private startedAt = 0;
  /** Resolved once, then shared: the module is fetched at most one time. */
  private loader: Promise<typeof import("@ybouane/liquidglass") | null> | null = null;

  constructor(
    tier: GlassTier,
    private readonly onDowngrade: (tier: GlassTier, reason: string) => void
  ) {
    this.tier = tier;
  }

  get currentTier(): GlassTier {
    return this.tier;
  }

  /**
   * Fetches the library. Only ever called on the full tier, so a weak client
   * never pays the download, let alone the frames.
   */
  private load(): Promise<typeof import("@ybouane/liquidglass") | null> {
    if (!this.loader) {
      this.loader = import("@ybouane/liquidglass").catch((error) => {
        console.warn("AGmeet: liquid glass unavailable, staying on CSS glass", error);
        return null;
      });
    }
    return this.loader;
  }

  /**
   * Registers a surface and, on the full tier, starts rendering it.
   *
   * `root` must be the element whose children form the scene behind the
   * panels, and every entry of `elements` must be a direct child of it —
   * that is the library's contract, not a preference.
   */
  async attach(
    name: string,
    root: HTMLElement,
    elements: HTMLElement[],
    config: Record<string, number | boolean>
  ): Promise<void> {
    this.detach(name);
    const surface: Surface = { root, elements, config, instance: null };
    this.surfaces.set(name, surface);
    if (this.tier !== "full") return;
    await this.start(surface);
    this.arm();
  }

  private async start(surface: Surface): Promise<void> {
    const module = await this.load();
    if (!module) {
      // The import failed; fall back for the whole app rather than leaving
      // one surface looking different from the rest.
      this.downgrade("enhanced", "the effect could not be loaded");
      return;
    }
    // A surface can be detached while its module is in flight.
    if (!this.surfaces.has(surfaceName(this.surfaces, surface))) return;

    for (const element of surface.elements) {
      element.dataset.config = JSON.stringify({ ...MATTE_GLASS, ...surface.config });
    }
    try {
      surface.instance = (await module.LiquidGlass.init({
        root: surface.root,
        glassElements: surface.elements,
      })) as unknown as LiquidGlassInstance;
      surface.root.dataset.glassActive = "true";
    } catch (error) {
      console.warn("AGmeet: liquid glass failed to start", error);
      this.downgrade("enhanced", "the effect failed to start");
    }
  }

  detach(name: string): void {
    const surface = this.surfaces.get(name);
    if (!surface) return;
    surface.instance?.destroy();
    delete surface.root.dataset.glassActive;
    for (const element of surface.elements) delete element.dataset.config;
    this.surfaces.delete(name);
    if (this.surfaces.size === 0) this.disarm();
  }

  /** Tells the renderer that a panel's own content changed. */
  markChanged(name: string, element?: HTMLElement): void {
    this.surfaces.get(name)?.instance?.markChanged(element);
  }

  // --- Watchdog ----------------------------------------------------------

  private arm(): void {
    if (this.watchdog !== undefined) return;
    this.startedAt = performance.now();
    this.strikes = 0;
    this.watchdog = window.setInterval(() => this.sample(), 1000);
  }

  private disarm(): void {
    window.clearInterval(this.watchdog);
    this.watchdog = undefined;
  }

  /**
   * Judges the effect on measured frames, not on a guess made at boot.
   *
   * Capability flags describe hardware; they cannot know that this laptop is
   * also running a build, or that this room has twelve cameras in it. If the
   * frame rate is not there, the effect goes — and stays gone for the
   * session, because a machine that failed once will fail again.
   */
  private sample(): void {
    if (performance.now() - this.startedAt < WARMUP_MS) return;

    let worst = Infinity;
    for (const [, surface] of this.surfaces) {
      if (surface.instance) worst = Math.min(worst, surface.instance.fps);
    }
    // No instance has reported a measurement yet.
    if (!Number.isFinite(worst) || worst <= 0) return;

    if (worst >= FPS_FLOOR) {
      this.strikes = 0;
      return;
    }
    this.strikes += 1;
    if (this.strikes >= FPS_STRIKES) {
      this.downgrade("enhanced", `the effect was holding ${Math.round(worst)} fps`);
    }
  }

  private downgrade(tier: GlassTier, reason: string): void {
    if (this.tier === tier) return;
    this.tier = tier;
    sessionStorage.setItem(DEMOTED_KEY, tier);
    this.disarm();
    for (const [, surface] of this.surfaces) {
      surface.instance?.destroy();
      surface.instance = null;
      delete surface.root.dataset.glassActive;
      for (const element of surface.elements) delete element.dataset.config;
    }
    this.onDowngrade(tier, reason);
  }

  destroy(): void {
    this.disarm();
    for (const name of [...this.surfaces.keys()]) this.detach(name);
  }
}

/** Reverse lookup so `start` can tell whether its surface is still registered. */
function surfaceName(map: Map<string, Surface>, surface: Surface): string {
  for (const [name, candidate] of map) {
    if (candidate === surface) return name;
  }
  return "";
}
