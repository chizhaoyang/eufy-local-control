import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../src/config.js";

test("server is local-only by default", () => {
  assert.equal(config.host, process.env.HOST ?? "127.0.0.1");
});

test("storage paths resolve to absolute paths", () => {
  assert.equal(config.recordingsDir.startsWith("/"), true);
  assert.equal(config.runtimeDir.startsWith("/"), true);
});
