import { listBooks, getBook, createBook, updateBook, deleteBook } from "../services/bookService.js";
import { sendSuccess } from "../utils/apiResponse.js";
export async function listBooksController(req, res) { return sendSuccess(res, await listBooks(req.validated.query, req.user)); }
export async function getBookController(req, res) { return sendSuccess(res, await getBook(req.validated.params.id)); }
export async function createBookController(req, res) { return sendSuccess(res, await createBook(req.validated.body, req.user), 201); }
export async function updateBookController(req, res) { return sendSuccess(res, await updateBook(req.validated.params.id, req.validated.body, req.user)); }
export async function deleteBookController(req, res) { return sendSuccess(res, await deleteBook(req.validated.params.id, req.user)); }
