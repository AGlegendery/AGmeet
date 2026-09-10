/** Minimal DOM helpers. No framework: the app builds its own elements. */

type Attrs = Record<string, string | number | boolean | null | undefined>;

/**
 * Creates an element. `html` is assigned as innerHTML and must never carry
 * user-supplied text — pass that through `text` or `setText`, which escape by
 * assigning to textContent.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string)[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "html") {
      node.innerHTML = String(value);
    } else if (key === "text") {
      node.textContent = String(value);
    } else if (key === "class") {
      node.className = String(value);
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    node.append(child);
  }
  return node;
}

export const qs = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T =>
  root.querySelector(sel) as T;

/** Deterministic hue per name, so a participant looks the same to everyone. */
export function hueFromName(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return hash % 360;
}

/** One or two letters, taken from word starts. Handles non-Latin scripts. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return [...words[0]].slice(0, 2).join("").toUpperCase();
  return ([...words[0]][0] + [...words[words.length - 1]][0]).toUpperCase();
}

export function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** h:mm:ss once past an hour, m:ss before that. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** Readable room code: no vowels, so it cannot spell anything. */
export function generateRoomId(): string {
  const alphabet = "bcdfghjkmnpqrstvwxz23456789";
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  const code = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  return `${code.slice(0, 3)}-${code.slice(3, 6)}-${code.slice(6, 9)}`;
}

export const prefersReducedMotion = (): boolean =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Hands a blob to the browser's downloader.
 *
 * Shared by recordings and chat attachments: both are bytes this machine
 * already holds, saved without a round trip to anything.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Turns base64 into the bytes it stands for. */
export function decodeBase64(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
