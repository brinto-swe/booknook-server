import { Router } from "express";
import { listBooksController, getBookController } from "../controllers/bookController.js";
import { validate } from "../middleware/validate.js";
import { validateBookQuery, validateBookId } from "../validators/bookValidators.js";

const bookRoutes = Router();
bookRoutes.get("/books", validate("query", validateBookQuery), listBooksController);

// Deliberately unmounted in app.js until the private-route authentication phase.
export const bookDetailRoutes = Router();
bookDetailRoutes.get("/books/:id", validate("params", validateBookId), getBookController);

export default bookRoutes;
