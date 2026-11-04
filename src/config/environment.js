import { readAuthConfiguration } from "./auth.js";
export const isVercelRuntime = (environment = process.env) => environment.VERCEL === "1";
export const isProductionRuntime = (environment = process.env) => environment.NODE_ENV === "production" || isVercelRuntime(environment);

export function readClientOrigin(environment = process.env) {
  let origin;
  if (!environment.CLIENT_URL?.trim()) throw new Error("CLIENT_URL is required.");
  try { origin = new URL(environment.CLIENT_URL); } catch { throw new Error("CLIENT_URL must be a valid HTTP or HTTPS origin."); }
  if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== environment.CLIENT_URL || origin.username || origin.password
    || (isProductionRuntime(environment) && origin.protocol !== "https:")) throw new Error("CLIENT_URL must be an approved HTTP or HTTPS origin without a path or credentials.");
  return origin.origin;
}
export function readRuntimeConfiguration(environment = process.env, { validateAuth = true } = {}) {
  for (const name of ["MONGODB_URI", "DB_NAME"]) {
    if (!environment[name]?.trim()) throw new Error(`${name} is required.`);
  }
  if (!/^mongodb(?:\+srv)?:\/\//.test(environment.MONGODB_URI)) throw new Error("MONGODB_URI must be a MongoDB connection string.");
  const clientOrigin = readClientOrigin(environment);
  if (validateAuth) readAuthConfiguration(environment);
  return { clientOrigin };
}
export function readLocalPort(environment = process.env) {
  const port = Number(environment.PORT ?? 5000);
  if (!/^\d+$/.test(String(environment.PORT ?? 5000)) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer between 1 and 65535.");
  return port;
}
