import { jwtVerify } from "jose";
import { getAuthVerifierConfiguration } from "../config/auth.js";
import { ApiError } from "../utils/apiError.js";

export function createAuthenticate(getConfiguration = getAuthVerifierConfiguration) {
  return async function authenticate(req, res, next) {
    // Never carry unverified identity into a protected handler.
    delete req.user;
    const authorization = req.headers.authorization;
    const match = typeof authorization === "string"
      ? /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorization) : null;
    if (!match) {
      res.set("WWW-Authenticate", "Bearer");
      return next(new ApiError("UNAUTHORIZED"));
    }

    let configuration;
    try { configuration = getConfiguration(); } catch {
      return next(new ApiError("SERVICE_UNAVAILABLE"));
    }
    try {
      const { payload } = await jwtVerify(match[1], configuration.jwks, {
        algorithms: ["EdDSA"],
        issuer: configuration.issuer,
        audience: configuration.audience,
        requiredClaims: ["sub", "email", "exp", "iat"],
      });
      if (typeof payload.sub !== "string" || !payload.sub.trim()
        || typeof payload.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
        throw new Error("Invalid identity claims.");
      }
      req.user = Object.freeze({ id: payload.sub, email: payload.email });
      next();
    } catch {
      // Includes invalid/expired JWTs and unavailable JWKS. Fail closed without
      // leaking bearer tokens, remote URLs, or driver/network error details.
      res.set("WWW-Authenticate", "Bearer");
      next(new ApiError("UNAUTHORIZED"));
    }
  };
}

export const authenticate = createAuthenticate();
