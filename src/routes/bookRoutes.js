import { Router } from "express";
import { listBooksController, getBookController, createBookController, updateBookController, deleteBookController } from "../controllers/bookController.js";
import { validate, requireObjectBody } from "../middleware/validate.js";
import { authenticate } from "../middleware/authenticate.js";
import { validateBookQuery, validateBookId, validateCreateBook, validateUpdateBook } from "../validators/bookValidators.js";

export function createBookRoutes(authenticateMiddleware = authenticate) {
  const router = Router();
  router.get("/books", validate("query", validateBookQuery), (req, res, next) => {
    if (req.validated.query.mine) {
      res.set("Cache-Control", "no-store");
      return authenticateMiddleware(req, res, next);
    }
    next();
  }, listBooksController);
  router.use("/books/:id", (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.get("/books/:id", authenticateMiddleware, validate("params", validateBookId), getBookController);
  router.post("/books", authenticateMiddleware, requireObjectBody, validate("body", validateCreateBook), createBookController);
  router.patch("/books/:id", authenticateMiddleware, validate("params", validateBookId), requireObjectBody, validate("body", validateUpdateBook), updateBookController);
  router.delete("/books/:id", authenticateMiddleware, validate("params", validateBookId), deleteBookController);
  return router;
}
export default createBookRoutes();
