import { ObjectId } from "mongodb";
import { ApiError } from "../utils/apiError.js";

export const BOOK_CATEGORIES = Object.freeze(["Fiction", "Science", "History", "Kids", "Others"]);

export function validateBookId(params) {
  if (typeof params.id !== "string" || !/^[a-fA-F0-9]{24}$/.test(params.id)) {
    throw new ApiError("INVALID_BOOK_ID");
  }
  return { id: new ObjectId(params.id) };
}

export function validateBookQuery(query) {
  if (Object.keys(query).some(key => !["page", "limit", "category"].includes(key))) {
    throw new ApiError("VALIDATION_ERROR");
  }
  function integer(value, fallback, maximum) {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
      throw new ApiError("VALIDATION_ERROR");
    }
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number > maximum) throw new ApiError("VALIDATION_ERROR");
    return number;
  }
  const page = integer(query.page, 1, 1000000);
  const limit = integer(query.limit, 12, 100);
  if ((page - 1) * limit > 1000000) throw new ApiError("VALIDATION_ERROR");
  if (query.category !== undefined && !BOOK_CATEGORIES.includes(query.category)) {
    throw new ApiError("VALIDATION_ERROR");
  }
  return { page, limit, ...(query.category === undefined ? {} : { category: query.category }) };
}

// Validate persisted data, not a client mutation payload. Writers are out of scope.
// Malformed stored documents are server failures rather than client 400 errors.
export function serializeBook(document) {
  const fail = () => { throw new ApiError("INVALID_BOOK_DATA"); };
  if (!(document?._id instanceof ObjectId)) fail();
  for (const field of ["title", "author", "description"]) {
    if (typeof document[field] !== "string" || !document[field].trim()) fail();
  }
  if (!BOOK_CATEGORIES.includes(document.category)) fail();
  let image;
  try { image = new URL(document.imageUrl); } catch { fail(); }
  if (typeof document.imageUrl !== "string" || !["http:", "https:"].includes(image.protocol)
    || image.username || image.password) fail();
  if (!Number.isSafeInteger(document.totalCopies) || document.totalCopies < 0
    || !Number.isSafeInteger(document.availableCopies) || document.availableCopies < 0
    || document.availableCopies > document.totalCopies) fail();
  if (!(document.addedAt instanceof Date) || !Number.isFinite(document.addedAt.getTime())) fail();

  return {
    _id: document._id.toHexString(),
    title: document.title,
    author: document.author,
    category: document.category,
    description: document.description,
    imageUrl: document.imageUrl,
    totalCopies: document.totalCopies,
    availableCopies: document.availableCopies,
    addedAt: document.addedAt.toISOString(),
  };
}
