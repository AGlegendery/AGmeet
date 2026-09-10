/**
 * Shared browser-test helpers.
 *
 * The product now has three views — dashboard, lobby, meeting — so every test
 * that needs somebody in a room walks the same path a person would.
 */

import { chromium } from "playwright";

export const BASE = process.env.AGMEET_URL ?? "http://127.0.0.1:8080";

const ARGS = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
];

/** CI images often ship a Chromium that predates this Playwright version. */
export function launch(extra = {}) {
  return chromium.launch({
    args: ARGS,
    // A real machine has a UTF-8 locale; a bare container often does not, and
    // Chromium then throws away any non-ASCII download filename ("تمرین.pdf"
    // saves as "download"). Without this the attachment test measures the
    // container rather than the product.
    env: { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    ...extra,
  });
}

export function reporter() {
  const failures = [];
  const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures.push(name);
  };
  return {
    check,
    finish() {
      console.log(
        `\n${failures.length === 0 ? "ALL CHECKS PASSED" : `${failures.length} FAILED: ${failures.join(", ")}`}`
      );
      return failures.length;
    },
  };
}

async function newPage(browser, label, options = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ...options,
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`  [pageerror ${label}] ${e.message}`));
  return page;
}

/** Opens a room from the dashboard, with whatever policy the test wants. */
export async function createRoom(browser, name, room, settings = {}, options = {}) {
  const page = await newPage(browser, name, options);
  await page.goto(BASE);
  await page.waitForSelector(".dash");
  await page.fill("#dash-name", name);
  await page.fill("#dash-roomname", settings.roomName ?? room);
  await page.fill("#dash-roomcode", room);

  if (settings.lock === "passcode") {
    await page.click('.segment:has-text("Passcode")');
    await page.fill("#opt-passcode", settings.passcode ?? "hunter2");
  } else if (settings.lock === "approval") {
    await page.click('.segment:has-text("Ask to join")');
  }

  const setSwitch = async (id, wanted) => {
    if (wanted === undefined) return;
    const on = await page.isChecked(id);
    if (on !== wanted) await page.click(`label[for="${id.slice(1)}"] .switch`);
  };
  await setSwitch("#opt-classroom", settings.classroom);
  await setSwitch("#opt-whiteboard", settings.whiteboard);
  await setSwitch("#opt-guestmedia", settings.guestMedia);
  await setSwitch("#opt-recording", settings.allowRecording);

  await page.click('.dash__card:has-text("Start a room") button[type="submit"]');
  await page.waitForSelector(".lobby__card");
  await page.waitForTimeout(900);
  await page.click('.lobby__form button[type="submit"]');
  await page.waitForSelector(".app", { timeout: 10000 });
  return page;
}

/**
 * Walks somebody in through the dashboard. Returns the lobby page without
 * entering when the door is going to stop them, so the caller can assert on
 * the challenge.
 */
export async function joinRoom(browser, name, room, options = {}) {
  const page = await newPage(browser, name, options);
  await page.goto(BASE);
  await page.waitForSelector(".dash");
  await page.fill("#dash-name", name);
  await page.fill("#dash-code", room);
  await page.click('.dash__card:has-text("Join a room") button[type="submit"]');
  await page.waitForSelector(".lobby__card");
  await page.waitForTimeout(900);
  return page;
}

/** Clicks through the lobby and waits for the meeting. */
export async function enterFromLobby(page) {
  await page.click('.lobby__form button[type="submit"]');
  await page.waitForSelector(".app", { timeout: 10000 });
  return page;
}

/** The full walk, for tests that do not care about the door. */
export async function joinAndEnter(browser, name, room, options = {}) {
  const page = await joinRoom(browser, name, room, options);
  return enterFromLobby(page);
}
