import { ObjectId } from "mongodb";
import { z } from "zod";
import { ApiError } from "../utils/apiError.js";

export const BOOK_CATEGORIES = Object.freeze(["Fiction", "Science", "History", "Kids", "Others"]);

export function validateBookId(params) {
  if (typeof params.id !== "string" || !/^[a-fA-F0-9]{24}$/.test(params.id)) throw new ApiError("INVALID_BOOK_ID");
  return { id: new ObjectId(params.id) };
}

const imageSchema = z.string().trim().max(2048).refine(value => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
});
const fields = {
  title: z.string().trim().min(1).max(300),
  author: z.string().trim().min(1).max(200),
  category: z.enum(BOOK_CATEGORIES),
  image: imageSchema,
  description: z.string().trim().min(1).max(5000),
  totalCopies: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
};
const createSchema = z.strictObject(fields);
const updateSchema = createSchema.partial().refine(value => Object.keys(value).length > 0);
function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError("VALIDATION_ERROR");
  return result.data;
}
export const validateCreateBook = value => parse(createSchema, value);
export const validateUpdateBook = value => parse(updateSchema, value);

export function validateBookQuery(query) {
  if (Object.keys(query).some(key => !["page", "limit", "category", "mine"].includes(key))) throw new ApiError("VALIDATION_ERROR");
  function integer(value, fallback, maximum) {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) throw new ApiError("VALIDATION_ERROR");
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number > maximum) throw new ApiError("VALIDATION_ERROR");
    return number;
  }
  const page = integer(query.page, 1, 1000000);
  const limit = integer(query.limit, 12, 100);
  if ((page - 1) * limit > 1000000) throw new ApiError("VALIDATION_ERROR");
  if (query.category !== undefined && !BOOK_CATEGORIES.includes(query.category)) throw new ApiError("VALIDATION_ERROR");
  if (query.mine !== undefined && query.mine !== "true") throw new ApiError("VALIDATION_ERROR");
  return { page, limit, ...(query.category === undefined ? {} : { category: query.category }),
    ...(query.mine === undefined ? {} : { mine: true }) };
}

export function serializeBook(document) {
  const fail = () => { throw new ApiError("INVALID_BOOK_DATA"); };
  if (!(document?._id instanceof ObjectId)) fail();
  for (const field of ["title", "author", "description"]) {
    if (typeof document[field] !== "string" || !document[field].trim()) fail();
  }
  if (!BOOK_CATEGORIES.includes(document.category)) fail();
  const image = document.image ?? document.imageUrl;
  if (!imageSchema.safeParse(image).success) fail();
  if (!Number.isSafeInteger(document.totalCopies) || document.totalCopies < 0
    || !Number.isSafeInteger(document.availableCopies) || document.availableCopies < 0
    || document.availableCopies > document.totalCopies) fail();
  const createdAt = document.createdAt ?? document.addedAt;
  const updatedAt = document.updatedAt ?? createdAt;
  for (const date of [createdAt, updatedAt]) if (!(date instanceof Date) || !Number.isFinite(date.getTime())) fail();
  // Existing read-only records remain readable; ownership is never inferred from email.
  const ownership = {};
  for (const key of ["addedByUserId", "addedByName", "addedByEmail"]) {
    if (document[key] !== undefined && (typeof document[key] !== "string" || !document[key].trim())) fail();
    ownership[key] = document[key] ?? null;
  }
  return {
    _id: document._id.toHexString(), title: document.title, author: document.author,
    category: document.category, description: document.description,
    imageUrl: image, addedAt: createdAt.toISOString(),
    image, totalCopies: document.totalCopies, availableCopies: document.availableCopies,
    ...ownership, createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString(),
  };
}
