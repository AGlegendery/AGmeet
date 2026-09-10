import { createRoom, joinAndEnter, launch, reporter } from "./helpers.mjs";

const ROOM = "classroom-test";
const { check, finish } = reporter();
const browser = await launch();

/** Non-transparent pixels on the board canvas: proof ink actually arrived. */
const inkPixels = (page) =>
  page.evaluate(() => {
    const canvas = document.querySelector(".board__canvas");
    if (!canvas) return -1;
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
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

const host = await createRoom(browser, "Ingrid Halvorsen", ROOM);
const guest = await joinAndEnter(browser, "Rasheed Oyelaran", ROOM);
await host.waitForTimeout(2000);

console.log("--- whiteboard ---");
check(
  "guest cannot open the board",
  await guest.isDisabled('.dock__btn[aria-label="Open the whiteboard"]')
);
await host.click('.dock__btn[aria-label="Open the whiteboard"]');
await guest.waitForTimeout(900);
check("board appears for the host", await host.isVisible(".board__canvas"));
check("board appears for the guest too", await guest.isVisible(".board__canvas"));
check("tiles move to the filmstrip", await host.isVisible(".filmstrip .tile"));

check("board starts empty", (await inkPixels(guest)) === 0);
await scribble(host, [0.25, 0.35], [0.75, 0.6]);
const hostInk = await inkPixels(host);
await guest.waitForTimeout(600);
check("the host's stroke renders locally", hostInk > 500, `${hostInk} px`);
check("the stroke reaches the guest", (await inkPixels(guest)) > 500);

await scribble(guest, [0.3, 0.7], [0.7, 0.3]);
await host.waitForTimeout(600);
check("an unlocked board accepts the guest's ink too", (await inkPixels(host)) > hostInk);

await host.click('.board__toolbar button[aria-label="Lock the board"]');
await guest.waitForTimeout(600);
check("guest is told the board is locked", await guest.isVisible(".board__readonly"));
const beforeBlocked = await inkPixels(host);
await scribble(guest, [0.1, 0.1], [0.5, 0.2]);
await host.waitForTimeout(600);
check("a locked board refuses the guest's ink", (await inkPixels(host)) === beforeBlocked);

await host.click('.board__toolbar button[aria-label="Clear the board for everyone"]');
await guest.waitForTimeout(700);
check("clear empties both boards", (await inkPixels(host)) === 0 && (await inkPixels(guest)) === 0);

await host.click('.board__toolbar button[aria-label="Unlock the board"]');
await scribble(host, [0.2, 0.2], [0.8, 0.8]);
const late = await joinAndEnter(browser, "Yuki Tashiro", ROOM);
await late.waitForTimeout(2000);
check("a late joiner sees the existing drawing", (await inkPixels(late)) > 500);
await late.context().close();

await host.mouse.move(10, 10);
await host.waitForTimeout(300);
await host.screenshot({ path: `${process.env.OUT ?? "."}/board.png` });
await host.click('.dock__btn[aria-label="Close the whiteboard"]');
await guest.waitForTimeout(700);
check("closing the board returns the grid", await host.isVisible(".stage__grid > .tile"));

console.log("\n--- polls: the popup ---");
// Polls are started from the dock's labelled More menu, not a panel tab.
await guest.click('.dock__btn[aria-label="More room actions"]');
await guest.waitForTimeout(250);
check(
  "guests cannot start a poll",
  !(await guest.isVisible('.dock__menu button:has-text("Start a poll")'))
);
await guest.keyboard.press("Escape");

await host.click('.dock__btn[aria-label="More room actions"]');
await host.waitForTimeout(250);
check("the host is offered a poll in the More menu", await host.isVisible('.dock__menu button:has-text("Start a poll")'));
await host.click('.dock__menu button:has-text("Start a poll")');
await host.waitForSelector(".polldlg--composer");
await host.fill('input[aria-label="Poll question"]', "Did the derivation make sense?");
await host.fill('input[aria-label="Option 1"]', "Yes, keep going");
await host.fill('input[aria-label="Option 2"]', "Go over it again");
// Mark the first option as the right answer.
await host.click('.poll__option-row:has(input[aria-label="Option 1"]) .poll__mark');
await host.waitForTimeout(150);
await host.click('.polldlg--composer button[type="submit"]');
await guest.waitForTimeout(900);

check("the poll pops up for the guest", await guest.isVisible(".polldlg"));
check(
  "the popup carries the question",
  (await guest.textContent(".polldlg__question")) === "Did the derivation make sense?"
);
const popupOptions = await guest.locator(".polldlg .poll__option").count();
check("the popup offers the options", popupOptions === 2, `${popupOptions}`);

console.log("\n--- polls: the chat notice ---");
await guest.click('button[role="tab"]:has-text("Chat")');
await guest.waitForTimeout(200);
check("a poll notice lands in the chat", await guest.isVisible(".msg-poll"));
check(
  "the notice says a poll started",
  (await guest.textContent(".msg-poll__title")) === "A poll is started"
);

console.log("\n--- polls: answering and changing ---");
await guest.click('.polldlg .poll__option:has-text("Go over it again")');
await guest.waitForTimeout(500);
check("answering dismisses the popup", !(await guest.isVisible(".polldlg")));
await host.waitForTimeout(600);
check(
  "the operator sees the vote land while the poll is open",
  (await host.textContent(".poll__tally-head")) === "1 vote"
);
check(
  "the tally shows which way it went",
  (await host.textContent('.poll__result--live:has-text("Go over it again") .poll__share')) === "100%"
);
check(
  "answerers are not shown the running tally",
  (await guest.locator(".poll__tally").count()) === 0
);

// Back in through the chat notice to change the answer.
await guest.click(".msg-poll");
await guest.waitForTimeout(400);
check("the chat notice reopens the poll", await guest.isVisible(".polldlg"));
check("the previous answer is marked", await guest.isVisible(".polldlg .poll__option.is-mine"));
await guest.click('.polldlg .poll__option:has-text("Yes, keep going")');
await host.waitForTimeout(700);
check(
  "changing the answer replaces it rather than adding one",
  (await host.textContent(".poll__tally-head")) === "1 vote"
);
check(
  "the new choice is the one counted",
  (await host.textContent('.poll__result--live:has-text("Yes, keep going") .poll__share')) === "100%"
);

console.log("\n--- polls: ending and revealing ---");
await host.click('.polldlg__controls button:has-text("End poll")');
await guest.waitForTimeout(600);
await guest.click(".msg-poll");
await guest.waitForTimeout(400);
const closedOptions = await guest.locator(".polldlg .poll__option").count();
check("an ended poll cannot be answered", closedOptions === 0, `${closedOptions} clickable options`);

await host.click('.polldlg__controls button:has-text("Show both")');
await guest.waitForTimeout(800);
await guest.click('button[role="tab"]:has-text("Chat")');
await guest.waitForTimeout(300);
check("results are published to the chat", await guest.isVisible(".msg-results"));
const summary = await guest.textContent(".msg-results__body");
check("the summary carries the percentages", summary.includes("100%"), summary.split("\n")[1] ?? "");
check("the summary marks the correct answer", summary.includes("(correct)"));

await guest.mouse.move(10, 10);
await guest.waitForTimeout(300);
await guest.screenshot({ path: `${process.env.OUT ?? "."}/polls.png` });

await browser.close();
process.exit(finish() === 0 ? 0 : 1);
