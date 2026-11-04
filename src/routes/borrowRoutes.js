import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { requireObjectBody, validate } from "../middleware/validate.js";
import { validateCreateBorrow, validateBorrowId, validateBorrowQuery } from "../validators/borrowValidators.js";
import { createBorrowControllers } from "../controllers/borrowController.js";
export function createBorrowRoutes(authenticateMiddleware = authenticate, service) {
  const router = Router();
  const controllers = createBorrowControllers(service);
  router.use("/borrows", (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); }, authenticateMiddleware);
  router.post("/borrows", requireObjectBody, validate("body", validateCreateBorrow), controllers.create);
  router.get("/borrows", validate("query", validateBorrowQuery), controllers.list);
  router.delete("/borrows/:id", validate("params", validateBorrowId), controllers.returnBook);
  return router;
}
