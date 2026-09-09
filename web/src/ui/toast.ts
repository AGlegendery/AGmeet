/** Transient notices. Never blocking, never stacking more than a few deep. */

import { el } from "../dom";
import { icons } from "../icons";

const VISIBLE_MS = 4200;
const MAX_VISIBLE = 3;

let host: HTMLElement | null = null;

function container(): HTMLElement {
  if (!host) {
    host = el("div", { class: "toasts", role: "status", "aria-live": "polite" });
    document.body.append(host);
  }
  return host;
}

export function toast(message: string, tone: "info" | "error" = "info"): void {
  const root = container();
  while (root.children.length >= MAX_VISIBLE) root.firstElementChild?.remove();

  const node = el("div", { class: `toast glass-3${tone === "error" ? " toast--error" : ""}` }, [
    el("span", { html: tone === "error" ? icons.alert : icons.info }),
    el("span", { text: message }),
  ]);
  root.append(node);

  window.setTimeout(() => {
    node.classList.add("is-leaving");
    node.addEventListener("animationend", () => node.remove(), { once: true });
    // Guarantees removal even where the animation is disabled outright.
    window.setTimeout(() => node.remove(), 400);
  }, VISIBLE_MS);
}
