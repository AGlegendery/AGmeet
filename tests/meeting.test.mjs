import { createRoom, joinAndEnter, launch, reporter } from "./helpers.mjs";

const ROOM = "e2e-test-room";
const { check, finish } = reporter();
const browser = await launch();

console.log("--- opening a room ---");
const host = await createRoom(browser, "Mira Solberg", ROOM);
check("host reaches the meeting shell", await host.isVisible(".stage"));
check("dock is rendered", await host.isVisible(".dock"));
check("there is no navigation sidebar", (await host.locator(".sidebar").count()) === 0);
check(
  "alone-in-room state is shown",
  (await host.textContent(".state__title")) === "You are the only one here"
);

console.log("\n--- second participant ---");
const guest = await joinAndEnter(browser, "Toma Ferreiro", ROOM);
await host.waitForTimeout(2500);

const hostMeta = await host.textContent(".room-header__meta");
check("host header counts 2", hostMeta.includes("2 participants"), hostMeta.trim());
check("guest header counts 2", (await guest.textContent(".room-header__meta")).includes("2 participants"));

const tiles = await host.locator(".stage__grid > .tile").count();
check("host renders 2 tiles", tiles === 2, `${tiles} tiles`);

const remoteVideoLive = await host.evaluate(() =>
  [...document.querySelectorAll(".tile:not(.tile--self) video")].some(
    (v) => v.videoWidth > 0 && v.videoHeight > 0 && !v.paused
  )
);
check("peer-to-peer video is flowing", remoteVideoLive);

const selfVideoLive = await host.evaluate(() => {
  const v = document.querySelector(".tile--self video");
  return Boolean(v && !v.hidden && v.videoWidth > 0);
});
check("own camera preview is on the self tile", selfVideoLive);

const fits = await host.evaluate(() => {
  const stage = document.querySelector(".stage").getBoundingClientRect();
  return [...document.querySelectorAll(".stage__grid > .tile")].every((t) => {
    const r = t.getBoundingClientRect();
    return r.top >= stage.top - 1 && r.bottom <= stage.bottom + 1 &&
           r.left >= stage.left - 1 && r.right <= stage.right + 1;
  });
});
check("every tile fits inside the stage", fits);

const dockClear = await host.evaluate(() => {
  const dock = document.querySelector(".dock").getBoundingClientRect();
  return [...document.querySelectorAll(".stage__grid > .tile")].every(
    (t) => t.getBoundingClientRect().bottom <= dock.top + 1
  );
});
check("no tile runs under the control dock", dockClear);

const connState = await host.getAttribute(".link-state", "data-state");
check("connection reports connected", connState === "connected", connState);
// textContent reads hidden nodes too, so assert on visibility.
check("the recording pill stays hidden when nobody records", !(await host.isVisible(".pill--rec")));

console.log("\n--- chat ---");
await host.fill(".composer textarea", "Slides are on the shared drive.");
await host.press(".composer textarea", "Enter");
await guest.waitForTimeout(700);
check(
  "chat reaches the other peer",
  (await guest.textContent(".msg__body")) === "Slides are on the shared drive."
);

console.log("\n--- attachments ---");
// The host attaches a real file; the guest must be able to save it back out.
const SHARED = "تمرین هفته ۴.txt";
const BODY = "AGmeet attachment round trip\n";
await host.setInputFiles(".composer input[type=file]", {
  name: SHARED,
  mimeType: "text/plain",
  buffer: Buffer.from(BODY),
});
await guest.waitForTimeout(900);
check("the attachment appears in the chat", await guest.isVisible(".msg-file"));
check(
  "it is named and sized",
  (await guest.textContent(".msg-file__name")) === SHARED,
  await guest.textContent(".msg-file__meta")
);
const [saved] = await Promise.all([
  guest.waitForEvent("download", { timeout: 8000 }),
  guest.click(".msg-file"),
]);
check("the guest can download it", saved.suggestedFilename() === SHARED, saved.suggestedFilename());
const stream = await saved.createReadStream();
const chunks = [];
for await (const chunk of stream) chunks.push(chunk);
check(
  "the bytes arrive unchanged",
  Buffer.concat(chunks).toString() === BODY,
  JSON.stringify(Buffer.concat(chunks).toString())
);
check(
  "an attachment does not put file bytes in the room history",
  await guest.evaluate(() => !document.body.innerHTML.includes("QUdtZWV0"))
);

console.log("\n--- media state propagation ---");
await host.click('.dock__btn[aria-label="Mute microphone"]');
await guest.waitForTimeout(600);
const muted = await guest.evaluate(() =>
  [...document.querySelectorAll(".tile:not(.tile--self)")].some((t) => {
    const mark = t.querySelector(".tile__muted");
    return mark && !mark.hidden;
  })
);
check("mute is mirrored on the other peer's tile", muted);
await host.click('.dock__btn[aria-label="Unmute microphone"]');
await guest.waitForTimeout(500);

console.log("\n--- participants panel ---");
await guest.click('button[role="tab"]:has-text("People")');
await guest.waitForTimeout(300);
const people = await guest.locator(".person").count();
check("participant list shows both", people === 2, `${people} rows`);

console.log("\n--- adaptive grid ---");
const optimal = await host.evaluate(() => {
  const grid = document.querySelector(".stage__grid");
  const cs = getComputedStyle(grid);
  const w = grid.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const h = grid.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const n = grid.querySelectorAll(".tile").length;
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

await host.setViewportSize({ width: 420, height: 860 });
await host.waitForTimeout(500);
check(
  "mobile stacks to 1 column",
  (await host.evaluate(() =>
    getComputedStyle(document.querySelector(".stage__grid")).getPropertyValue("--cols").trim()
  )) === "1"
);
check(
  "no horizontal overflow on mobile",
  !(await host.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  ))
);
await host.setViewportSize({ width: 1440, height: 900 });
await host.waitForTimeout(400);

console.log("\n--- screenshots ---");
await host.mouse.move(10, 10);
await host.screenshot({ path: `${process.env.OUT ?? "."}/stage-two.png` });

const third = await joinAndEnter(browser, "Devrim Akbulut", ROOM);
await host.waitForTimeout(2200);
check(
  "3 participants lay out without a stranded row",
  (await host.evaluate(() =>
    getComputedStyle(document.querySelector(".stage__grid")).getPropertyValue("--cols").trim()
  )) === "2"
);
await host.mouse.move(10, 10);
await host.screenshot({ path: `${process.env.OUT ?? "."}/stage-three.png` });

console.log("\n--- leave ---");
await third.click('button[aria-label="Leave the meeting"]');
await third.click(".menu__item--danger");
await third.waitForTimeout(1200);
check(
  "leaving lands on a designed state",
  (await third.textContent(".state__title")) === "You left the meeting"
);
await host.waitForTimeout(800);
check(
  "room drops back to 2 participants",
  (await host.textContent(".room-header__meta")).includes("2 participants")
);

await browser.close();
process.exit(finish() === 0 ? 0 : 1);
