import { ensureIndexes } from "../config/indexes.js";
import { getDatabase } from "../config/database.js";
const projection = { _id: 1, bookId: 1, bookTitle: 1, bookImage: 1, userId: 1,
  userName: 1, userEmail: 1, borrowDate: 1, returnDate: 1, returnedAt: 1, status: 1, createdAt: 1, updatedAt: 1 };
export const BORROW_INDEXES = Object.freeze([
  { name: "borrows_active_user_book", key: { userId: 1, bookId: 1 }, unique: true, partialFilterExpression: { status: "borrowed" } },
  { name: "borrows_user_latest", key: { userId: 1, borrowDate: -1, _id: -1 } },
]);
export function ensureBorrowIndexes(database = getDatabase()) {
  return ensureIndexes(database, "borrows", BORROW_INDEXES);
}
export function createBorrowRepository(database = getDatabase()) {
  const collection = database.collection("borrows");
  return {
    findActive: (bookId, userId, session) => collection.findOne({ bookId, userId, status: "borrowed" }, { session, projection, maxTimeMS: 5000 }),
    findById: (id, session) => collection.findOne({ _id: id }, { session, projection, maxTimeMS: 5000 }),
    async insert(document, session) {
      await collection.insertOne(document, { session, maxTimeMS: 5000 });
      return document;
    },
    markReturned: (id, userId, now, session) => collection.findOneAndUpdate({ _id: id, userId, status: "borrowed" },
      { $set: { status: "returned", returnedAt: now, updatedAt: now } },
      { session, returnDocument: "after", projection, maxTimeMS: 5000 }),
    async list(userId, { page, limit }) {
      const filter = { userId };
      // Outside transactions: independent reads may run concurrently.
      const [borrows, total] = await Promise.all([
        collection.find(filter, { projection, maxTimeMS: 5000 }).sort({ borrowDate: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
        collection.countDocuments(filter, { maxTimeMS: 5000 }),
      ]);
      return { borrows, total };
    },
  };
}
