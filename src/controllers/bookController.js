import { listBooks, getBook } from "../services/bookService.js";
import { sendSuccess } from "../utils/apiResponse.js";

export async function listBooksController(req, res) {
  return sendSuccess(res, await listBooks(req.validated.query));
}

export async function getBookController(req, res) {
  return sendSuccess(res, await getBook(req.validated.params.id));
}
