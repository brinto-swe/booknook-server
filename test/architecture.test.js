import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import express from "express";
import { MongoClient } from "mongodb";
import { createApp } from "../src/app.js";
import { connectDatabase, closeDatabase } from "../src/config/database.js";
import { ApiError } from "../src/utils/apiError.js";
import { sendSuccess } from "../src/utils/apiResponse.js";
import { requireObjectBody, validate } from "../src/middleware/validate.js";
import { notFound } from "../src/middleware/notFound.js";
import { errorHandler } from "../src/middleware/errorHandler.js";

test("architecture HTTP contracts without dotenv or Atlas", async (t) => {
  const originalEnvironment = { ...process.env };
  t.after(() => { process.env = originalEnvironment; });
  process.env.CLIENT_URL = "http://localhost:3000";
  process.env.MONGODB_URI = "mongodb://127.0.0.1:27017";
  process.env.DB_NAME = "architecture_test";
  let unavailable = false;
  let connections = 0;
  let closed = 0;
  t.mock.method(MongoClient.prototype, "connect", async function () {
    connections++;
    return this;
  });
  t.mock.method(MongoClient.prototype, "db", () => ({
    command: async () => {
      if (unavailable) throw new Error("private database detail");
      return { ok: 1 };
    },
  }));
  t.mock.method(MongoClient.prototype, "close", async () => { closed++; });
  await Promise.all([connectDatabase(), connectDatabase()]);
  assert.equal(connections, 1);
  t.after(closeDatabase);

  async function listen(app) {
    const server = app.listen(0, "127.0.0.1");
    t.after(() => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }));
    await once(server, "listening");
    return `http://127.0.0.1:${server.address().port}`;
  }
  const origin = await listen(createApp());

  await t.test("health contracts, headers, and database failure", async () => {
    const response = await fetch(`${origin}/api/health`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-powered-by"), null);
    assert.deepEqual(await response.json(), { application: "ok", database: "connected" });
    unavailable = true;
    const degraded = await fetch(`${origin}/api/health`);
    assert.equal(degraded.status, 503);
    assert.deepEqual(await degraded.json(), { application: "ok", database: "unavailable" });
    unavailable = false;
  });

  await t.test("JSON 404 and parser errors", async () => {
    const missing = await fetch(`${origin}/missing`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), {
      success: false, error: { code: "ROUTE_NOT_FOUND", message: "Route not found." },
    });
    const invalid = await fetch(`${origin}/missing`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{bad",
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, "INVALID_JSON");
    const large = await fetch(`${origin}/missing`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "a".repeat(110000) }),
    });
    assert.equal(large.status, 413);
    assert.equal((await large.json()).error.code, "PAYLOAD_TOO_LARGE");
  });

  await t.test("CORS preflight preserves frontend origin and allowed headers", async () => {
    const response = await fetch(`${origin}/api/health`, {
      method: "OPTIONS", headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "GET" },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:3000");
    assert.equal(response.headers.get("access-control-allow-headers"), "Content-Type,Authorization");
  });

  // Test-only routes exercise helpers; they are never mounted in createApp().
  const harness = express();
  harness.use(express.json());
  harness.post("/validate", requireObjectBody, validate("body", async (body) => {
    if (typeof body.label !== "string") throw new ApiError("VALIDATION_ERROR");
    return { label: body.label.trim() };
  }), (req, res) => sendSuccess(res, req.validated.body, 201));
  harness.get("/query", validate("query", () => ({ limit: 6 })),
    (req, res) => sendSuccess(res, req.validated.query));
  harness.get("/failure", async () => { throw new Error("SECRET sentinel"); });
  harness.get("/conflict", () => {
    const error = new ApiError("CONFLICT");
    error.message = "SECRET sentinel";
    throw error;
  });
  harness.use(notFound);
  harness.use(errorHandler);
  const helpers = await listen(harness);

  await t.test("async validation, normalization, allowlisting, and success envelope", async () => {
    const response = await fetch(`${helpers}/validate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "  example  ", untrusted: "drop" }),
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { success: true, data: { label: "example" } });
    for (const body of [[], {}, null]) {
      const invalid = await fetch(`${helpers}/validate`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).success, false);
    }
    const query = await fetch(`${helpers}/query?limit=untrusted`);
    assert.deepEqual(await query.json(), { success: true, data: { limit: 6 } });
  });

  await t.test("async failures and operational errors never expose raw messages", async () => {
    const logs = [];
    const logger = t.mock.method(console, "error", value => logs.push(value));
    const failure = await fetch(`${helpers}/failure`);
    assert.equal(failure.status, 500);
    assert.equal((await failure.json()).error.code, "INTERNAL_ERROR");
    assert.ok(logs.length > 0 && logs.every(value => !value.includes("SECRET")));
    logger.mock.restore();
    const conflict = await fetch(`${helpers}/conflict`);
    assert.equal(conflict.status, 409);
    assert.ok(!(await conflict.text()).includes("SECRET"));
    let delegated;
    const error = new Error("already sent");
    errorHandler(error, {}, { headersSent: true }, value => { delegated = value; });
    assert.equal(delegated, error);
  });

  await t.test("package scripts and connection cleanup", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(pkg.type, "module");
    assert.equal(pkg.scripts.dev, "nodemon src/server.js");
    assert.equal(pkg.scripts.start, "node src/server.js");
    await closeDatabase();
    assert.equal(closed, 1);
  });
});
