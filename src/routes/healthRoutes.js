import { Router } from "express";
import { healthController } from "../controllers/healthController.js";

const healthRoutes = Router();
healthRoutes.get("/api/health", healthController);

export default healthRoutes;
