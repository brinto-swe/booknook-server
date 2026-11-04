import { isIP } from "node:net";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { MongoRateLimitStore } from "../persistence/rateLimitStore.js";
import { isProductionRuntime, isVercelRuntime } from "../config/environment.js";
import { ApiError } from "../utils/apiError.js";

export function clientAddress(req, environment = process.env) {
  // Vercel overwrites X-Forwarded-For at its ingress. Only consume it when the
  // hosting runtime identifies itself; outside Vercel all forwarded IPs are ignored.
  const address = isVercelRuntime(environment) ? req.headers["x-forwarded-for"] : req.socket?.remoteAddress;
  if (typeof address !== "string" || isIP(address) === 0) throw new ApiError("SERVICE_UNAVAILABLE");
  return address;
}
export function createApiRateLimiter({ limit = 300, windowMs = 60000, store, environment = () => process.env } = {}) {
  const build = selectedStore => rateLimit({
    windowMs, limit, standardHeaders: "draft-8", legacyHeaders: false,
    store: selectedStore, passOnStoreError: false,
    keyGenerator: request => ipKeyGenerator(clientAddress(request, environment())),
    skip: request => request.path === "/api/health",
    handler: (_req, _res, forward) => forward(new ApiError("RATE_LIMITED")),
  });
  // Construct middleware once, outside request handling. Neither store performs
  // network I/O during construction; production never falls back to memory.
  const local = build(store);
  const production = store ? local : build(new MongoRateLimitStore());
  return (req, res, next) => (isProductionRuntime(environment()) ? production : local)(req, res, next);
}
