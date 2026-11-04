import express from "express";
import cors from "cors";
import helmet from "helmet";
import { createApiRateLimiter } from "./middleware/security.js";
import { connectDatabase } from "./config/database.js";
import { readClientOrigin, readRuntimeConfiguration, isProductionRuntime } from "./config/environment.js";
import { ApiError } from "./utils/apiError.js";
import healthRoutes from "./routes/healthRoutes.js";
import { createBookRoutes } from "./routes/bookRoutes.js";
import { createBorrowRoutes } from "./routes/borrowRoutes.js";
import { notFound } from "./middleware/notFound.js";
import { errorHandler } from "./middleware/errorHandler.js";

export function createApp({ authenticateMiddleware, borrowService, initialize = connectDatabase,
  validateConfiguration = () => readRuntimeConfiguration(process.env, { validateAuth: isProductionRuntime() }),
  rateLimiter = createApiRateLimiter() } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use(helmet());
  app.use(cors((_req, callback) => {
    let origin = false;
    try { origin = readClientOrigin(); } catch { /* Initialization reports safe configuration errors. */ }
    callback(null, { origin, allowedHeaders: ["Content-Type", "Authorization"] });
  }));
  app.use(async (req, res, next) => {
    try {
      validateConfiguration();
      await initialize();
      next();
    } catch {
      if ((req.method === "GET" || req.method === "HEAD") && req.path === "/api/health") {
        return res.set("Cache-Control", "no-store").status(503).json({ application: "ok", database: "unavailable" });
      }
      next(new ApiError("SERVICE_UNAVAILABLE"));
    }
  });
  app.use(rateLimiter);
  app.use(express.json({ limit: "100kb" }));
  app.use(healthRoutes);
  app.use(createBookRoutes(authenticateMiddleware));
  app.use(createBorrowRoutes(authenticateMiddleware, borrowService));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

// No listener, credentials loading, network I/O, or environment access at import.
// Both Vercel and the local bootstrap serve this real Express application.
const app = createApp({ validateConfiguration: () => readRuntimeConfiguration() });
export default app;
