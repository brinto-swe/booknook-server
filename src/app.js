import express from "express";
import cors from "cors";
import healthRoutes from "./routes/healthRoutes.js";
import bookRoutes from "./routes/bookRoutes.js";
import { notFound } from "./middleware/notFound.js";
import { errorHandler } from "./middleware/errorHandler.js";

export function createApp() {
  const clientUrl = process.env.CLIENT_URL;
  if (!clientUrl) throw new Error("CLIENT_URL is required.");

  const app = express();
  app.disable("x-powered-by");
  app.use(cors({
    origin: clientUrl,
    allowedHeaders: ["Content-Type", "Authorization"],
  }));
  app.use(express.json({ limit: "100kb" }));

  app.use(healthRoutes);
  app.use(bookRoutes);
  // Mount future business routers here, before the terminal middleware.
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
