/**
 * The meeting stage.
 *
 * Tiles are created once per participant and reused: rebuilding a <video>
 * element restarts playback and makes the grid flash on every state change.
 * Layout is recomputed instead, which is cheap.
 */

import { el, hueFromName, initials } from "../dom";
import { icons } from "../icons";
import type { Participant, ParticipantId } from "../types";

const GAP = 12;
const ASPECT = 16 / 9;

interface Tile {
  root: HTMLElement;
  video: HTMLVideoElement;
  placeholder: HTMLElement;
  nameLabel: HTMLElement;
  mutedMark: HTMLElement;
  hand: HTMLElement;
  badges: HTMLElement;
  stream: MediaStream | null;
}

export interface StageOptions {
  onInvite: () => void;
}

export class Stage {
  readonly root: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly filmstrip: HTMLElement;
  private readonly emptyState: HTMLElement;

  private tiles = new Map<string, Tile>();
  private participants: Participant[] = [];
  private selfId: ParticipantId | null = null;
  private speaking = new Set<ParticipantId>();
  private spotlightKey: string | null = null;
  private resizeObserver: ResizeObserver;

  constructor(private readonly options: StageOptions) {
    this.grid = el("div", { class: "stage__grid" });
    this.filmstrip = el("div", { class: "filmstrip", hidden: true });
    this.emptyState = this.buildEmptyState();
    this.root = el("section", { class: "stage glass-1", "aria-label": "Meeting stage" }, [
      this.grid,
    ]);

    this.resizeObserver = new ResizeObserver(() => this.relayout());
    this.resizeObserver.observe(this.root);
  }

  private buildEmptyState(): HTMLElement {
    const invite = el("button", { class: "btn btn--accent", type: "button" }, [
      el("span", { html: icons.link }),
      el("span", { text: "Copy invite link" }),
    ]);
    invite.addEventListener("click", () => this.options.onInvite());

    return el("div", { class: "state" }, [
      el("span", { class: "state__mark", html: icons.people }),
      el("p", { class: "state__title", text: "You are the only one here" }),
      el("p", {
        class: "state__body",
        text: "Share the room link and people can join straight from their browser. Nothing to install.",
      }),
      invite,
    ]);
  }

  setSelf(id: ParticipantId): void {
    this.selfId = id;
  }

  /** Applies a new participant list, adding and removing tiles as needed. */
  setParticipants(participants: Participant[]): void {
    this.participants = participants;
    const wanted = new Set<string>();

    for (const participant of participants) {
      wanted.add(participant.id);
      this.ensureTile(participant.id, participant);
      if (participant.screen) {
        const key = screenKey(participant.id);
        wanted.add(key);
        this.ensureTile(key, participant, true);
      }
    }

    for (const [key, tile] of this.tiles) {
      if (!wanted.has(key)) {
        tile.root.remove();
        this.tiles.delete(key);
      }
    }

    // A shared screen owns the stage; otherwise everyone shares the grid.
    const sharer = participants.find((p) => p.screen);
    this.spotlightKey = sharer ? screenKey(sharer.id) : null;

    this.render();
  }

  private ensureTile(key: string, participant: Participant, isScreen = false): Tile {
    const existing = this.tiles.get(key);
    if (existing) {
      this.paintTile(existing, participant, isScreen);
      return existing;
    }

    const video = el("video", {
      autoplay: true,
      playsinline: true,
      // Audio is played through dedicated <audio> elements so it survives any
      // reordering of the grid.
      muted: true,
    }) as HTMLVideoElement;
    video.muted = true;

    const placeholder = el("div", { class: "tile__placeholder" }, [
      el("span", { class: "avatar avatar--lg", "aria-hidden": "true" }),
    ]);
    const nameLabel = el("span", { class: "tile__name" });
    const mutedMark = el("span", { class: "tile__muted", html: icons.micOff, hidden: true });
    const badges = el("div", { class: "tile__badges" });
    const hand = el("span", { class: "tile__hand", html: icons.hand, hidden: true });

    const root = el("div", { class: "tile" }, [
      video,
      placeholder,
      badges,
      hand,
      el("div", { class: "tile__footer" }, [nameLabel]),
    ]);
    nameLabel.append(mutedMark);

    const tile: Tile = { root, video, placeholder, nameLabel, mutedMark, hand, badges, stream: null };
    this.tiles.set(key, tile);
    this.paintTile(tile, participant, isScreen);
    return tile;
  }

  private paintTile(tile: Tile, participant: Participant, isScreen: boolean): void {
    const isSelf = participant.id === this.selfId;
    const label = isScreen
      ? `${participant.name} — screen`
      : isSelf
        ? `${participant.name} (you)`
        : participant.name;

    tile.root.classList.toggle("tile--screen", isScreen);
    tile.root.classList.toggle("tile--self", isSelf);
    tile.root.classList.toggle("tile--host", !isScreen && participant.role === "host");
    tile.root.setAttribute("aria-label", label);

    // textContent, not innerHTML: names are user supplied.
    tile.nameLabel.textContent = label;
    tile.nameLabel.append(tile.mutedMark);
    tile.mutedMark.hidden = isScreen || participant.mic;

    tile.hand.hidden = isScreen || !participant.hand;
    tile.hand.setAttribute("title", `${participant.name} raised their hand`);

    tile.badges.replaceChildren();
    if (!isScreen && participant.role !== "guest") {
      tile.badges.append(
        el("span", { class: "pill pill--host" }, [
          el("span", { html: icons.shield, style: "width:12px;height:12px" }),
          el("span", { text: participant.role === "host" ? "Host" : "Moderator" }),
        ])
      );
    }

    const avatar = tile.placeholder.firstElementChild as HTMLElement;
    avatar.style.setProperty("--hue", String(hueFromName(participant.name)));
    avatar.textContent = initials(participant.name);

    this.applyVisibility(tile);
  }

  /** Shows video when a track is live, the identity placeholder otherwise. */
  private applyVisibility(tile: Tile): void {
    const hasVideo = tile.stream !== null && tile.stream.getVideoTracks().some((t) => t.readyState === "live");
    tile.video.hidden = !hasVideo;
    tile.placeholder.hidden = hasVideo;
  }

  setStream(id: ParticipantId, slot: "camera" | "screen", stream: MediaStream | null): void {
    const key = slot === "screen" ? screenKey(id) : id;
    const tile = this.tiles.get(key);
    if (!tile) return;
    tile.stream = stream;
    if (tile.video.srcObject !== stream) {
      tile.video.srcObject = stream;
      if (stream) void tile.video.play().catch(() => undefined);
    }
    this.applyVisibility(tile);
  }

  setSpeaking(id: ParticipantId, active: boolean): void {
    if (active) this.speaking.add(id);
    else this.speaking.delete(id);
    this.tiles.get(id)?.root.classList.toggle("tile--speaking", active);
  }

  isSpeaking(id: ParticipantId): boolean {
    return this.speaking.has(id);
  }

  private render(): void {
    const spotlight = this.spotlightKey ? this.tiles.get(this.spotlightKey) : null;

    if (this.participants.length <= 1 && !spotlight) {
      // Alone in the room: the self tile plus a state that says what to do.
      const selfTile = this.selfId ? this.tiles.get(this.selfId) : null;
      this.root.classList.remove("stage--spotlight");
      this.grid.replaceChildren();
      if (selfTile) {
        this.grid.append(selfTile.root);
        this.grid.style.setProperty("--cols", "1");
        this.grid.style.removeProperty("--tile-w");
        this.grid.style.removeProperty("--tile-h");
        this.grid.style.maxWidth = "min(100%, calc(62vh * 16 / 9))";
        this.grid.style.margin = "0 auto";
      }
      this.root.append(this.emptyState);
      this.emptyState.hidden = Boolean(selfTile) && this.participants.length === 1;
      if (selfTile && this.participants.length === 1) {
        // Keep the invite affordance visible below the single tile.
        this.emptyState.hidden = false;
        this.emptyState.style.height = "auto";
        this.emptyState.style.padding = "0 var(--s-8) var(--s-8)";
      }
      return;
    }

    this.emptyState.remove();
    this.grid.style.removeProperty("max-width");
    this.grid.style.removeProperty("margin");
    this.root.classList.toggle("stage--spotlight", Boolean(spotlight));

    if (spotlight) {
      const others = this.orderedTiles().filter((t) => t !== spotlight);
      this.filmstrip.replaceChildren(...others.map((t) => t.root));
      this.filmstrip.hidden = others.length === 0;
      this.grid.replaceChildren(spotlight.root, this.filmstrip);
      this.grid.style.setProperty("--cols", "1");
      this.grid.style.removeProperty("--tile-w");
      this.grid.style.removeProperty("--tile-h");
    } else {
      this.grid.replaceChildren(...this.orderedTiles().map((t) => t.root));
      this.relayout();
    }
  }

  /** Self first, then join order; the server already sorts the list. */
  private orderedTiles(): Tile[] {
    const ordered: Tile[] = [];
    for (const participant of this.participants) {
      const screen = this.tiles.get(screenKey(participant.id));
      if (screen) ordered.push(screen);
      const camera = this.tiles.get(participant.id);
      if (camera) ordered.push(camera);
    }
    return ordered;
  }

  /**
   * Picks the column count that makes the tiles as large as possible.
   *
   * Trying every count and keeping the best is exact and costs nothing at
   * these sizes; `auto-fit` cannot do this because it does not know the
   * available height and leaves the last row half empty.
   */
  relayout(): void {
    if (this.root.classList.contains("stage--spotlight")) return;
    const count = this.grid.children.length;
    if (count === 0) return;

    const style = getComputedStyle(this.grid);
    const width =
      this.grid.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const height =
      this.grid.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    if (width <= 0 || height <= 0) return;

    let bestColumns = 1;
    let bestWidth = 0;

    for (let columns = 1; columns <= count; columns += 1) {
      const rows = Math.ceil(count / columns);
      const cellWidth = (width - GAP * (columns - 1)) / columns;
      const cellHeight = (height - GAP * (rows - 1)) / rows;
      if (cellWidth <= 0 || cellHeight <= 0) continue;
      const tileWidth = Math.min(cellWidth, cellHeight * ASPECT);
      if (tileWidth > bestWidth) {
        bestWidth = tileWidth;
        bestColumns = columns;
      }
    }

    // Publish the exact size as well as the count: letting the tiles stretch
    // to the column width would push the final row off the bottom of a stage
    // that is not tall enough for it.
    const rows = Math.ceil(count / bestColumns);
    const cellHeight = (height - GAP * (rows - 1)) / rows;
    const tileWidth = Math.floor(Math.min(bestWidth, cellHeight * ASPECT));
    this.grid.style.setProperty("--cols", String(bestColumns));
    this.grid.style.setProperty("--tile-w", `${tileWidth}px`);
    this.grid.style.setProperty("--tile-h", `${Math.floor(tileWidth / ASPECT)}px`);
  }

  destroy(): void {
    this.resizeObserver.disconnect();
  }
}

const screenKey = (id: ParticipantId): string => `${id}::screen`;
