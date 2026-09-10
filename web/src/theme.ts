/**
 * Theme.
 *
 * Three states, matching how a browser thinks about it: an explicit light or
 * dark choice, or `system`, which follows the OS and keeps following it if
 * the OS changes mid-session.
 */

export type ThemeChoice = "system" | "light" | "dark";

const KEY = "agmeet.theme";
const query = window.matchMedia("(prefers-color-scheme: light)");

function resolve(choice: ThemeChoice): "light" | "dark" {
  if (choice === "system") return query.matches ? "light" : "dark";
  return choice;
}

function apply(choice: ThemeChoice): void {
  // The stylesheet keys off data-theme; `system` still resolves to a concrete
  // value so no rule has to handle "unset".
  document.documentElement.dataset.theme = resolve(choice);
}

/**
 * The product is dark by default rather than following the OS. A meeting
 * stage is mostly video, and video sits better on a dark ground; "match
 * system" is offered, but it is a choice rather than the starting point.
 */
export function currentChoice(): ThemeChoice {
  const stored = localStorage.getItem(KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "dark";
}

export function setTheme(choice: ThemeChoice): void {
  localStorage.setItem(KEY, choice);
  apply(choice);
}

/** Call once at boot, before the first paint. */
export function initTheme(): void {
  apply(currentChoice());
  // Only meaningful while the choice is `system`, but the listener is cheap
  // and always correct.
  query.addEventListener("change", () => {
    if (currentChoice() === "system") apply("system");
  });
}
