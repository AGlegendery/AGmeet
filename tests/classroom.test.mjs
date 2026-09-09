import { chromium } from "playwright";

const BASE = process.env.AGMEET_URL ?? "http://127.0.0.1:8080";
const ROOM = "classroom-test";
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

async function join(name) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`  [pageerror ${name}] ${e.message}`));
  await page.goto(`${BASE}/r/${ROOM}`);
  await page.waitForSelector(".lobby__card");
  await page.fill("#agmeet-name", name);
  await page.waitForTimeout(800);
  await page.click('button[type="submit"]');
  await page.waitForSelector(".app", { timeout: 10000 });
  return page;
}

/** Non-transparent pixels on the board canvas: proof ink actually arrived. */
const inkPixels = (page) =>
  page.evaluate(() => {
    const canvas = document.querySelector(".board__canvas");
    if (!canvas) return -1;
    const ctx = canvas.getContext("2d");
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 12) n += 1;
    return n;
  });

async function scribble(page, from, to) {
  const box = await page.locator(".board__canvas").boundingBox();
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  for (let i = 1; i <= 12; i += 1) {
    const t = i / 12;
    await page.mouse.move(
      box.x + box.width * (from[0] + (to[0] - from[0]) * t),
      box.y + box.height * (from[1] + (to[1] - from[1]) * t)
    );
  }
  await page.mouse.up();
  await page.waitForTimeout(250);
}

const host = await join("Ingrid Halvorsen");
const guest = await join("Rasheed Oyelaran");
await host.waitForTimeout(2000);

console.log("--- whiteboard: opening ---");
check("guest cannot open the board", await guest.isDisabled('.dock__btn[aria-label="Open the whiteboard"]'));
await host.click('.dock__btn[aria-label="Open the whiteboard"]');
await guest.waitForTimeout(900);
check("board appears for the host", await host.isVisible(".board__canvas"));
check("board appears for the guest too", await guest.isVisible(".board__canvas"));
check("tiles move to the filmstrip", await host.isVisible(".filmstrip .tile"));

console.log("\n--- whiteboard: drawing ---");
check("board starts empty", (await inkPixels(guest)) === 0);
await scribble(host, [0.25, 0.35], [0.75, 0.6]);
const hostInk = await inkPixels(host);
await guest.waitForTimeout(600);
const guestInk = await inkPixels(guest);
check("the host's stroke renders locally", hostInk > 500, `${hostInk} px`);
check("the stroke reaches the guest", guestInk > 500, `${guestInk} px`);

await scribble(guest, [0.3, 0.7], [0.7, 0.3]);
await host.waitForTimeout(600);
const hostAfterGuest = await inkPixels(host);
check("an unlocked board accepts the guest's ink too", hostAfterGuest > hostInk, `${hostInk} -> ${hostAfterGuest} px`);

console.log("\n--- whiteboard: locking ---");
await host.click('.board__toolbar button[aria-label="Lock the board"]');
await guest.waitForTimeout(600);
check("guest is told the board is locked", await guest.isVisible(".board__readonly"));
check("guest's pen controls are disabled", await guest.isDisabled('.board__swatch[aria-label="Ink 1"]'));
const beforeBlocked = await inkPixels(host);
await scribble(guest, [0.1, 0.1], [0.5, 0.2]);
await host.waitForTimeout(600);
check("a locked board refuses the guest's ink", (await inkPixels(host)) === beforeBlocked);

console.log("\n--- whiteboard: clearing ---");
await host.click('.board__toolbar button[aria-label="Clear the board for everyone"]');
await guest.waitForTimeout(700);
check("clear empties the host's board", (await inkPixels(host)) === 0);
check("clear empties the guest's board", (await inkPixels(guest)) === 0);

console.log("\n--- whiteboard: late joiner gets the history ---");
await host.click('.board__toolbar button[aria-label="Unlock the board"]');
await scribble(host, [0.2, 0.2], [0.8, 0.8]);
const latecomer = await join("Yuki Tashiro");
await latecomer.waitForTimeout(2000);
const lateInk = await inkPixels(latecomer);
check("a late joiner sees the existing drawing", lateInk > 500, `${lateInk} px`);
await latecomer.context().close();

await host.click('.dock__btn[aria-label="Close the whiteboard"]');
await guest.waitForTimeout(700);
check("closing the board returns the grid", await host.isVisible(".stage__grid > .tile"));

console.log("\n--- polls ---");
await host.click('button[role="tab"]:has-text("Polls")');
await guest.click('button[role="tab"]:has-text("Polls")');
await host.waitForTimeout(300);
check("guests cannot start a poll", !(await guest.isVisible('button:has-text("New poll")')));

await host.click('button:has-text("New poll")');
await host.fill('input[aria-label="Poll question"]', "Did the derivation make sense?");
await host.fill('input[aria-label="Option 1"]', "Yes, keep going");
await host.fill('input[aria-label="Option 2"]', "Go over it again");
await host.waitForTimeout(200);
await host.click('button[type="submit"]');
await guest.waitForTimeout(800);

check("the poll reaches the guest", (await guest.textContent(".poll__question")) === "Did the derivation make sense?");
const optionsBeforeVote = await guest.locator(".poll__option").count();
check("guest sees options, not results, before voting", optionsBeforeVote === 2, `${optionsBeforeVote} options`);
const hostResultsBefore = await host.locator(".poll__result").count();
check("author sees results without voting", hostResultsBefore === 2, `${hostResultsBefore} rows`);

await guest.click('.poll__option:has-text("Go over it again")');
await host.waitForTimeout(700);
const share = await host.textContent('.poll__result:has-text("Go over it again") .poll__share');
check("the vote is counted for everyone", share === "100%", share);
check("guest now sees results", (await guest.locator(".poll__result").count()) === 2);
check("guest's own choice is marked", await guest.isVisible(".poll__result.is-mine"));
const total = await host.textContent(".poll__meta .num");
check("total is reported", total === "1 vote", total);

await host.click('.poll__meta button:has-text("Close")');
await guest.waitForTimeout(700);
check("closing is reflected for the guest", (await guest.textContent(".poll .pill")) === "Closed");
check("close control disappears once closed", !(await host.isVisible('.poll__meta button:has-text("Close")')));

console.log("\n--- screenshots ---");
await host.click('.dock__btn[aria-label="Open the whiteboard"]');
await host.waitForTimeout(600);
await scribble(host, [0.22, 0.55], [0.45, 0.3]);
await scribble(host, [0.45, 0.3], [0.68, 0.62]);
await host.mouse.move(10, 10);
await host.waitForTimeout(300);
await host.screenshot({ path: `${process.env.OUT ?? "."}/board.png` });
await guest.click('button[role="tab"]:has-text("Polls")');
await guest.mouse.move(10, 10);
await guest.waitForTimeout(300);
await guest.screenshot({ path: `${process.env.OUT ?? "."}/polls.png` });

await browser.close();
console.log(`\n${fail.length === 0 ? "ALL CHECKS PASSED" : `${fail.length} FAILED: ${fail.join(", ")}`}`);
process.exit(fail.length === 0 ? 0 : 1);
