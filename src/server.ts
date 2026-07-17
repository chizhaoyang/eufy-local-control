import express, { type NextFunction, type Request, type Response } from "express";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { EufyService } from "./eufy.js";
import { MediaService } from "./media.js";

const app = express();
const eufy = new EufyService();
const media = new MediaService();
const pendingRecord = new Map<string, boolean>();

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.resolve("public")));
app.use("/vendor/hls.js", express.static(path.resolve("node_modules/hls.js/dist/hls.min.js")));
app.use("/live", express.static(config.runtimeDir, { etag: false, maxAge: 0 }));
app.use("/recordings", express.static(config.recordingsDir, { fallthrough: false }));

eufy.onStream((serial, metadata, video, audio) => {
  try {
    media.start(serial, metadata, video, audio, pendingRecord.get(serial) ?? false);
  } finally {
    pendingRecord.delete(serial);
  }
});
eufy.onStreamEnd((serial, error) => {
  media.fail(serial, error?.message ?? "The Eufy camera stopped the livestream");
});

app.get("/api/status", (_req, res) => res.json(eufy.status()));
app.post("/api/connect", async (_req, res) => {
  await eufy.connect();
  res.status(202).json(eufy.status());
});
app.post("/api/auth/2fa", async (req, res) => {
  const code = String(req.body?.code ?? "").trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: "Enter the 6-digit Eufy verification code" });
  await eufy.submit2fa(code);
  res.status(202).json(eufy.status());
});
app.get("/api/devices", async (_req, res) => res.json(await eufy.devices()));
app.post("/api/devices/:serial/lock", async (req, res) => {
  if (typeof req.body?.locked !== "boolean") return res.status(400).json({ error: "locked must be true or false" });
  await eufy.setLock(req.params.serial, req.body.locked);
  res.status(202).json({ accepted: true });
});
app.post("/api/devices/:serial/stream", async (req, res) => {
  const serial = req.params.serial;
  // Clear a camera/client session left behind by a failed player or encoder.
  media.stop(serial);
  await eufy.stopStream(serial);
  await new Promise((resolve) => setTimeout(resolve, 200));
  pendingRecord.set(serial, req.body?.record === true);
  try {
    await eufy.startStream(serial);
    res.status(202).json({ accepted: true, record: pendingRecord.get(serial) });
  } catch (error) {
    pendingRecord.delete(serial);
    throw error;
  }
});
app.get("/api/devices/:serial/stream", (req, res) => {
  const state = media.get(req.params.serial);
  if (!state) return res.status(404).json({ error: "Stream is not ready" });
  res.json(state);
});
app.delete("/api/devices/:serial/stream", async (req, res) => {
  media.stop(req.params.serial);
  await eufy.stopStream(req.params.serial);
  res.status(204).end();
});
app.get("/api/recordings", (_req, res) => {
  const files = readdirSync(config.recordingsDir)
    .filter((name) => name.endsWith(".mp4"))
    .map((name) => ({ name, size: statSync(path.join(config.recordingsDir, name)).size, url: `/recordings/${encodeURIComponent(name)}` }))
    .sort((a, b) => b.name.localeCompare(a.name));
  res.json(files);
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : "Unexpected error";
  console.error(error);
  res.status(500).json({ error: message });
});

const server = app.listen(config.port, config.host, () => {
  console.log(`Eufy Local Control: http://${config.host}:${config.port}`);
  void eufy.connect().catch((error) => console.error("Initial Eufy connection failed:", error.message));
});

function shutdown() {
  eufy.close();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
