/**
 * Local room recording.
 *
 * Everything happens on the recorder's own machine: the stage is composited
 * onto a canvas, the audio is mixed in the browser, and MediaRecorder writes
 * a WebM. Nothing is uploaded, and the server is never told what is in it —
 * only that somebody is recording, so the room can see that it is.
 *
 * The result is offered as a download or discarded. There is no third option,
 * because there is nowhere else for it to go.
 */

export interface RecordingSources {
  /** Live video elements to composite, in the order they should be laid out. */
  videos: () => HTMLVideoElement[];
  /** Remote audio streams, plus the local microphone stream if it is live. */
  audio: () => MediaStream[];
}

export interface Recording {
  blob: Blob;
  durationMs: number;
  filename: string;
}

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 25;

/** Best container the browser will actually give us, most capable first. */
function pickMimeType(): string | undefined {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type));
}

export function canRecord(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function"
  );
}

export class RoomRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private audioContext: AudioContext | null = null;
  private mixer: MediaStreamAudioDestinationNode | null = null;
  private connected = new WeakSet<MediaStream>();
  private frame = 0;
  private startedAt = 0;

  get active(): boolean {
    return this.recorder !== null && this.recorder.state === "recording";
  }

  /**
   * Starts recording. Throws with a readable message rather than a DOM
   * exception, because this is reachable from a menu item.
   */
  start(sources: RecordingSources): void {
    if (this.active) return;
    if (!canRecord()) {
      throw new Error("This browser cannot record. Try a recent Chrome, Edge or Firefox.");
    }

    this.canvas = document.createElement("canvas");
    this.canvas.width = WIDTH;
    this.canvas.height = HEIGHT;
    this.context = this.canvas.getContext("2d", { alpha: false });
    if (!this.context) throw new Error("A drawing surface could not be created.");

    const stream = this.canvas.captureStream(FPS);

    // Audio is mixed through one graph so a participant joining mid-recording
    // can be added without restarting the file.
    try {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!;
      this.audioContext = new Ctor();
      this.mixer = this.audioContext.createMediaStreamDestination();
      for (const track of this.mixer.stream.getAudioTracks()) stream.addTrack(track);
    } catch {
      // A recording with no sound still beats refusing to record.
      this.audioContext = null;
      this.mixer = null;
    }

    const mimeType = pickMimeType();
    this.recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: 2_500_000,
    });
    this.chunks = [];
    this.recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    });
    // One chunk a second, so a crashed tab still leaves most of the take.
    this.recorder.start(1000);
    this.startedAt = performance.now();

    const draw = (): void => {
      this.frame = requestAnimationFrame(draw);
      this.paint(sources.videos());
      this.mixAudio(sources.audio());
    };
    this.frame = requestAnimationFrame(draw);
  }

  /** Lays the live tiles out on the canvas, largest arrangement that fits. */
  private paint(videos: HTMLVideoElement[]): void {
    const ctx = this.context;
    if (!ctx) return;

    ctx.fillStyle = "#0b0b0c";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    const live = videos.filter((v) => v.videoWidth > 0 && v.videoHeight > 0);
    if (live.length === 0) return;

    const columns = Math.ceil(Math.sqrt(live.length));
    const rows = Math.ceil(live.length / columns);
    const cellW = WIDTH / columns;
    const cellH = HEIGHT / rows;

    live.forEach((video, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      // Cover the cell without distorting: crop the overflowing axis.
      const scale = Math.max(cellW / video.videoWidth, cellH / video.videoHeight);
      const drawW = video.videoWidth * scale;
      const drawH = video.videoHeight * scale;
      const x = column * cellW + (cellW - drawW) / 2;
      const y = row * cellH + (cellH - drawH) / 2;
      ctx.save();
      ctx.beginPath();
      ctx.rect(column * cellW, row * cellH, cellW, cellH);
      ctx.clip();
      try {
        ctx.drawImage(video, x, y, drawW, drawH);
      } catch {
        // A video that is between frames throws; the next tick catches it.
      }
      ctx.restore();
    });
  }

  /** Connects any stream not already in the mix. Idempotent per stream. */
  private mixAudio(streams: MediaStream[]): void {
    if (!this.audioContext || !this.mixer) return;
    for (const stream of streams) {
      if (this.connected.has(stream)) continue;
      if (stream.getAudioTracks().length === 0) continue;
      try {
        this.audioContext.createMediaStreamSource(stream).connect(this.mixer);
        this.connected.add(stream);
      } catch {
        // Already connected, or a stream that ended between calls.
      }
    }
  }

  /** Stops and returns the take. Null when nothing was captured. */
  async stop(): Promise<Recording | null> {
    const recorder = this.recorder;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (!recorder) return null;

    const finished = new Promise<void>((resolve) => {
      recorder.addEventListener("stop", () => resolve(), { once: true });
    });
    if (recorder.state !== "inactive") recorder.stop();
    await finished;

    const durationMs = performance.now() - this.startedAt;
    const type = recorder.mimeType || "video/webm";
    const blob = new Blob(this.chunks, { type });

    this.recorder = null;
    this.chunks = [];
    void this.audioContext?.close();
    this.audioContext = null;
    this.mixer = null;
    this.canvas = null;
    this.context = null;

    if (blob.size === 0) return null;
    const extension = type.includes("mp4") ? "mp4" : "webm";
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    return { blob, durationMs, filename: `agmeet-${stamp}.${extension}` };
  }

  /** Stops without keeping anything. */
  async discard(): Promise<void> {
    await this.stop();
  }
}

/** Hands a finished recording to the browser's downloader. */
export function download(recording: Recording): void {
  const url = URL.createObjectURL(recording.blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = recording.filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
