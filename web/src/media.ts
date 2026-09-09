/**
 * Camera, microphone, screen capture, and speech detection.
 *
 * Toggling mic or camera flips `track.enabled` rather than tearing the track
 * down: renegotiating a peer connection to unmute is slow and visibly drops
 * the tile. The track keeps flowing, it just carries silence or black.
 */

export type MediaFailure = "denied" | "missing" | "busy" | "insecure" | "unsupported" | "unknown";

export class MediaError extends Error {
  constructor(
    readonly reason: MediaFailure,
    readonly kind: "camera" | "microphone" | "screen",
    message: string
  ) {
    super(message);
    this.name = "MediaError";
  }
}

/** getUserMedia only exists in a secure context, which is easy to trip over
 *  when self-hosting over plain HTTP on a LAN address. */
export const isSecureContextForMedia = (): boolean =>
  window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === "function";

function classify(error: unknown, kind: "camera" | "microphone" | "screen"): MediaError {
  const name = error instanceof DOMException ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return new MediaError(
        "denied",
        kind,
        `Permission to use the ${kind} was refused. Allow it in your browser's site settings and try again.`
      );
    case "NotFoundError":
    case "OverconstrainedError":
      return new MediaError("missing", kind, `No ${kind} was found on this device.`);
    case "NotReadableError":
    case "AbortError":
      return new MediaError(
        "busy",
        kind,
        `The ${kind} is already in use by another application.`
      );
    default:
      return new MediaError("unknown", kind, `The ${kind} could not be started.`);
  }
}

export interface DeviceLists {
  cameras: MediaDeviceInfo[];
  microphones: MediaDeviceInfo[];
}

/** Labels are blank until permission is granted, so call this after acquiring. */
export async function listDevices(): Promise<DeviceLists> {
  if (!navigator.mediaDevices?.enumerateDevices) return { cameras: [], microphones: [] };
  const devices = await navigator.mediaDevices.enumerateDevices();
  return {
    cameras: devices.filter((d) => d.kind === "videoinput"),
    microphones: devices.filter((d) => d.kind === "audioinput"),
  };
}

export interface AcquireOptions {
  cameraId?: string;
  microphoneId?: string;
  wantVideo: boolean;
  wantAudio: boolean;
}

/**
 * Requests a local stream. Video and audio are requested separately so a
 * missing camera does not also cost the user their microphone.
 */
export async function acquireLocalStream(options: AcquireOptions): Promise<{
  stream: MediaStream;
  errors: MediaError[];
}> {
  if (!isSecureContextForMedia()) {
    throw new MediaError(
      "insecure",
      "camera",
      "Browsers only grant camera and microphone access over HTTPS or on localhost. See the README for a TLS setup."
    );
  }

  const stream = new MediaStream();
  const errors: MediaError[] = [];

  if (options.wantAudio) {
    try {
      const audio = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: options.microphoneId ? { exact: options.microphoneId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      for (const track of audio.getAudioTracks()) stream.addTrack(track);
    } catch (error) {
      errors.push(classify(error, "microphone"));
    }
  }

  if (options.wantVideo) {
    try {
      const video = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: options.cameraId ? { exact: options.cameraId } : undefined,
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 },
        },
      });
      for (const track of video.getVideoTracks()) stream.addTrack(track);
    } catch (error) {
      errors.push(classify(error, "camera"));
    }
  }

  return { stream, errors };
}

export async function acquireScreenStream(): Promise<MediaStream> {
  if (typeof navigator.mediaDevices?.getDisplayMedia !== "function") {
    throw new MediaError(
      "unsupported",
      "screen",
      "This browser cannot share a screen. Screen sharing needs a desktop browser."
    );
  }
  try {
    return await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 30 } },
      audio: false,
    });
  } catch (error) {
    // Cancelling the picker raises NotAllowedError, which is not a failure.
    if (error instanceof DOMException && error.name === "NotAllowedError") {
      throw new MediaError("denied", "screen", "Screen sharing was cancelled.");
    }
    throw classify(error, "screen");
  }
}

export function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

/**
 * Detects speech on a stream by sampling the waveform.
 *
 * Runs entirely in the browser on the already-received audio: no server round
 * trip, so the speaking ring reacts immediately. Hysteresis and a hold window
 * keep it from strobing between words.
 */
export class SpeechDetector {
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private buffer: Float32Array<ArrayBuffer> | null = null;
  private frame = 0;
  private speaking = false;
  private lastAbove = 0;

  private static readonly ON = 0.045;
  private static readonly OFF = 0.028;
  private static readonly HOLD_MS = 550;

  constructor(private readonly onChange: (speaking: boolean) => void) {}

  attach(stream: MediaStream): void {
    this.detach();
    if (stream.getAudioTracks().length === 0) return;

    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!;
    if (!Ctor) return;

    this.context = new Ctor();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.6;
    this.source = this.context.createMediaStreamSource(stream);
    this.source.connect(this.analyser);
    // Explicit ArrayBuffer: getFloatTimeDomainData rejects a shared buffer.
    this.buffer = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
    this.frame = requestAnimationFrame(this.tick);
  }

  /** Autoplay policy suspends a context created before a user gesture. */
  resume(): void {
    if (this.context?.state === "suspended") void this.context.resume();
  }

  private tick = (): void => {
    this.frame = requestAnimationFrame(this.tick);
    if (!this.analyser || !this.buffer) return;

    this.analyser.getFloatTimeDomainData(this.buffer);
    let sum = 0;
    for (let i = 0; i < this.buffer.length; i += 1) sum += this.buffer[i] * this.buffer[i];
    const rms = Math.sqrt(sum / this.buffer.length);
    const now = performance.now();

    if (rms > SpeechDetector.ON) this.lastAbove = now;

    const shouldSpeak = this.speaking
      ? rms > SpeechDetector.OFF || now - this.lastAbove < SpeechDetector.HOLD_MS
      : rms > SpeechDetector.ON;

    if (shouldSpeak !== this.speaking) {
      this.speaking = shouldSpeak;
      this.onChange(shouldSpeak);
    }
  };

  detach(): void {
    cancelAnimationFrame(this.frame);
    this.source?.disconnect();
    this.analyser?.disconnect();
    void this.context?.close();
    this.context = null;
    this.analyser = null;
    this.source = null;
    this.buffer = null;
    if (this.speaking) {
      this.speaking = false;
      this.onChange(false);
    }
  }
}
