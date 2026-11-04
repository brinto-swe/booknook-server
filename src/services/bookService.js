import { findBooks, findBookById, insertBook, updateOwnedBook, deleteOwnedBook } from "../persistence/bookRepository.js";
import { findAuthUser } from "../persistence/authUserRepository.js";
import { serializeBook } from "../validators/bookValidators.js";
import { ApiError } from "../utils/apiError.js";

export async function listBooks(query, user) {
  if (query.mine && !user) throw new ApiError("UNAUTHORIZED");
  const { books, total } = await findBooks({ ...query, ...(query.mine ? { ownerId: user.id } : {}) });
  return { books: books.map(serializeBook), pagination: {
    page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit),
  } };
}
async function requireBook(id) {
  const book = await findBookById(id);
  if (!book) throw new ApiError("BOOK_NOT_FOUND");
  serializeBook(book);
  return book;
}
export async function getBook(id) { return serializeBook(await requireBook(id)); }
export async function createBook(fields, user) {
  const profile = await findAuthUser(user.id);
  if (!profile || typeof profile.name !== "string" || !profile.name.trim()
    || typeof profile.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)) throw new ApiError("UNAUTHORIZED");
  const now = new Date();
  return serializeBook(await insertBook({ ...fields, availableCopies: fields.totalCopies,
    addedByUserId: user.id, addedByName: profile.name, addedByEmail: profile.email,
    createdAt: now, updatedAt: now, addedAt: now }));
}
async function requireOwner(id, user) {
  const book = await requireBook(id);
  if (book.addedByUserId !== user.id) throw new ApiError("FORBIDDEN");
  return book;
}
export async function updateBook(id, fields, user) {
  const book = await requireOwner(id, user);
  const changes = { ...fields, updatedAt: new Date() };
  if (fields.totalCopies !== undefined) {
    changes.availableCopies = fields.totalCopies - (book.totalCopies - book.availableCopies);
    if (changes.availableCopies < 0) throw new ApiError("CONFLICT");
  }
  const updated = await updateOwnedBook(book, user.id, changes);
  if (!updated) throw new ApiError("CONFLICT");
  return serializeBook(updated);
}
export async function deleteBook(id, user) {
  const book = await requireOwner(id, user);
  if (book.availableCopies !== book.totalCopies) throw new ApiError("CONFLICT");
  if (!await deleteOwnedBook(book, user.id)) throw new ApiError("CONFLICT");
  return { _id: id.toHexString(), deleted: true };
}
