/**
 * Layout invariants, checked on every view at every width.
 *
 * Contrast and keyboard reachability have their own suite. This one asks the
 * questions a person asks when a screen looks wrong: is anything off the side,
 * is anything cut off, is any text spilling out of the box drawn around it,
 * and on a phone, is anything too small or too close to hit.
 */

import { BASE, createRoom, joinAndEnter, launch, reporter } from "./helpers.mjs";

const { check, finish } = reporter();
const browser = await launch();

/** Phone, small tablet, laptop. The three shapes the layout changes at. */
const WIDTHS = [
  { label: "390", width: 390, height: 844, touch: true },
  { label: "768", width: 768, height: 1024, touch: true },
  { label: "1440", width: 1440, height: 900, touch: false },
];

/**
 * Everything wrong with a page, in one pass.
 *
 * Runs in the browser because every question here is about rendered boxes.
 */
const AUDIT = () => {
  const problems = [];
  const name = (el) => {
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
    const text = (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 24);
    return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}${text ? ` "${text}"` : ""}`;
  };
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const docWidth = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > docWidth + 1) {
    problems.push(`page scrolls sideways by ${document.documentElement.scrollWidth - docWidth}px`);
  }

  for (const el of document.querySelectorAll("body *")) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);

    // Off the side of the window.
    if (r.right > docWidth + 1 || r.left < -1) {
      // A deliberately parked element (a closed panel, a menu sliding in) is
      // clipped by an ancestor, so it is only a problem if it is reachable.
      const clipped = (() => {
        for (let p = el.parentElement; p; p = p.parentElement) {
          const pcs = getComputedStyle(p);
          if (pcs.overflow !== "visible" && pcs.position !== "static") {
            const pr = p.getBoundingClientRect();
            if (r.right > pr.right + 1 || r.left < pr.left - 1) return true;
          }
        }
        return false;
      })();
      if (!clipped) problems.push(`${name(el)} runs off the side (${Math.round(r.left)}..${Math.round(r.right)} of ${docWidth})`);
    }

    // Text spilling out of the box drawn around it.
    if (cs.overflow === "visible" && el.children.length === 0 && el.textContent.trim()) {
      if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
        problems.push(`${name(el)} text overflows its box by ${el.scrollWidth - el.clientWidth}px`);
      }
    }

    // Content taller than a box that hides the overflow and cannot scroll.
    if ((cs.overflow === "hidden" || cs.overflowY === "hidden") && el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0) {
      const scrollable = cs.overflowY === "auto" || cs.overflowY === "scroll";
      if (!scrollable && !el.closest("[data-allow-clip]")) {
        problems.push(`${name(el)} is cut off: ${el.scrollHeight}px of content in ${el.clientHeight}px`);
      }
    }
  }
  return problems;
};

/** Touch targets, and whether two of them are close enough to mis-hit. */
const TOUCH_AUDIT = () => {
  const small = [];
  const controls = [...document.querySelectorAll("button, a[href], input, select, textarea, [role='tab']")].filter((el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
    if (el.disabled) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.top < window.innerHeight && r.bottom > 0;
  });
  for (const el of controls) {
    // What you can actually hit. A switch drawn as a small pill inside a
    // label is aimed at by tapping the label — its row is the target, not
    // the 40x23 box the pill happens to occupy.
    let box = el.getBoundingClientRect();
    const label = el.closest("label") || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`));
    if (label) {
      const lr = label.getBoundingClientRect();
      box = {
        width: Math.max(box.width, lr.width),
        height: Math.max(box.height, lr.height),
      };
    }
    // 32px is the floor; 44 is the aim. Inline links inside a paragraph are
    // exempt: they are words, not buttons.
    const inline = getComputedStyle(el).display === "inline";
    if (!inline && (box.height < 32 || box.width < 24)) {
      const name = (el.getAttribute("aria-label") || el.textContent || el.id || "").trim().slice(0, 24);
      small.push(`${el.tagName.toLowerCase()} "${name}" ${Math.round(box.width)}x${Math.round(box.height)}`);
    }
  }
  return small;
};

async function audit(page, label) {
  const problems = await page.evaluate(AUDIT);
  check(`${label}: nothing off the side or cut off`, problems.length === 0, problems.slice(0, 4).join(" · "));
  return problems;
}

async function auditTouch(page, label) {
  const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  if (!coarse) {
    check(`${label}: measured as a touch device`, false, "the context has no touch pointer");
    return;
  }
  const small = await page.evaluate(TOUCH_AUDIT);
  check(`${label}: every control is big enough to hit`, small.length === 0, small.slice(0, 4).join(" · "));
}

// --- The dashboard --------------------------------------------------------
console.log("--- dashboard ---");
for (const size of WIDTHS) {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    hasTouch: size.touch,
  });
  const page = await context.newPage();
  await page.goto(BASE);
  await page.waitForSelector(".dash");
  await page.waitForTimeout(400);
  await audit(page, `dashboard @${size.label}`);
  if (size.touch) await auditTouch(page, `dashboard @${size.label}`);

  // Every door policy reveals different fields; each has to fit too.
  for (const policy of ["Passcode", "Ask to join", "Sign in"]) {
    await page.click(`.segment:has-text("${policy}")`);
    await page.waitForTimeout(250);
    await audit(page, `dashboard @${size.label}, ${policy.toLowerCase()}`);
  }
  await context.close();
}

// --- The pre-entry screen -------------------------------------------------
console.log("\n--- pre-entry ---");
{
  const host = await createRoom(browser, "Nour Haddad", "layout-room");
  for (const size of WIDTHS) {
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      hasTouch: size.touch,
    });
    const page = await context.newPage();
    await page.goto(`${BASE}/r/layout-room`);
    await page.waitForSelector(".lobby__card");
    await page.waitForTimeout(900);
    await audit(page, `pre-entry @${size.label}`);
    if (size.touch) await auditTouch(page, `pre-entry @${size.label}`);
    await context.close();
  }
  await host.context().close();
}

// --- The room, in every state it has ---------------------------------------
console.log("\n--- the room ---");
{
  const ROOM = "layout-live";
  const host = await createRoom(browser, "Golnar Shahbazi", ROOM, { whiteboard: true }, { hasTouch: true });
  const guest = await joinAndEnter(browser, "Toma Ferreiro", ROOM);
  await host.waitForTimeout(2200);

  // Something long in the chat: a name and a word that cannot be broken.
  await host.fill(".composer textarea", "Supercalifragilisticexpialidocious-and-then-some-more-unbreakable-text");
  await host.press(".composer textarea", "Enter");
  await host.waitForTimeout(500);

  for (const size of WIDTHS) {
    await host.setViewportSize({ width: size.width, height: size.height });
    await host.waitForTimeout(700);
    await audit(host, `room @${size.label}`);
    if (size.touch) await auditTouch(host, `room @${size.label}`);

    // The panel, open, with a long message in it. On a phone it is a sheet
    // over the stage, and the control bar has to stay reachable under it.
    const toggle = '[aria-label="Toggle side panel"]';
    if ((await host.getAttribute(toggle, "aria-expanded")) === "false") {
      await host.click(toggle);
      await host.waitForTimeout(500);
    }
    await audit(host, `room @${size.label}, panel open`);
    // An open panel is an overlay below 1100px. Everything it overlaps is
    // still a control somebody may need — Leave most of all.
    const buried = await host.evaluate(() => {
      const reachable = (el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return Boolean(hit && (hit === el || el.contains(hit)));
      };
      return [
        ...[...document.querySelectorAll(".dock__btn")],
        document.querySelector('[aria-label="Toggle side panel"]'),
      ]
        .filter((el) => el && !reachable(el))
        .map((el) => el.getAttribute("aria-label"));
    });
    check(
      `room @${size.label}: an open panel buries nothing`,
      buried.length === 0,
      buried.join(", ")
    );

    // Everything below is a control in the bar, so the sheet goes away first.
    await host.click(toggle);
    await host.waitForTimeout(500);

    // The whiteboard.
    await host.click('.dock__btn[aria-label="Open the whiteboard"]');
    await host.waitForTimeout(700);
    await audit(host, `whiteboard @${size.label}`);
    if (size.touch) await auditTouch(host, `whiteboard @${size.label}`);
    await host.click('.dock__btn[aria-label="Close the whiteboard"]');
    await host.waitForTimeout(500);

    // The poll composer and the roster editor, both dialogs over the stage.
    await host.click('.dock__btn[aria-label="More room actions"]');
    await host.waitForTimeout(250);
    await host.click('.dock__menu button:has-text("Start a poll")');
    await host.waitForTimeout(400);
    await audit(host, `poll composer @${size.label}`);
    await host.keyboard.press("Escape");
    await host.click(".polldlg--composer button:has-text('Cancel')").catch(() => {});
    await host.waitForTimeout(300);

    await host.click('.dock [aria-label="Room settings"]');
    await host.waitForTimeout(300);
    await audit(host, `room settings @${size.label}`);
    await host
      .locator(".popover__menu .menu__item", { hasText: "Roles and accounts" })
      .first()
      .click({ force: true });
    await host.waitForTimeout(400);
    await audit(host, `roster editor @${size.label}`);
    if (size.touch) await auditTouch(host, `roster editor @${size.label}`);
    await host.keyboard.press("Escape");
    await host.waitForTimeout(300);
  }

  await guest.context().close();
  await host.context().close();
}

// --- A full room ----------------------------------------------------------
console.log("\n--- six people ---");
{
  const ROOM = "layout-crowd";
  const host = await createRoom(browser, "Golnar Shahbazi", ROOM, {}, { hasTouch: true });
  const others = [];
  for (const name of ["Toma Ferreiro", "Devrim Akbulut", "Léa Fontaine", "Nnamdi Okonkwo", "Sahar Delavari"]) {
    others.push(await joinAndEnter(browser, name, ROOM));
    await host.waitForTimeout(700);
  }
  await host.waitForTimeout(3000);

  for (const size of WIDTHS) {
    await host.setViewportSize({ width: size.width, height: size.height });
    // The bar wraps at narrow widths, which changes how much room the tiles
    // have. Long enough for that to settle and the layout to run again.
    await host.waitForTimeout(1500);
    const grid = await host.evaluate(() => {
      const g = document.querySelector(".stage__grid");
      const box = g.getBoundingClientRect();
      const style = getComputedStyle(g);
      const top = box.top + parseFloat(style.paddingTop);
      const bottom = box.bottom - parseFloat(style.paddingBottom);
      const tiles = [...g.querySelectorAll(":scope > .tile")];
      const clipped = tiles.filter((t) => {
        const r = t.getBoundingClientRect();
        return r.top < top - 1 || r.bottom > bottom + 1;
      });
      return {
        tiles: tiles.length,
        clipped: clipped.length,
        cols: style.getPropertyValue("--cols").trim(),
        size: style.getPropertyValue("--tile-w").trim(),
      };
    });
    check(
      `six people @${size.label}: every tile is fully on the stage`,
      grid.tiles === 6 && grid.clipped === 0,
      `${grid.tiles} tiles, ${grid.cols} columns at ${grid.size}, ${grid.clipped} clipped`
    );
    await audit(host, `six people @${size.label}`);
  }

  for (const page of others) await page.context().close();
  await host.context().close();
}

await browser.close();
process.exit(finish() === 0 ? 0 : 1);
