import dotenv from "dotenv";
import { createServer } from "node:http";

// Suppress dotenv output and never print configuration values or raw errors.
const environment = dotenv.config({ quiet: true });
// Import application modules only after environment loading has completed.
const { default: app } = await import("./app.js");
const { connectDatabase, closeDatabase } = await import("./config/database.js");
const { configureDns } = await import("./config/dns.js");
const { logSafeError } = await import("./config/diagnostics.js");
const { readRuntimeConfiguration, readLocalPort } = await import("./config/environment.js");
let server;
let shuttingDown = false;

function validateEnvironment() {
  if (environment.error && environment.error.code !== "ENOENT") {
    throw new Error("Environment file could not be loaded.");
  }
  readRuntimeConfiguration();
  return readLocalPort();
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
    configureDns();
    await connectDatabase();
    if (shuttingDown) return;
    server = createServer(app);
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
