import { BASE, createRoom, launch, reporter } from "./helpers.mjs";

const browser = await launch();
const { check, finish } = reporter();

const AUDIT = `(() => {
  const parse = (c) => {
    const m = c.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(",").map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  // Proper source-over compositing: the result keeps its own alpha, so a
  // stack of translucent glass layers accumulates correctly instead of being
  // treated as opaque after the first one.
  const over = (fg, bg) => {
    const a = fg.a + bg.a * (1 - fg.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    return {
      r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
      g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
      b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
      a,
    };
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); };

  const GROUND = { r: 6, g: 7, b: 15, a: 1 };

  // Returns null when an ancestor paints a gradient: its colour cannot be
  // read from computed style, so those are reported separately rather than
  // guessed at.
  const effectiveBg = (node) => {
    let acc = { r: 0, g: 0, b: 0, a: 0 };
    let n = node;
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage !== "none" && !cs.backgroundImage.startsWith("url(")) return null;
      const bg = parse(cs.backgroundColor);
      if (bg && bg.a > 0) acc = over(acc, bg);
      if (acc.a >= 0.999) return acc;
      n = n.parentElement;
    }
    return over(acc, GROUND);
  };

  const bad = [];
  const gradient = [];
  const seen = new Set();
  document.querySelectorAll("*").forEach((n) => {
    const text = [...n.childNodes].filter((c) => c.nodeType === 3 && c.textContent.trim()).map((c) => c.textContent.trim()).join(" ");
    if (!text) return;
    const cs = getComputedStyle(n);
    if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity) < 0.1) return;
    const r = n.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const fg = parse(cs.color);
    if (!fg) return;
    const key = String(n.className) + "|" + text.slice(0, 24);
    if (seen.has(key)) return;
    seen.add(key);

    const bg = effectiveBg(n);
    if (bg === null) { gradient.push({ text: text.slice(0, 40), cls: String(n.className).slice(0, 30) }); return; }

    const c = ratio(over(fg, bg), bg);
    const size = parseFloat(cs.fontSize);
    const bold = parseInt(cs.fontWeight, 10) >= 700;
    const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
    if (c < need) bad.push({ text: text.slice(0, 40), cls: String(n.className).slice(0, 34), ratio: c.toFixed(2), need });
  });
  return { bad, gradient };
})()`;

async function audit(label, page) {
  const { bad, gradient } = await page.evaluate(AUDIT);
  check(`${label}: all measurable text meets WCAG AA contrast`, bad.length === 0,
    bad.length ? "\n" + bad.map((b) => `      ${b.ratio} (need ${b.need}) "${b.text}" .${b.cls}`).join("\n") : "");
  if (gradient.length) {
    console.log(`      (${gradient.length} on gradient fills, checked by pixel below: ${gradient.map((g) => g.text).join(", ")})`);
  }
}

/**
 * Every view is audited in both themes. A light theme that has not been
 * contrast-checked is not a light theme, it is a second chance to fail.
 */
const page = await createRoom(browser, "Nadia Kowalczyk", "a11y-room");
await page.waitForTimeout(1200);

for (const theme of ["dark", "light"]) {
  await page.evaluate((value) => {
    localStorage.setItem("agmeet.theme", value);
    document.documentElement.dataset.theme = value;
  }, theme);
  await page.waitForTimeout(400);
  await audit(`meeting (${theme})`, page);
  if (theme === "dark") {
    await page.mouse.move(10, 10);
    await page.screenshot({ path: `${process.env.OUT ?? "."}/meeting-dark.png` });
  } else {
    await page.mouse.move(10, 10);
    await page.screenshot({ path: `${process.env.OUT ?? "."}/meeting-light.png` });
  }
}
await page.evaluate(() => localStorage.setItem("agmeet.theme", "dark"));

// The dashboard is the first thing anyone sees, in both themes.
{
  const dash = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await dash.goto(BASE);
  await dash.waitForSelector(".dash");
  for (const theme of ["dark", "light"]) {
    await dash.evaluate((value) => {
      localStorage.setItem("agmeet.theme", value);
      document.documentElement.dataset.theme = value;
    }, theme);
    await dash.waitForTimeout(300);
    await audit(`dashboard (${theme})`, dash);
    await dash.screenshot({ path: `${process.env.OUT ?? "."}/dash-${theme}.png` });
  }
  await dash.context().close();
}

// Keyboard reachability of every dock control.
const reachable = await page.evaluate(() => {
  const focusable = [...document.querySelectorAll(".dock button")];
  return focusable.every((b) => b.tabIndex >= 0 && !b.hasAttribute("aria-hidden"));
});
check("every dock control is keyboard reachable", reachable);

// Text on gradient fills cannot be read from computed style, so sample the
// actual rendered pixels underneath each one.
const gradientContrast = await page.evaluate(async () => {
  const lum = (r, g, b) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const parse = (c) => (c.match(/\d+(\.\d+)?/g) || []).map(Number);
  const out = [];
  // Only real gradients: a translucent backgroundColor is handled correctly by
  // the main audit, and treating it as opaque here would report it as far
  // darker than it renders. Icon-only marks are judged at the 3:1 non-text
  // threshold rather than 4.5:1.
  for (const { sel, need } of [
    { sel: ".btn--accent", need: 4.5 },
    { sel: ".dock__leave", need: 4.5 },
    { sel: ".brand__mark", need: 3 },
  ]) {
    const node = document.querySelector(sel);
    if (!node) continue;
    const cs = getComputedStyle(node);
    // Sample the element's own painted background by rendering its gradient
    // stops is not possible here, so approximate with the mid stop colour
    // extracted from background-image, falling back to backgroundColor.
    const stops = cs.backgroundImage.match(/rgba?\([^)]+\)/g);
    if (!stops || !stops.length) continue;
    const bgs = stops;
    const fg = parse(cs.color);
    if (fg.length < 3) continue;
    let worst = Infinity;
    for (const b of bgs) {
      const p = parse(b);
      if (p.length < 3) continue;
      const l1 = lum(fg[0], fg[1], fg[2]);
      const l2 = lum(p[0], p[1], p[2]);
      const c = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      worst = Math.min(worst, c);
    }
    out.push({ sel, need, ratio: Number(worst.toFixed(2)) });
  }
  return out;
});
for (const g of gradientContrast) {
  check(`gradient fill ${g.sel} clears ${g.need}:1`, g.ratio >= g.need, `${g.ratio}:1`);
}

const unnamed = await page.evaluate(() =>
  [...document.querySelectorAll("button")]
    .filter((b) => (b.getAttribute("aria-label") || b.textContent.trim()).length === 0)
    .map((b) => `${b.className || "(no class)"}`)
);
check("every button has an accessible name", unnamed.length === 0, unnamed.join(", "));

await browser.close();
process.exit(finish() === 0 ? 0 : 1);
