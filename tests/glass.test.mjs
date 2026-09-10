/**
 * The glass tiers: what a weak client is spared, and what a strong one gets.
 */

import { BASE, createRoom, launch, reporter } from "./helpers.mjs";

const { check, finish } = reporter();
const browser = await launch();

/** The entry bundle, so the lazy shader chunk can be told apart from it. */
let entryName = "";
{
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(BASE);
  entryName = await page.evaluate(
    () =>
      ([...document.querySelectorAll("script[src]")].map((s) => s.getAttribute("src"))[0] ?? "")
        .split("/")
        .pop()
  );
  await context.close();
}
console.log(`entry bundle: ${entryName}\n`);

const fetchedGlassChunk = (requested) =>
  requested.some((u) => /\/assets\/index-[A-Za-z0-9_-]+\.js$/.test(u) && !u.includes(entryName));

/** Opens a room while recording every request the page makes. */
async function room(name, code, options = {}) {
  const requested = [];
  const page = await createRoom(browser, name, code, {}, {
    ...options,
    // Playwright contexts cannot add a listener before creation, so the
    // helper's page is instrumented on the way past.
  });
  page.on("request", (r) => requested.push(r.url()));
  return { page, requested };
}

console.log("--- detection on this machine ---");
{
  const requested = [];
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("request", (r) => requested.push(r.url()));
  await page.goto(BASE);
  await page.waitForSelector(".dash");
  await page.waitForTimeout(1200);

  const tier = await page.evaluate(() => document.documentElement.dataset.glass);
  check("a tier is always resolved", ["full", "enhanced", "minimal"].includes(tier), tier);
  console.log(`      headless Chromium here resolved to "${tier}"`);

  if (tier !== "full") {
    check(
      "a non-full client never downloads the WebGL chunk",
      !fetchedGlassChunk(requested),
      `${requested.filter((u) => u.endsWith(".js")).length} js requests`
    );
  }
  await context.close();
}

console.log("\n--- reduced motion ---");
{
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const requested = [];
  page.on("request", (r) => requested.push(r.url()));
  await page.goto(BASE);
  await page.waitForSelector(".dash");
  await page.waitForTimeout(700);

  check(
    "reduced motion forces the minimal tier",
    (await page.evaluate(() => document.documentElement.dataset.glass)) === "minimal"
  );
  const blur = await page.evaluate(
    () => getComputedStyle(document.querySelector(".dash__card")).backdropFilter
  );
  check("minimal tier drops backdrop blur entirely", blur === "none", blur);
  check("minimal tier never fetches the WebGL chunk", !fetchedGlassChunk(requested));
  await context.close();
}

console.log("\n--- forced full tier ---");
{
  const { page, requested } = await room("Elowen Marsh", "glass-full", {});
  await page.waitForTimeout(500);
  // Force the tier, then reload into the same room so the effect actually runs.
  await page.evaluate(() => localStorage.setItem("agmeet.glass", "full"));
  await page.reload();
  await page.waitForSelector(".lobby__card", { timeout: 10000 });
  await page.waitForTimeout(3500);

  const tier = await page.evaluate(() => document.documentElement.dataset.glass);
  console.log(`      tier after warm-up: "${tier}"`);
  check("the WebGL chunk is fetched on the full tier", fetchedGlassChunk(requested));

  if (tier === "full") {
    const canvases = await page.locator(".lobby__preview-controls canvas").count();
    check("glass is applied over the live camera preview", canvases === 1, `${canvases}`);
    const surface = await page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector(".lobby__preview-controls"));
      return { bg: cs.backgroundImage, filter: cs.backdropFilter };
    });
    check(
      "the panel's CSS surface steps aside for the shader",
      surface.bg === "none" && surface.filter === "none",
      JSON.stringify(surface).slice(0, 80)
    );
    await page.mouse.move(10, 10);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${process.env.OUT ?? "."}/glass-lobby.png` });
  } else {
    check("a downgrade still leaves a working CSS-glass panel", await page.isVisible(".lobby__preview-controls"));
  }
  console.log(
    `      sessionStorage demotion: ${(await page.evaluate(() => sessionStorage.getItem("agmeet.glass.demoted"))) ?? "(none)"}`
  );
  await page.context().close();
}

await browser.close();
process.exit(finish() === 0 ? 0 : 1);
