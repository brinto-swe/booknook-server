import { getDatabase } from "../config/database.js";

const projection = {
  _id: 1, title: 1, author: 1, category: 1, description: 1,
  imageUrl: 1, totalCopies: 1, availableCopies: 1, addedAt: 1,
};
const indexPromises = new WeakMap();

export function ensureBookIndexes(database = getDatabase()) {
  if (!indexPromises.has(database)) {
    const promise = Promise.resolve().then(() => database.collection("books").createIndexes([
      { name: "books_latest", key: { addedAt: -1, _id: -1 } },
      { name: "books_category_latest", key: { category: 1, addedAt: -1, _id: -1 } },
    ])).catch(error => {
      indexPromises.delete(database);
      throw error;
    });
    indexPromises.set(database, promise);
  }
  return indexPromises.get(database);
}

export async function findBooks({ page, limit, category }) {
  const database = getDatabase();
  // Initialize once per connected database, without changing startup or health.
  await ensureBookIndexes(database);
  const collection = database.collection("books");
  const filter = category === undefined ? {} : { category };
  const [books, total] = await Promise.all([
    collection.find(filter, { projection, maxTimeMS: 5000 })
      .sort({ addedAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
    collection.countDocuments(filter, { maxTimeMS: 5000 }),
  ]);
  return { books, total };
}

export async function findBookById(id) {
  return getDatabase().collection("books").findOne({ _id: id }, { projection, maxTimeMS: 5000 });
}
