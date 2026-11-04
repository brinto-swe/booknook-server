import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import { SignJWT, createRemoteJWKSet, customFetch, exportJWK, generateKeyPair } from "jose";
import { createAuthenticate } from "../src/middleware/authenticate.js";
import { readAuthConfiguration, getAuthVerifierConfiguration } from "../src/config/auth.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { createApiRateLimiter } from "../src/middleware/security.js";

const issuer = "http://localhost:3000";

test("JWT authentication uses real signatures with mocked remote JWKS", async (t) => {
  const keys = await generateKeyPair("EdDSA");
  const wrongKeys = await generateKeyPair("EdDSA");
  const publicJwk = { ...await exportJWK(keys.publicKey), kid: "test-key", alg: "EdDSA" };
  let jwksFetches = 0;
  const jwks = createRemoteJWKSet(new URL("http://auth.example.test/api/auth/jwks"), {
    [customFetch]: async () => { jwksFetches++; return Response.json({ keys: [publicJwk] }); },
  });
  const authenticate = createAuthenticate(() => ({ issuer, audience: issuer, jwks }));
  const app = express();
  app.use(express.json());
  // This test-only endpoint is never mounted in the application.
  app.get("/private-check", authenticate, (req, res) => res.json({ user: req.user }));
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/private-check`;
  const token = (overrides = {}) => new SignJWT({ email: "reader@example.com", ...overrides.payload })
    .setProtectedHeader({ alg: "EdDSA", kid: "test-key" })
    .setSubject("user-123")
    .setIssuedAt()
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? issuer)
    .setExpirationTime(overrides.expiry ?? "15m")
    .sign(overrides.privateKey ?? keys.privateKey);
  async function unauthorized(authorization) {
    const response = await fetch(url, { headers: authorization === undefined ? {} : { Authorization: authorization } });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), "Bearer");
    assert.deepEqual(await response.json(), { success: false, error: { code: "UNAUTHORIZED", message: "Authentication required." } });
  }

  await t.test("missing Authorization header", () => unauthorized());
  await t.test("malformed Bearer headers", async () => {
    for (const header of ["Basic abc", "Bearer", "Bearer abc", "Bearer a.b.c extra", "Bearer a.b.c, Bearer d.e.f"]) {
      await unauthorized(header);
    }
  });
  await t.test("invalid signature", async () => unauthorized(`Bearer ${await token({ privateKey: wrongKeys.privateKey })}`));
  await t.test("expired JWT", async () => unauthorized(`Bearer ${await token({ expiry: Math.floor(Date.now() / 1000) - 60 })}`));
  await t.test("wrong issuer", async () => unauthorized(`Bearer ${await token({ issuer: "http://wrong.example" })}`));
  await t.test("wrong audience", async () => unauthorized(`Bearer ${await token({ audience: "http://wrong.example" })}`));
  await t.test("valid JWT attaches only verified user ID and email", async () => {
    const response = await fetch(`${url}?email=attacker@example.com`, {
      headers: { Authorization: `Bearer ${await token({ payload: { name: "Not attached", id: "attacker" } })}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { user: { id: "user-123", email: "reader@example.com" } });
    assert.equal(jwksFetches, 1, "remote JWKS should be fetched once and cached");
  });
  await t.test("invalid identity claims", async () => unauthorized(`Bearer ${await token({ payload: { email: null } })}`));
  await t.test("missing expiry is rejected", async () => {
    const noExpiry = await new SignJWT({ sub: "user-123", email: "reader@example.com", iat: Math.floor(Date.now() / 1000) })
      .setProtectedHeader({ alg: "EdDSA", kid: "test-key" }).setIssuer(issuer).setAudience(issuer).sign(keys.privateKey);
    await unauthorized(`Bearer ${noExpiry}`);
  });
  await t.test("HS256 is rejected even with otherwise valid claims", async () => {
    const wrongAlgorithm = await new SignJWT({ sub: "user-123", email: "reader@example.com" })
      .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("15m")
      .setIssuer(issuer).setAudience(issuer).sign(new Uint8Array(32));
    await unauthorized(`Bearer ${wrongAlgorithm}`);
  });
  await t.test("JWKS outage fails closed without leaking network details", async () => {
    const failingResolver = createRemoteJWKSet(new URL("http://auth.example.test/api/auth/jwks"), {
      [customFetch]: async () => { throw new Error("PRIVATE network detail"); },
    });
    const middleware = createAuthenticate(() => ({ issuer, audience: issuer, jwks: failingResolver }));
    const req = { headers: { authorization: `Bearer ${await token()}` }, user: { id: "untrusted" } };
    let error;
    await middleware(req, { set() {} }, value => { error = value; });
    assert.equal(error.status, 401);
    assert.equal(error.code, "UNAUTHORIZED");
    assert.ok(!error.message.includes("PRIVATE"));
    assert.equal(req.user, undefined);
  });
});

test("auth configuration validates URLs and reuses the JWKS resolver", () => {
  const previous = { ...process.env };
  try {
    Object.assign(process.env, { AUTH_ISSUER: issuer, AUTH_AUDIENCE: issuer, AUTH_JWKS_URL: `${issuer}/api/auth/jwks`, NODE_ENV: "test" });
    assert.equal(getAuthVerifierConfiguration().jwks, getAuthVerifierConfiguration().jwks);
    assert.throws(() => readAuthConfiguration({}), /required/);
    assert.throws(() => readAuthConfiguration({ ...process.env, AUTH_JWKS_URL: "not a URL" }), /Invalid/);
    assert.throws(() => readAuthConfiguration({ ...process.env, NODE_ENV: "production" }), /HTTPS/);
  } finally { process.env = previous; }
});

test("API rate limiter uses consistent JSON errors and skips health", async () => {
  const middleware = createApiRateLimiter({ limit: 1 });
  const app = express();
  app.use(middleware);
  app.get("/api/health", (_req, res) => res.json({ application: "ok" }));
  app.get("/check", (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${origin}/check`)).status, 200);
    const rejected = await fetch(`${origin}/check`);
    assert.equal(rejected.status, 429);
    assert.equal((await rejected.json()).error.code, "RATE_LIMITED");
    assert.equal((await fetch(`${origin}/api/health`)).status, 200);
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
});
