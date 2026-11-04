import express from "express";
import cors from "cors";
import helmet from "helmet";
import { createApiRateLimiter } from "./middleware/security.js";
import healthRoutes from "./routes/healthRoutes.js";
import { createBookRoutes } from "./routes/bookRoutes.js";
import { createBorrowRoutes } from "./routes/borrowRoutes.js";
import { notFound } from "./middleware/notFound.js";
import { errorHandler } from "./middleware/errorHandler.js";

export function createApp({ authenticateMiddleware, borrowService } = {}) {
  const clientUrl = process.env.CLIENT_URL;
  if (!clientUrl) throw new Error("CLIENT_URL is required.");

  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({
    origin: clientUrl,
    allowedHeaders: ["Content-Type", "Authorization"],
  }));
  app.use(createApiRateLimiter());
  app.use(express.json({ limit: "100kb" }));

  app.use(healthRoutes);
  app.use(createBookRoutes(authenticateMiddleware));
  app.use(createBorrowRoutes(authenticateMiddleware, borrowService));
  // Mount future business routers here, before the terminal middleware.
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
