import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { AudioCodec, VideoCodec, type StreamMetadata } from "eufy-security-client";
import { config } from "./config.js";

const ffmpegPath = createRequire(import.meta.url)("ffmpeg-static") as string | null;

export interface StreamState {
  serial: string;
  status: "active" | "failed" | "stopped";
  playlist?: string;
  recording?: string;
  startedAt: string;
  error?: string;
}

interface RunningStream extends StreamState {
  process: ChildProcess;
  video: Readable;
  audio: Readable;
  manifestFile: string;
}

const safeSerial = (serial: string) => serial.replace(/[^A-Za-z0-9_-]/g, "_");

export class MediaService {
  private streams = new Map<string, RunningStream>();
  private ended = new Map<string, StreamState>();

  constructor() {
    mkdirSync(config.runtimeDir, { recursive: true });
    mkdirSync(config.recordingsDir, { recursive: true });
  }

  start(serial: string, metadata: StreamMetadata, video: Readable, audio: Readable, record: boolean): StreamState {
    this.stop(serial);
    this.ended.delete(serial);
    if (!ffmpegPath) throw new Error("No FFmpeg binary is available for this platform");

    const id = safeSerial(serial);
    const runId = `${id}/${Date.now()}`;
    const outputDir = path.join(config.runtimeDir, runId);
    mkdirSync(outputDir, { recursive: true });

    const hasAudio = metadata.audioCodec !== AudioCodec.NONE && metadata.audioCodec !== AudioCodec.UNKNOWN;
    const fps = metadata.videoFPS > 0 && metadata.videoFPS <= 60 ? metadata.videoFPS : 15;
    const args = [
      "-hide_banner", "-loglevel", "warning",
      "-fflags", "+genpts+discardcorrupt",
      "-use_wallclock_as_timestamps", "1",
      "-r", String(fps),
    ];
    args.push("-f", metadata.videoCodec === VideoCodec.H265 ? "hevc" : "h264", "-i", "pipe:3");
    if (hasAudio) args.push("-use_wallclock_as_timestamps", "1", "-f", "aac", "-i", "pipe:4");

    const addMaps = () => {
      args.push("-map", "0:v:0");
      if (hasAudio) args.push("-map", "1:a:0");
    };
    // Eufy's elementary stream has no reliable packet timestamps. Re-encoding
    // normalizes timestamps/keyframes and prevents malformed MPEG-TS segments.
    const videoArgs = [
      "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
      "-pix_fmt", "yuv420p", "-r", String(fps),
      "-g", String(fps * 2), "-keyint_min", String(fps * 2), "-sc_threshold", "0",
    ];

    addMaps();
    args.push(...videoArgs);
    if (hasAudio) args.push(
      "-c:a", "aac", "-b:a", "96k",
      "-af", "aresample=async=1000:first_pts=0",
    );
    args.push(
      "-f", "hls", "-hls_time", "2", "-hls_list_size", "6",
      "-hls_flags", "delete_segments+append_list+independent_segments",
      "-hls_segment_filename", path.join(outputDir, "segment-%05d.ts"),
      path.join(outputDir, "index.m3u8"),
    );

    let recording: string | undefined;
    if (record) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      recording = path.join(config.recordingsDir, `${id}-${stamp}.mp4`);
      addMaps();
      args.push(...videoArgs);
      if (hasAudio) args.push(
        "-c:a", "aac", "-b:a", "96k",
        "-af", "aresample=async=1000:first_pts=0",
      );
      // Fragmented MP4 is playable even when a camera disconnects or the
      // process is interrupted before a traditional final moov atom is saved.
      args.push(
        "-avoid_negative_ts", "make_zero",
        "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
        "-frag_duration", "2000000",
        recording,
      );
    }

    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
    const videoInput = child.stdio[3] as Writable | null;
    const audioInput = child.stdio[4] as Writable | null;
    if (!videoInput) throw new Error("FFmpeg video input was not created");
    video.pipe(videoInput);
    if (hasAudio && audioInput) audio.pipe(audioInput);
    child.stderr?.pipe(createWriteStream(path.join(outputDir, "ffmpeg.log"), { flags: "a" }));

    const state: RunningStream = {
      serial,
      status: "active",
      playlist: `/live/${runId.split("/").map(encodeURIComponent).join("/")}/index.m3u8`,
      manifestFile: path.join(outputDir, "index.m3u8"),
      recording,
      startedAt: new Date().toISOString(),
      process: child,
      video,
      audio,
    };
    this.streams.set(serial, state);
    child.once("error", (error) => this.finish(serial, "failed", `FFmpeg could not start: ${error.message}`));
    child.once("exit", (code, signal) => {
      if (!this.streams.has(serial)) return;
      const message = code === 0
        ? "The camera ended before it delivered a usable video stream"
        : `FFmpeg exited with code ${code ?? signal ?? "unknown"}; see runtime/${runId}/ffmpeg.log`;
      this.finish(serial, "failed", message);
    });
    return this.publicState(state);
  }

  stop(serial: string): void {
    const stream = this.streams.get(serial);
    if (!stream) return;
    stream.video.unpipe();
    stream.audio.unpipe();
    stream.process.kill("SIGINT");
    this.streams.delete(serial);
    this.ended.set(serial, { ...this.publicState(stream), status: "stopped" });
  }

  fail(serial: string, error: string): void {
    const stream = this.streams.get(serial);
    if (!stream && this.ended.get(serial)?.status === "stopped") return;
    if (stream) {
      stream.video.unpipe();
      stream.audio.unpipe();
      stream.process.kill("SIGINT");
    }
    this.finish(serial, "failed", error);
  }

  get(serial: string): StreamState | undefined {
    const state = this.streams.get(serial);
    return state ? this.publicState(state) : this.ended.get(serial);
  }

  private publicState({ serial, playlist, manifestFile, recording, startedAt }: RunningStream): StreamState {
    let ready = false;
    try {
      // FFmpeg writes the manifest before its first segment is necessarily
      // usable. EXTINF appears only after a complete segment is available.
      ready = readFileSync(manifestFile, "utf8").includes("#EXTINF:");
    } catch {
      // The manifest is expected not to exist during initial encoder startup.
    }
    return { serial, status: "active", playlist: ready ? playlist : undefined, recording, startedAt };
  }

  private finish(serial: string, status: "failed" | "stopped", error?: string): void {
    const stream = this.streams.get(serial);
    const previous = stream ? this.publicState(stream) : this.ended.get(serial);
    this.streams.delete(serial);
    this.ended.set(serial, {
      serial,
      status,
      startedAt: previous?.startedAt ?? new Date().toISOString(),
      recording: previous?.recording,
      error,
    });
  }
}
