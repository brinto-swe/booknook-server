import dotenv from "dotenv";
import { createServer } from "node:http";

// Suppress dotenv output and never print configuration values or raw errors.
const environment = dotenv.config({ quiet: true });
// Import application modules only after environment loading has completed.
const { createApp } = await import("./app.js");
const { connectDatabase, closeDatabase } = await import("./config/database.js");
const { configureDns } = await import("./config/dns.js");
const { logSafeError } = await import("./config/diagnostics.js");
const { readAuthConfiguration } = await import("./config/auth.js");
let server;
let shuttingDown = false;

function validateEnvironment() {
  if (environment.error && environment.error.code !== "ENOENT") {
    throw new Error("Environment file could not be loaded.");
  }
  for (const name of ["MONGODB_URI", "DB_NAME", "CLIENT_URL"]) {
    if (!process.env[name]?.trim()) throw new Error(`${name} is required.`);
  }
  if (!/^mongodb(?:\+srv)?:\/\//.test(process.env.MONGODB_URI)) {
    throw new Error("MONGODB_URI must be a MongoDB connection string.");
  }
  let origin;
  try {
    origin = new URL(process.env.CLIENT_URL);
  } catch {
    throw new Error("CLIENT_URL must be a valid HTTP or HTTPS origin.");
  }
  if (!["http:", "https:"].includes(origin.protocol)
    || origin.origin !== process.env.CLIENT_URL
    || origin.username || origin.password) {
    throw new Error("CLIENT_URL must be an HTTP or HTTPS origin without a path or credentials.");
  }
  const port = process.env.PORT === undefined ? 5000 : Number(process.env.PORT);
  if (!/^\d+$/.test(String(process.env.PORT ?? 5000))
    || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  return port;
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = exitCode;
  const deadline = setTimeout(() => {
    console.error("Graceful shutdown timed out.");
    server?.closeAllConnections();
    process.exit(1);
  }, 15000);

  try {
    if (server?.listening) {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  } catch (error) {
    logSafeError("HTTP server cleanup failed", error);
    process.exitCode = 1;
  }
  try {
    await closeDatabase();
  } catch (error) {
    logSafeError("MongoDB cleanup failed", error);
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
  }
}

process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });

async function start() {
  try {
    const port = validateEnvironment();
    readAuthConfiguration();
    configureDns();
    await connectDatabase();
    if (shuttingDown) return;
    server = createServer(createApp());
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, () => {
        server.off("error", reject);
        resolve();
      });
    });
    if (shuttingDown) {
      server.close();
      return;
    }
    server.on("error", (error) => {
      logSafeError("HTTP server error", error);
      void shutdown(1);
    });
    console.info(`BookNook API listening on port ${port}.`);
  } catch (error) {
    logSafeError("Startup failed", error);
    await shutdown(1);
  }
}

void start();
