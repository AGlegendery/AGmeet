/**
 * Accounts and roles: signing in, and what each role may actually do.
 */

import { BASE, launch, reporter } from "./helpers.mjs";

const ROOM = "accounts-room";
const { check, finish } = reporter();
const browser = await launch();

async function page(name) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await context.newPage();
  p.on("pageerror", (e) => console.log(`  [pageerror ${name}] ${e.message}`));
  return p;
}

console.log("--- the operator opens a sign-in room ---");
const host = await page("host");
await host.goto(BASE);
await host.waitForSelector(".dash");
await host.fill("#dash-name", "Golnar Shahbazi");
await host.fill("#dash-roomcode", ROOM);
await host.click('.segment:has-text("Sign in")');
await host.waitForTimeout(250);
check("choosing sign-in reveals the roster editor", await host.isVisible(".roster"));
const builtins = await host.$$eval(".roster__section:first-child .roster__row .roster__name", (n) =>
  n.map((x) => x.textContent.replace("built-in", "").trim())
);
check("the built-in roles are listed", builtins.join(",") === "Operator,Presenter,Attendee,Viewer", builtins.join(","));

// A custom role: camera but no microphone, exactly the case you described.
await host.click(".roster__new summary");
await host.waitForTimeout(150);
await host.fill('.roster__new input[aria-label="Role name"]', "Silent camera");
await host.click('.roster__caps label:has-text("Camera") .switch');
await host.click('.roster__caps label:has-text("Chat") .switch');
await host.click('.roster__new button:has-text("Add role")');
await host.waitForTimeout(250);
const afterAdd = await host.$$eval(".roster__section:first-child .roster__row .roster__name", (n) =>
  n.map((x) => x.textContent.replace("built-in", "").trim())
);
check("a custom role can be created", afterAdd.includes("Silent camera"), afterAdd.join(","));

async function addAccount(user, pass, role) {
  await host.fill('.roster input[aria-label="Username"]', user);
  await host.fill('.roster input[aria-label="Password"]', pass);
  await host.selectOption('.roster select[aria-label="Role"]', role);
  await host.click('.roster button:has-text("Add account")');
  await host.waitForTimeout(200);
}
await addAccount("mamad", "12345", "operator");
await addAccount("sara", "presenter-pw", "presenter");
await addAccount("navid", "viewer-pw", "viewer");
const accounts = await host.$$eval(".roster__section:last-child .roster__row .roster__name", (n) =>
  n.map((x) => x.textContent.trim())
);
check("accounts are listed", accounts.join(",") === "mamad,sara,navid", accounts.join(","));

await host.click('.dash__card:has-text("Start a room") button[type="submit"]');
await host.waitForSelector(".lobby__card");
await host.waitForTimeout(900);
await host.click('.lobby__form button[type="submit"]');
await host.waitForSelector(".app", { timeout: 10000 });
check("the creator enters their own room", await host.isVisible(".stage"));

console.log("\n--- signing in ---");
async function signIn(name, user, pass) {
  const p = await page(name);
  await p.goto(`${BASE}/r/${ROOM}`);
  await p.waitForSelector(".lobby__card");
  await p.waitForTimeout(900);
  return p;
}

const wrong = await signIn("wrong", "mamad", "nope");
check(
  "a sign-in room says so on its button",
  (await wrong.textContent('.lobby__form button[type="submit"]')).trim() === "Sign in and join"
);
check("username and password are asked for", await wrong.isVisible("#lobby-username"));
await wrong.fill("#lobby-username", "mamad");
await wrong.fill("#lobby-password", "wrong-one");
await wrong.click('.lobby__form button[type="submit"]');
await wrong.waitForTimeout(1000);
check("a bad password is refused", await wrong.isVisible("#lobby-password ~ .field__error"));
check("and does not get in", (await wrong.locator(".app").count()) === 0);
const message = await wrong.textContent("#lobby-password ~ .field__error");
check("without saying which half was wrong", !message.toLowerCase().includes("username does not"), message);
await wrong.context().close();

const mamad = await signIn("mamad", "mamad", "12345");
await mamad.fill("#lobby-username", "mamad");
await mamad.fill("#lobby-password", "12345");
await mamad.click('.lobby__form button[type="submit"]');
await mamad.waitForSelector(".app", { timeout: 10000 });
check("mamad signs in", await mamad.isVisible(".stage"));
await mamad.waitForTimeout(1500);

console.log("\n--- what an operator may do ---");
check("operator has a microphone", !(await mamad.isDisabled(".dock__btn:nth-child(1)")));
check("operator has a camera", !(await mamad.isDisabled(".dock__btn:nth-child(2)")));
check("operator can present", !(await mamad.isDisabled(".dock__btn:nth-child(3)")));
await mamad.click('.dock__btn[aria-label="More room actions"]');
await mamad.waitForTimeout(300);
const operatorMenu = await mamad.$$eval(".dock__menu .menu__item", (n) =>
  n.map((x) => x.textContent.trim().split("\n")[0])
);
check("operator can open the whiteboard", operatorMenu.some((i) => i.includes("whiteboard")), operatorMenu.join(" | "));
check("operator can start a poll", operatorMenu.some((i) => i.includes("poll")));
await mamad.keyboard.press("Escape");
check(
  "operator is named by their role in the list",
  (await mamad.evaluate(async () => {
    document.querySelector('button[role="tab"]:nth-child(2)').click();
    await new Promise((r) => setTimeout(r, 200));
    return [...document.querySelectorAll(".person__role")].map((n) => n.textContent).join(",");
  })).includes("Operator")
);

console.log("\n--- what a viewer may not do ---");
const navid = await signIn("navid", "navid", "viewer-pw");
await navid.fill("#lobby-username", "navid");
await navid.fill("#lobby-password", "viewer-pw");
await navid.click('.lobby__form button[type="submit"]');
await navid.waitForSelector(".app", { timeout: 10000 });
await navid.waitForTimeout(1500);
check("a viewer has no microphone", await navid.isDisabled(".dock__btn:nth-child(1)"));
check("a viewer has no camera", await navid.isDisabled(".dock__btn:nth-child(2)"));
check("a viewer cannot present", await navid.isDisabled(".dock__btn:nth-child(3)"));
check("a viewer cannot attach files", await navid.isDisabled('.composer [aria-label="Attach a file"]'));
check("a viewer can still type in chat", !(await navid.isDisabled(".composer textarea")));
await navid.click('.dock__btn[aria-label="More room actions"]');
await navid.waitForTimeout(300);
const viewerMenu = await navid.$$eval(".dock__menu .menu__item", (n) =>
  n.map((x) => x.textContent.trim().split("\n")[0])
);
check("a viewer gets no room controls", !viewerMenu.some((i) => i.includes("poll") || i.includes("whiteboard")), viewerMenu.join(" | "));

console.log("\n--- the server, not the button ---");
// Disabled controls are a courtesy. This bypasses the UI entirely: a socket
// signs in with the viewer's own credentials and then claims everything the
// role forbids. What the room sees afterwards is the real answer.
await navid.evaluate(([room, user, pass]) => {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const probe = new WebSocket(`${proto}//${location.host}/ws`);
  probe.addEventListener("open", () => {
    probe.send(JSON.stringify({
      t: "join",
      room,
      name: "navid on a second device",
      username: user,
      password: pass,
      media: { mic: true, cam: true, screen: true, hand: false, recording: false },
    }));
    probe.send(JSON.stringify({
      t: "media",
      mic: true, cam: true, screen: true, hand: false, recording: false,
    }));
    // "hello" — an attachment a viewer's role has no business sending.
    probe.send(JSON.stringify({
      t: "file",
      name: "sneaky.txt",
      mime: "text/plain",
      data: "aGVsbG8=",
    }));
  });
}, [ROOM, "navid", "viewer-pw"]);
await host.waitForTimeout(1200);
const viewerReadsMuted = await host.evaluate(() =>
  [...document.querySelectorAll(".person")].some(
    (p) => p.textContent.includes("second device") && p.querySelector(".person__media .is-off")
  )
);
check("a claimed microphone is stripped from a viewer", viewerReadsMuted);
check(
  "a viewer's upload is refused at the server, not just hidden",
  (await host.locator(".msg-file").count()) === 0
);

// The same path, from a role that may attach: the refusal is the capability,
// not the feature being missing.
await host.setInputFiles(".composer input[type=file]", {
  name: "handout.txt",
  mimeType: "text/plain",
  buffer: Buffer.from("for the class"),
});
await navid.waitForTimeout(900);
check("an operator's attachment does reach the room", (await navid.locator(".msg-file").count()) === 1);

console.log("\n--- deleting a role ---");
await host.click('.dock [aria-label="Room settings"]');
await host.waitForTimeout(250);
await host
  .locator(".popover__menu .menu__item", { hasText: "Roles and accounts" })
  .first()
  .click({ force: true });
await host.waitForTimeout(400);
check("a moderator can manage the roster in the room", await host.isVisible(".polldlg .roster"));
const deletable = await host.locator('.polldlg .roster__section:first-child button[aria-label^="Delete the"]').count();
check("built-ins are not deletable, the custom one is", deletable === 1, `${deletable} delete buttons`);
await host
  .locator('.polldlg .roster__section:first-child button[aria-label^="Delete the"]')
  .first()
  .click({ force: true });
await host.waitForTimeout(600);
const remaining = await host.$$eval(".polldlg .roster__section:first-child .roster__row .roster__name", (n) =>
  n.map((x) => x.textContent.replace("built-in", "").trim())
);
check("the custom role is gone", !remaining.includes("Silent camera"), remaining.join(","));

await browser.close();
process.exit(finish() === 0 ? 0 : 1);
