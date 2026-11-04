import { createRemoteJWKSet } from "jose";

let cached;

export function readAuthConfiguration(environment = process.env) {
  const { AUTH_ISSUER, AUTH_AUDIENCE, AUTH_JWKS_URL } = environment;
  if (![AUTH_ISSUER, AUTH_AUDIENCE, AUTH_JWKS_URL].every(value => typeof value === "string" && value.trim())) {
    throw new Error("AUTH_ISSUER, AUTH_AUDIENCE, and AUTH_JWKS_URL are required.");
  }
  for (const value of [AUTH_ISSUER, AUTH_AUDIENCE, AUTH_JWKS_URL]) {
    let url;
    try { url = new URL(value); } catch { throw new Error("Invalid authentication URL configuration."); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
      || url.hash || url.search) throw new Error("Invalid authentication URL configuration.");
    if (environment.NODE_ENV === "production" && url.protocol !== "https:") {
      throw new Error("Production authentication URLs must use HTTPS.");
    }
  }
  return { issuer: AUTH_ISSUER, audience: AUTH_AUDIENCE, jwksUrl: AUTH_JWKS_URL };
}

export function getAuthVerifierConfiguration() {
  const configuration = readAuthConfiguration();
  const key = JSON.stringify(configuration);
  if (cached?.key !== key) {
    cached = {
      key,
      value: {
        ...configuration,
        jwks: createRemoteJWKSet(new URL(configuration.jwksUrl), {
          timeoutDuration: 5000,
          cacheMaxAge: 600000,
          cooldownDuration: 30000,
        }),
      },
    };
  }
  return cached.value;
}
