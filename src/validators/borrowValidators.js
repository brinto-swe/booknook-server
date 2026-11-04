import { ObjectId } from "mongodb";
import { z } from "zod";
import { ApiError } from "../utils/apiError.js";
import { validateBookId, validateBookQuery } from "./bookValidators.js";

const createSchema = z.strictObject({ bookId: z.string() });
export function validateCreateBorrow(body) {
  const result = createSchema.safeParse(body);
  if (!result.success) throw new ApiError("VALIDATION_ERROR");
  return { bookId: validateBookId({ id: result.data.bookId }).id };
}
export function validateBorrowId(params) {
  if (typeof params.id !== "string" || !/^[a-fA-F0-9]{24}$/.test(params.id)) throw new ApiError("INVALID_BORROW_ID");
  return { id: new ObjectId(params.id) };
}
export function validateBorrowQuery(query) {
  if (Object.keys(query).some(key => !["page", "limit"].includes(key))) throw new ApiError("VALIDATION_ERROR");
  return validateBookQuery(query);
}
export function dueDate(borrowDate) {
  const date = new Date(borrowDate);
  date.setUTCDate(date.getUTCDate() + 7);
  return date;
}
export function serializeBorrow(document) {
  const fail = () => { throw new ApiError("INVALID_BORROW_DATA"); };
  if (!(document?._id instanceof ObjectId) || !(document.bookId instanceof ObjectId)) fail();
  for (const key of ["bookTitle", "bookImage", "userId", "userName", "userEmail"]) {
    if (typeof document[key] !== "string" || !document[key].trim()) fail();
  }
  let image;
  try { image = new URL(document.bookImage); } catch { fail(); }
  if (!["http:", "https:"].includes(image.protocol) || image.username || image.password) fail();
  for (const key of ["borrowDate", "returnDate", "createdAt", "updatedAt"]) {
    if (!(document[key] instanceof Date) || !Number.isFinite(document[key].getTime())) fail();
  }
  if (document.returnDate.getTime() !== dueDate(document.borrowDate).getTime()) fail();
  if (!["borrowed", "returned"].includes(document.status)) fail();
  if (document.status === "borrowed" ? document.returnedAt !== null :
    !(document.returnedAt instanceof Date) || !Number.isFinite(document.returnedAt.getTime())) fail();
  return {
    _id: document._id.toHexString(), bookId: document.bookId.toHexString(),
    bookTitle: document.bookTitle, bookImage: document.bookImage,
    userId: document.userId, userName: document.userName, userEmail: document.userEmail,
    borrowDate: document.borrowDate.toISOString(), returnDate: document.returnDate.toISOString(),
    returnedAt: document.returnedAt?.toISOString() ?? null, status: document.status,
    createdAt: document.createdAt.toISOString(), updatedAt: document.updatedAt.toISOString(),
  };
}
