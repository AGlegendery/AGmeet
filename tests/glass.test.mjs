import { chromium } from "playwright";

const BASE = process.env.AGMEET_URL ?? "http://127.0.0.1:8080";
const ARGS = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
];

const fail = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail.push(name);
};

const browser = await chromium.launch({
  args: ARGS,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});

/** Opens a room, optionally forcing a tier before any app code runs. */
async function join(name, room, { force, reducedMotion } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ...(reducedMotion ? { reducedMotion: "reduce" } : {}),
  });
  const page = await context.newPage();
  const requested = [];
  page.on("request", (r) => requested.push(r.url()));
  page.on("pageerror", (e) => console.log(`  [pageerror ${name}] ${e.message}`));

  if (force) {
    await page.addInitScript((tier) => {
      localStorage.setItem("agmeet.glass", tier);
    }, force);
  }
  await page.goto(`${BASE}/r/${room}`);
  await page.waitForSelector(".lobby__card");
  await page.fill("#agmeet-name", name);
  await page.waitForTimeout(800);
  await page.click('button[type="submit"]');
  await page.waitForSelector(".app", { timeout: 10000 });
  return { page, requested };
}

/** The lazy WebGL chunk is the only bundle carrying shader source. */
const fetchedGlassChunk = (requested) =>
  requested.some((u) => /\/assets\/index-[A-Za-z0-9_-]+\.js$/.test(u) && !u.includes(entryName));

let entryName = "";
{
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(BASE);
  entryName = await page.evaluate(() =>
    ([...document.querySelectorAll("script[src]")].map((s) => s.getAttribute("src"))[0] ?? "").split("/").pop()
  );
  await context.close();
}
console.log(`entry bundle: ${entryName}\n`);

console.log("--- detection on this machine ---");
const auto = await join("Petra Nilsen", "glass-auto");
await auto.page.waitForTimeout(1500);
const autoTier = await auto.page.evaluate(() => document.documentElement.dataset.glass);
check("a tier is always resolved", ["full", "enhanced", "minimal"].includes(autoTier), autoTier);
console.log(`      headless Chromium here resolved to "${autoTier}"`);

if (autoTier !== "full") {
  check(
    "a non-full client never downloads the WebGL chunk",
    !fetchedGlassChunk(auto.requested),
    `${auto.requested.filter((u) => u.endsWith(".js")).length} js requests`
  );
  check("no shader canvas is injected", (await auto.page.locator(".dock canvas").count()) === 0);
}
await auto.page.context().close();

console.log("\n--- reduced motion ---");
const reduced = await join("Aurelio Bianchi", "glass-reduced", { reducedMotion: true });
await reduced.page.waitForTimeout(800);
const reducedTier = await reduced.page.evaluate(() => document.documentElement.dataset.glass);
check("reduced motion forces the minimal tier", reducedTier === "minimal", reducedTier);
const blur = await reduced.page.evaluate(
  () => getComputedStyle(document.querySelector(".sidebar")).backdropFilter
);
check("minimal tier drops backdrop blur entirely", blur === "none", blur);
const opaque = await reduced.page.evaluate(() => {
  const bg = getComputedStyle(document.querySelector(".sidebar")).backgroundColor;
  const m = bg.match(/[\d.]+/g).map(Number);
  return m.length < 4 || m[3] >= 0.99;
});
check("minimal tier surfaces are opaque so text stays legible", opaque);
check("minimal tier never fetches the WebGL chunk", !fetchedGlassChunk(reduced.requested));
await reduced.page.context().close();

console.log("\n--- forced full tier ---");
const full = await join("Mireille Garnier", "glass-full", { force: "full" });
await full.page.waitForTimeout(4000);
const fullTier = await full.page.evaluate(() => document.documentElement.dataset.glass);
console.log(`      tier after warm-up: "${fullTier}"`);
check("the WebGL chunk is fetched on the full tier", fetchedGlassChunk(full.requested));

if (fullTier === "full") {
  const canvasCount = await full.page.locator(".dock canvas").count();
  check("a shader canvas is injected into the dock", canvasCount === 1, `${canvasCount} canvases`);
  const dockSurface = await full.page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector(".dock"));
    return { bg: cs.backgroundImage, shadow: cs.boxShadow, filter: cs.backdropFilter };
  });
  check(
    "the dock's CSS surface steps aside for the shader",
    dockSurface.bg === "none" && dockSurface.filter === "none",
    JSON.stringify(dockSurface).slice(0, 90)
  );
  const painted = await full.page.evaluate(() => {
    const c = document.querySelector(".dock canvas");
    return c ? c.width > 0 && c.height > 0 : false;
  });
  check("the shader canvas is sized and live", painted);
  const fps = await full.page.evaluate(() => window.__agmeetFps ?? null);
  if (fps !== null) console.log(`      measured ${Math.round(fps)} fps`);
  await full.page.mouse.move(10, 10);
  await full.page.waitForTimeout(500);
  await full.page.screenshot({ path: `${process.env.OUT ?? "."}/glass-full.png` });
} else {
  console.log("      (the watchdog downgraded it — see the note in the run output)");
  check("a downgrade leaves a working CSS-glass dock", await full.page.isVisible(".dock"));
  await full.page.screenshot({ path: `${process.env.OUT ?? "."}/glass-downgraded.png` });
}

console.log("\n--- the lobby camera controls ---");
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem("agmeet.glass", "full"));
  await page.goto(BASE);
  await page.waitForSelector(".lobby__card");
  await page.waitForTimeout(3000);
  const canvases = await page.locator(".lobby__preview-controls canvas").count();
  check("glass is applied over the live camera preview", canvases === 1, `${canvases} canvases`);
  await page.mouse.move(10, 10);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${process.env.OUT ?? "."}/glass-lobby.png` });
  await context.close();
}

console.log("\n--- the downgrade is remembered ---");
const demoted = await full.page.evaluate(() => sessionStorage.getItem("agmeet.glass.demoted"));
console.log(`      sessionStorage demotion: ${demoted ?? "(none)"}`);
await full.page.context().close();

await browser.close();
console.log(`\n${fail.length === 0 ? "ALL CHECKS PASSED" : `${fail.length} FAILED: ${fail.join(", ")}`}`);
process.exit(fail.length === 0 ? 0 : 1);
