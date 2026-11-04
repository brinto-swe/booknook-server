import { isProductionRuntime } from "./environment.js";
import { ApiError } from "../utils/apiError.js";
const checks = new WeakMap();
export async function verifyIndexes(database, collection, definitions) {
  let existing;
  try { existing = await database.collection(collection).listIndexes({ maxTimeMS: 5000 }).toArray(); }
  catch (error) { if (error.code === 26) throw new ApiError("DATABASE_NOT_READY"); throw error; }
  for (const expected of definitions) {
    const actual = existing.find(index => index.name === expected.name);
    if (!actual || JSON.stringify(actual.key) !== JSON.stringify(expected.key)
      || Boolean(actual.unique) !== Boolean(expected.unique)
      || JSON.stringify(actual.partialFilterExpression) !== JSON.stringify(expected.partialFilterExpression)
      || actual.expireAfterSeconds !== expected.expireAfterSeconds) throw new ApiError("DATABASE_NOT_READY");
  }
}
export function ensureIndexes(database, collection, definitions) {
  if (!checks.has(database)) checks.set(database, new Map());
  const cache = checks.get(database);
  const production = isProductionRuntime();
  const key = `${production}:${collection}`;
  if (!cache.has(key)) {
    const promise = Promise.resolve().then(() => production
      ? verifyIndexes(database, collection, definitions)
      : database.collection(collection).createIndexes(definitions, { maxTimeMS: 10000 }))
      .catch(error => { cache.delete(key); throw error; });
    cache.set(key, promise);
  }
  return cache.get(key);
}
