import { mkdirSync } from "node:fs";
import { EufySecurity, P2PConnectionType, PropertyName, type StreamMetadata } from "eufy-security-client";
import type { Readable } from "node:stream";
import { assertCredentials, config } from "./config.js";

export interface DeviceView {
  serial: string;
  stationSerial: string;
  name: string;
  model: string;
  kind: "camera" | "lock" | "other";
  battery: unknown;
  locked: unknown;
  commands: string[];
}

type StreamHandler = (serial: string, metadata: StreamMetadata, video: Readable, audio: Readable) => void;
type StreamEndHandler = (serial: string, error?: Error) => void;

export class EufyService {
  private client?: EufySecurity;
  private streamHandler?: StreamHandler;
  private streamEndHandler?: StreamEndHandler;
  private authState: "offline" | "connecting" | "connected" | "2fa-required" = "offline";

  async connect(): Promise<void> {
    assertCredentials();
    mkdirSync(config.dataDir, { recursive: true });
    this.authState = "connecting";
    const client = await EufySecurity.initialize({
      username: config.username,
      password: config.password,
      country: config.country,
      persistentDir: config.dataDir,
      p2pConnectionSetup: config.p2pMode === "local-only" ? P2PConnectionType.ONLY_LOCAL : P2PConnectionType.QUICKEST,
      enableEmbeddedPKCS1Support: config.embeddedPkcs1,
      pollingIntervalMinutes: 10,
      eventDurationSeconds: 10,
    });
    this.client = client;
    client.setCameraMaxLivestreamDuration(config.maxStreamSeconds);
    client.on("connect", () => { this.authState = "connected"; });
    client.on("close", () => { this.authState = "offline"; });
    client.on("tfa request", () => { this.authState = "2fa-required"; });
    client.on("connection error", (error) => console.error("Eufy connection error:", error.message));
    client.on("station livestream start", (_station, device, metadata, video, audio) => {
      console.log(`Livestream started for ${device.getSerial()} (${metadata.videoWidth}x${metadata.videoHeight}, codec ${metadata.videoCodec})`);
      this.streamHandler?.(device.getSerial(), metadata, video, audio);
    });
    client.on("station livestream stop", (_station, device) => {
      console.log(`Livestream stopped for ${device.getSerial()}`);
      this.streamEndHandler?.(device.getSerial());
    });
    await client.connect();
  }

  status() { return { state: this.authState, version: this.client?.getVersion() }; }

  async submit2fa(code: string): Promise<void> {
    if (!this.client) throw new Error("Eufy client is not initialized");
    await this.client.connect({ verifyCode: code, force: true });
  }

  onStream(handler: StreamHandler): void { this.streamHandler = handler; }
  onStreamEnd(handler: StreamEndHandler): void { this.streamEndHandler = handler; }

  async devices(): Promise<DeviceView[]> {
    if (!this.client) return [];
    return (await this.client.getDevices()).map((device) => ({
      serial: device.getSerial(),
      stationSerial: device.getStationSerial(),
      name: device.getName(),
      model: device.getModel(),
      kind: device.isCamera() ? "camera" : device.isLock() ? "lock" : "other",
      battery: device.hasProperty(PropertyName.DeviceBattery) ? device.getPropertyValue(PropertyName.DeviceBattery) : null,
      locked: device.hasProperty(PropertyName.DeviceLocked) ? device.getPropertyValue(PropertyName.DeviceLocked) : null,
      commands: device.getCommands(),
    }));
  }

  async setLock(serial: string, locked: boolean): Promise<void> {
    const { station, device } = await this.stationAndDevice(serial);
    if (!device.isLock()) throw new Error("Device is not a supported lock");
    station.lockDevice(device, locked);
  }

  async startStream(serial: string): Promise<void> {
    const { device } = await this.stationAndDevice(serial);
    if (!device.isCamera()) throw new Error("Device is not a supported camera");
    await this.client!.startStationLivestream(serial);
  }

  async stopStream(serial: string): Promise<void> {
    if (!this.client) return;
    const { station, device } = await this.stationAndDevice(serial);
    if (!station.isLiveStreaming(device)) return;
    const client = this.client;
    const stopped = new Promise<void>((resolve) => {
      const handler = (_station: unknown, stoppedDevice: { getSerial(): string }) => {
        if (stoppedDevice.getSerial() !== serial) return;
        clearTimeout(timer);
        client.off("station livestream stop", handler);
        resolve();
      };
      const timer = setTimeout(() => {
        client.off("station livestream stop", handler);
        resolve();
      }, 3000);
      client.on("station livestream stop", handler);
    });
    await client.stopStationLivestream(serial);
    await stopped;
  }

  close(): void { this.client?.close(); }

  private async stationAndDevice(serial: string) {
    if (!this.client) throw new Error("Eufy is not connected");
    const device = await this.client.getDevice(serial);
    const station = await this.client.getStation(device.getStationSerial());
    return { station, device };
  }
}
