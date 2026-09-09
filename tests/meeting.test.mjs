import { chromium } from "playwright";

const BASE = process.env.AGMEET_URL ?? "http://127.0.0.1:8080";
const ROOM = "e2e-test-room";
const ARGS = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
];

// CI images often ship a pre-installed Chromium that does not match the
// revision this Playwright version would download. Point CHROMIUM_PATH at it
// rather than fetching a second copy.
const launch = {
  args: ARGS,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
};

const fail = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail.push(name);
};

const browser = await chromium.launch(launch);

async function joinAs(name, room) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`  [pageerror ${name}] ${e.message}`));
  await page.goto(`${BASE}/r/${room}`);
  await page.waitForSelector(".lobby__card");
  await page.fill("#agmeet-name", name);
  await page.waitForTimeout(900); // let the fake camera settle
  await page.click('button[type="submit"]');
  await page.waitForSelector(".app", { timeout: 10000 });
  return { context, page };
}

console.log("--- lobby ---");
const a = await joinAs("Mira Solberg", ROOM);
check("host reaches the meeting shell", await a.page.isVisible(".stage"));
check("dock is rendered", await a.page.isVisible(".dock"));
check(
  "alone-in-room state is shown",
  (await a.page.textContent(".state__title")) === "You are the only one here"
);

console.log("\n--- second participant ---");
const b = await joinAs("Toma Ferreiro", ROOM);
await a.page.waitForTimeout(2500);

const aCount = await a.page.textContent(".room-header__meta");
const bCount = await b.page.textContent(".room-header__meta");
check("host header counts 2", aCount.includes("2 participants"), aCount.trim());
check("guest header counts 2", bCount.includes("2 participants"), bCount.trim());

const aTiles = await a.page.locator(".tile").count();
check("host renders 2 tiles", aTiles === 2, `${aTiles} tiles`);

// WebRTC actually carrying video: a remote <video> with real dimensions.
const remoteVideoLive = await a.page.evaluate(() => {
  const videos = [...document.querySelectorAll(".tile:not(.tile--self) video")];
  return videos.some((v) => v.videoWidth > 0 && v.videoHeight > 0 && !v.paused);
});
check("peer-to-peer video is flowing", remoteVideoLive);

const selfVideoLive = await a.page.evaluate(() => {
  const v = document.querySelector(".tile--self video");
  return Boolean(v && !v.hidden && v.videoWidth > 0);
});
check("own camera preview is on the self tile", selfVideoLive);

// Tiles must sit inside the stage: a row hanging off the bottom hides the
// name labels behind the dock.
const fits = await a.page.evaluate(() => {
  const stage = document.querySelector(".stage").getBoundingClientRect();
  return [...document.querySelectorAll(".stage__grid > .tile")].every(
    (t) => {
      const r = t.getBoundingClientRect();
      return r.top >= stage.top - 1 && r.bottom <= stage.bottom + 1 &&
             r.left >= stage.left - 1 && r.right <= stage.right + 1;
    }
  );
});
check("every tile fits inside the stage", fits);

const dockClear = await a.page.evaluate(() => {
  const dock = document.querySelector(".dock").getBoundingClientRect();
  return [...document.querySelectorAll(".stage__grid > .tile")].every(
    (t) => t.getBoundingClientRect().bottom <= dock.top + 1
  );
});
check("no tile runs under the control dock", dockClear);

const connState = await a.page.getAttribute(".link-state", "data-state");
check("connection reports connected", connState === "connected", connState);

console.log("\n--- chat ---");
await a.page.fill(".composer textarea", "Slides are on the shared drive.");
await a.page.press(".composer textarea", "Enter");
await b.page.waitForTimeout(700);
const received = await b.page.textContent(".msg__body");
check("chat reaches the other peer", received === "Slides are on the shared drive.", received);

console.log("\n--- media state propagation ---");
await a.page.click('.dock__btn[aria-label="Mute microphone"]');
await b.page.waitForTimeout(600);
const mutedMarkVisible = await b.page.evaluate(() => {
  const tiles = [...document.querySelectorAll(".tile:not(.tile--self)")];
  return tiles.some((t) => {
    const mark = t.querySelector(".tile__muted");
    return mark && !mark.hidden;
  });
});
check("mute is mirrored on the other peer's tile", mutedMarkVisible);

console.log("\n--- participants panel ---");
await b.page.click('button[role="tab"]:has-text("People")');
await b.page.waitForTimeout(300);
const people = await b.page.locator(".person").count();
check("participant list shows both", people === 2, `${people} rows`);

console.log("\n--- adaptive grid ---");
// The optimum depends on the container's aspect, so assert the property the
// algorithm claims — no other column count yields bigger tiles — rather than
// a magic number.
const optimal = await a.page.evaluate(() => {
  const grid = document.querySelector(".stage__grid");
  const cs = getComputedStyle(grid);
  const w = grid.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const h = grid.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const n = grid.children.length;
  const size = (cols) => {
    const rows = Math.ceil(n / cols);
    const cw = (w - 12 * (cols - 1)) / cols;
    const ch = (h - 12 * (rows - 1)) / rows;
    return cw <= 0 || ch <= 0 ? 0 : Math.min(cw, (ch * 16) / 9);
  };
  const chosen = Number(cs.getPropertyValue("--cols").trim());
  let best = 1;
  for (let c = 1; c <= n; c += 1) if (size(c) > size(best)) best = c;
  return { chosen, best, chosenSize: Math.round(size(chosen)), bestSize: Math.round(size(best)) };
});
check(
  "grid picks the column count that maximises tile size",
  optimal.chosen === optimal.best,
  `chose ${optimal.chosen} (${optimal.chosenSize}px), best ${optimal.best} (${optimal.bestSize}px)`
);

await a.page.setViewportSize({ width: 420, height: 860 });
await a.page.waitForTimeout(500);
const mobileCols = await a.page.evaluate(() =>
  getComputedStyle(document.querySelector(".stage__grid")).getPropertyValue("--cols").trim()
);
const sidebarHidden = await a.page.evaluate(
  () => getComputedStyle(document.querySelector(".sidebar")).display === "none"
);
check("mobile stacks to 1 column", mobileCols === "1", `--cols: ${mobileCols}`);
check("mobile hides the sidebar", sidebarHidden);
const horizontalOverflow = await a.page.evaluate(
  () => document.documentElement.scrollWidth > document.documentElement.clientWidth
);
check("no horizontal overflow on mobile", !horizontalOverflow);
await a.page.setViewportSize({ width: 1440, height: 900 });
await a.page.waitForTimeout(400);

console.log("\n--- screenshots ---");
await a.page.screenshot({ path: `${process.env.OUT ?? "."}/stage-two.png` });
await b.page.click('button[role="tab"]:has-text("Chat")');
await b.page.waitForTimeout(300);
await b.page.screenshot({ path: `${process.env.OUT ?? "."}/stage-chat.png` });

// Third participant, to exercise the grid at an odd count.
const c = await joinAs("Devrim Akbulut", ROOM);
await a.page.waitForTimeout(2200);
const cols3 = await a.page.evaluate(() =>
  getComputedStyle(document.querySelector(".stage__grid")).getPropertyValue("--cols").trim()
);
check("3 participants lay out without a stranded row", cols3 === "2", `--cols: ${cols3}`);
await a.page.screenshot({ path: `${process.env.OUT ?? "."}/stage-three.png` });

// Lobby shot, from a clean context.
const lobby = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const lobbyPage = await lobby.newPage();
await lobbyPage.goto(BASE);
await lobbyPage.waitForSelector(".lobby__card");
await lobbyPage.waitForTimeout(1200);
await lobbyPage.screenshot({ path: `${process.env.OUT ?? "."}/lobby.png` });

console.log("\n--- leave ---");
await c.page.click('button[aria-label="Leave the meeting"]');
await c.page.click(".menu__item--danger");
await c.page.waitForTimeout(1200);
const farewell = await c.page.textContent(".state__title");
check("leaving lands on a designed state", farewell === "You left the meeting", farewell);
await a.page.waitForTimeout(800);
const backTo2 = await a.page.textContent(".room-header__meta");
check("room drops back to 2 participants", backTo2.includes("2 participants"), backTo2.trim());

await browser.close();
console.log(`\n${fail.length === 0 ? "ALL CHECKS PASSED" : `${fail.length} FAILED: ${fail.join(", ")}`}`);
process.exit(fail.length === 0 ? 0 : 1);
