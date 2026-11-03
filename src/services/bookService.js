import { findBooks, findBookById } from "../persistence/bookRepository.js";
import { serializeBook } from "../validators/bookValidators.js";
import { ApiError } from "../utils/apiError.js";

export async function listBooks(query) {
  const { books, total } = await findBooks(query);
  return {
    books: books.map(serializeBook),
    pagination: {
      page: query.page, limit: query.limit, total,
      totalPages: Math.ceil(total / query.limit),
    },
  };
}

export async function getBook(id) {
  const book = await findBookById(id);
  if (!book) throw new ApiError("BOOK_NOT_FOUND");
  return serializeBook(book);
}
