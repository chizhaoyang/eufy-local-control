import "dotenv/config";
import path from "node:path";

function integer(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

export const config = {
  username: process.env.EUFY_USERNAME ?? "",
  password: process.env.EUFY_PASSWORD ?? "",
  country: (process.env.EUFY_COUNTRY ?? "US").toUpperCase(),
  host: process.env.HOST ?? "127.0.0.1",
  port: integer("PORT", 3000),
  p2pMode: process.env.EUFY_P2P_MODE === "local-only" ? "local-only" as const : "quickest" as const,
  embeddedPkcs1: process.env.EUFY_EMBEDDED_PKCS1 !== "false",
  maxStreamSeconds: nonNegativeInteger("STREAM_MAX_SECONDS", 0),
  recordingsDir: path.resolve(process.env.RECORDINGS_DIR ?? "./recordings"),
  dataDir: path.resolve(process.env.EUFY_DATA_DIR ?? "./.eufy"),
  runtimeDir: path.resolve("./runtime"),
};

export function assertCredentials(): void {
  if (!config.username || !config.password) {
    throw new Error("Set EUFY_USERNAME and EUFY_PASSWORD in .env (copy .env.example first)");
  }
}
