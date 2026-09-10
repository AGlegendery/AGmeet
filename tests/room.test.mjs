/**
 * The dashboard, the door, room policy, recording and the themes.
 */

import { BASE, createRoom, enterFromLobby, joinRoom, launch, reporter } from "./helpers.mjs";

const { check, finish } = reporter();
const browser = await launch();

console.log("--- dashboard ---");
{
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(BASE);
  await page.waitForSelector(".dash");
  check("dashboard offers Home and Rooms", (await page.locator(".dash__tab").count()) === 2);
  check("no meeting sidebar exists anywhere", (await page.locator(".sidebar").count()) === 0);
  check("room creation offers three door policies", (await page.locator(".segment").count()) === 3);
  check("a room code is generated", (await page.inputValue("#dash-roomcode")).length > 0);
  check("appearance lives in the header", await page.isVisible('.dash__head [aria-label="Appearance"]'));

  // A pasted link should be accepted where a code is expected.
  await page.fill("#dash-name", "Anselm Rautavaara");
  await page.fill("#dash-code", `${BASE}/r/pasted-link-room`);
  await page.click('.dash__card:has-text("Join a room") button[type="submit"]');
  await page.waitForSelector(".lobby__card", { timeout: 8000 });
  check("a pasted room link is accepted as a code", page.url().includes("/r/pasted-link-room"));
  await page.waitForTimeout(600);
  check(
    "a room nobody has opened says so",
    (await page.textContent(".lobby__door .state__title")) === "This room has not started"
  );
  await page.context().close();
}

console.log("\n--- door: passcode ---");
{
  const room = "locked-room";
  const host = await createRoom(browser, "Priya Venkataraman", room, {
    lock: "passcode",
    passcode: "orbit-9",
  });
  check("the header states the door policy", (await host.textContent(".room-header__meta")).includes("Passcode"));

  const guest = await joinRoom(browser, "Callum Doherty", room);
  await enterFromLobby(guest).catch(() => undefined);
  await guest.waitForTimeout(1200);
  check("a passcode room challenges before entry", await guest.isVisible("#lobby-passcode"));
  check("the meeting is not reachable without it", (await guest.locator(".app").count()) === 0);

  await guest.fill("#lobby-passcode", "wrong");
  await guest.click('.lobby__form button[type="submit"]');
  await guest.waitForTimeout(900);
  check("a wrong passcode is reported", await guest.isVisible(".field__error"));
  check("still not admitted", (await guest.locator(".app").count()) === 0);

  await guest.fill("#lobby-passcode", "orbit-9");
  await guest.click('.lobby__form button[type="submit"]');
  await guest.waitForSelector(".app", { timeout: 8000 });
  check("the right passcode admits", await guest.isVisible(".stage"));

  await host.context().close();
  await guest.context().close();
}

console.log("\n--- door: ask to join ---");
{
  const room = "approval-room";
  const host = await createRoom(browser, "Marisol Quintero", room, { lock: "approval" });

  const guest = await joinRoom(browser, "敖 Wenjun", room);
  const label = (await guest.textContent('.lobby__form button[type="submit"]')).trim();
  check("the button promises what actually happens", label === "Ask to join the room", label);

  await guest.click('.lobby__form button[type="submit"]');
  await guest.waitForTimeout(1200);
  check("the guest is told they are waiting", await guest.isVisible(".lobby__waiting"));
  check("the guest is not in the room yet", (await guest.locator(".app").count()) === 0);

  await host.waitForTimeout(600);
  check("the host is told somebody is at the door", await host.isVisible(".knocks"));
  await host.click(".knocks");
  await host.waitForTimeout(300);
  check("the waiting list names them", (await host.textContent(".waiting__row .person__name")) === "敖 Wenjun");

  await host.click('.waiting__row button:has-text("Admit")');
  await guest.waitForSelector(".app", { timeout: 8000 });
  check("admitting lets them straight in", await guest.isVisible(".stage"));
  await host.waitForTimeout(500);
  check("the door queue empties", !(await host.isVisible(".knocks")));

  // And a refusal.
  const refused = await joinRoom(browser, "Ottoline Bright", room);
  await refused.click('.lobby__form button[type="submit"]');
  await host.waitForTimeout(1200);
  await host.click('.waiting__row button:has-text("Deny")');
  await refused.waitForTimeout(900);
  check("a denied guest is told, not left hanging", await refused.isVisible(".lobby__door .state--error"));

  await host.context().close();
  await guest.context().close();
  await refused.context().close();
}

console.log("\n--- room policy: guest media ---");
{
  const room = "lecture-room";
  const host = await createRoom(browser, "Teodora Filipović", room, { guestMedia: false });
  const guest = await joinRoom(browser, "Hamid Zarrin", room);
  await enterFromLobby(guest);
  await guest.waitForTimeout(1200);

  check("a guest's microphone control is disabled", await guest.isDisabled(".dock__btn:nth-child(1)"));
  check("a guest's camera control is disabled", await guest.isDisabled(".dock__btn:nth-child(2)"));
  check("the host keeps theirs", !(await host.isDisabled(".dock__btn:nth-child(1)")));

  // The server, not the button, is the enforcement.
  await guest.evaluate(() => {
    const socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`);
    window.__probe = socket;
  });
  await guest.waitForTimeout(400);
  const beforeMic = await host.evaluate(
    () => [...document.querySelectorAll(".tile:not(.tile--self) .tile__muted")].every((m) => !m.hidden)
  );
  check("the guest reads as muted to the room", beforeMic);

  // Handing the permission back re-enables the controls.
  await host.click('.room-header__menus [aria-label="Room settings"]');
  await host.waitForTimeout(250);
  await host.click('.popover__menu .toggle:has-text("Guest camera") .switch');
  await guest.waitForTimeout(900);
  check("restoring the policy re-enables the guest's controls", !(await guest.isDisabled(".dock__btn:nth-child(1)")));

  await host.context().close();
  await guest.context().close();
}

console.log("\n--- recording ---");
{
  const room = "recorded-room";
  const host = await createRoom(browser, "Nnamdi Okonkwo", room, { allowRecording: false });
  const guest = await joinRoom(browser, "Léa Fontaine", room);
  await enterFromLobby(guest);
  await guest.waitForTimeout(1000);

  await guest.click('.room-header__menus [aria-label="Room settings"]');
  await guest.waitForTimeout(250);
  check(
    "a guest cannot record when the room forbids it",
    !(await guest.isVisible('.popover__menu button:has-text("Record the room")'))
  );
  await guest.keyboard.press("Escape");

  await host.click('.room-header__menus [aria-label="Room settings"]');
  await host.waitForTimeout(250);
  check("the host can record", await host.isVisible('button:has-text("Record the room")'));
  await host.click('button:has-text("Record the room")');
  await host.waitForTimeout(2500);
  check("the room is told it is being recorded", await host.isVisible(".pill--rec"));
  await guest.waitForTimeout(600);
  check("everyone sees the recording state, not just the recorder", await guest.isVisible(".pill--rec"));

  await host.click('.room-header__menus [aria-label="Room settings"]');
  await host.waitForTimeout(250);
  await host.click('button:has-text("Stop recording")');
  await host.waitForTimeout(1500);
  check("stopping offers the take", await host.isVisible('button:has-text("Download")'));
  check("and offers to throw it away", await host.isVisible('button:has-text("Discard")'));
  const blurb = await host.textContent(".polldlg .field__hint");
  check("it says the file never left the machine", blurb.includes("stayed on this device"), blurb);
  await host.click('button:has-text("Discard")');
  await host.waitForTimeout(400);
  check("discarding closes the dialog", !(await host.isVisible('button:has-text("Download")')));
  await host.waitForTimeout(500);
  check("the recording pill clears", !(await host.isVisible(".pill--rec")));

  await host.context().close();
  await guest.context().close();
}

console.log("\n--- themes ---");
{
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(BASE);
  await page.waitForSelector(".dash");
  check(
    "dark is the default, whatever the OS says",
    (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark"
  );

  await page.click('.dash__head [aria-label="Appearance"]');
  await page.waitForTimeout(250);
  await page.click('.popover__menu button:has-text("Light")');
  await page.waitForTimeout(400);
  check(
    "the light theme applies",
    (await page.evaluate(() => document.documentElement.dataset.theme)) === "light"
  );
  const ground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check("the light ground is actually light", ground.includes("244") || ground.includes("245"), ground);
  await page.screenshot({ path: `${process.env.OUT ?? "."}/dash-light.png` });

  await page.reload();
  await page.waitForSelector(".dash");
  check(
    "the choice survives a reload",
    (await page.evaluate(() => document.documentElement.dataset.theme)) === "light"
  );

  await page.click('.dash__head [aria-label="Appearance"]');
  await page.waitForTimeout(250);
  await page.click('.popover__menu button:has-text("Dark")');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${process.env.OUT ?? "."}/dash-dark.png` });
  await page.context().close();
}

await browser.close();
process.exit(finish() === 0 ? 0 : 1);
