import { getDatabase } from "../config/database.js";

const projection = {
  _id: 1, title: 1, author: 1, category: 1, description: 1,
  imageUrl: 1, image: 1, totalCopies: 1, availableCopies: 1, addedAt: 1,
  addedByUserId: 1, addedByName: 1, addedByEmail: 1, createdAt: 1, updatedAt: 1,
};
const indexPromises = new WeakMap();
export function ensureBookIndexes(database = getDatabase()) {
  if (!indexPromises.has(database)) {
    const promise = Promise.resolve().then(() => database.collection("books").createIndexes([
      { name: "books_latest", key: { addedAt: -1, _id: -1 } },
      { name: "books_category_latest", key: { category: 1, addedAt: -1, _id: -1 } },
      { name: "books_owner_latest", key: { addedByUserId: 1, addedAt: -1, _id: -1 } },
    ])).catch(error => { indexPromises.delete(database); throw error; });
    indexPromises.set(database, promise);
  }
  return indexPromises.get(database);
}
export async function findBooks({ page, limit, category, ownerId }) {
  const database = getDatabase();
  await ensureBookIndexes(database);
  const collection = database.collection("books");
  const filter = { ...(category === undefined ? {} : { category }), ...(ownerId === undefined ? {} : { addedByUserId: ownerId }) };
  const [books, total] = await Promise.all([
    collection.find(filter, { projection, maxTimeMS: 5000 })
      .sort({ addedAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
    collection.countDocuments(filter, { maxTimeMS: 5000 }),
  ]);
  return { books, total };
}
export async function findBookById(id, { database = getDatabase(), session } = {}) {
  return database.collection("books").findOne({ _id: id }, { projection, maxTimeMS: 5000, ...(session ? { session } : {}) });
}
export async function insertBook(document) {
  const database = getDatabase();
  await ensureBookIndexes(database);
  const { insertedId } = await database.collection("books").insertOne(document, { maxTimeMS: 5000 });
  return { ...document, _id: insertedId };
}
// Compare both inventory values at the write, not just during the preceding read.
// A concurrent borrow/return or copy edit causes a conflict rather than a lost update.
function inventoryFilter(book, ownerId) {
  return { _id: book._id, addedByUserId: ownerId, totalCopies: book.totalCopies, availableCopies: book.availableCopies };
}
export async function updateOwnedBook(book, ownerId, fields) {
  return getDatabase().collection("books").findOneAndUpdate(inventoryFilter(book, ownerId),
    { $set: fields }, { returnDocument: "after", projection, maxTimeMS: 5000 });
}
export async function deleteOwnedBook(book, ownerId) {
  const result = await getDatabase().collection("books").deleteOne(inventoryFilter(book, ownerId), { maxTimeMS: 5000 });
  return result.deletedCount === 1;
}

// Inventory mutations participate in the caller's transaction.
export async function reserveBookCopy(id, session, database = getDatabase()) {
  const result = await database.collection("books").updateOne({ _id: id, availableCopies: { $gt: 0 },
    $expr: { $lte: ["$availableCopies", "$totalCopies"] } },
    { $inc: { availableCopies: -1 }, $set: { updatedAt: new Date() } }, { session, maxTimeMS: 5000 });
  return result.modifiedCount === 1;
}
export async function restoreBookCopy(id, session, database = getDatabase()) {
  const result = await database.collection("books").updateOne({ _id: id, availableCopies: { $gte: 0 },
    $expr: { $lt: ["$availableCopies", "$totalCopies"] } },
    { $inc: { availableCopies: 1 }, $set: { updatedAt: new Date() } }, { session, maxTimeMS: 5000 });
  return result.modifiedCount === 1;
}
