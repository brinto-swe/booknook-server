import { rateLimit } from "express-rate-limit";
import { ApiError } from "../utils/apiError.js";

export function createApiRateLimiter({ limit = 300, windowMs = 60000 } = {}) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skip: req => req.path === "/api/health",
    handler: (_req, _res, next) => next(new ApiError("RATE_LIMITED")),
  });
}
