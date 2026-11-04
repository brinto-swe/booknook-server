import { createHash } from "node:crypto";
import { getDatabase } from "../config/database.js";
import { ensureIndexes } from "../config/indexes.js";
import { ApiError } from "../utils/apiError.js";
export const RATE_LIMIT_INDEXES = Object.freeze([{ name: "rate_limits_expiry", key: { resetTime: 1 }, expireAfterSeconds: 0 }]);
export const ensureRateLimitIndexes = (database = getDatabase()) => ensureIndexes(database, "rate_limits", RATE_LIMIT_INDEXES);

// Shared fixed-window counters. MongoDB's clock and one atomic pipeline decide
// expiry; TTL is cleanup only and is never relied on to reset a window.
export class MongoRateLimitStore {
  constructor(database = getDatabase) { this.database = database; this.prefix = "booknook-api-v1"; this.localKeys = false; }
  init({ windowMs }) { this.windowMs = windowMs; }
  key(key) { return createHash("sha256").update(`${this.prefix}:${this.windowMs}:${key}`).digest("hex"); }
  async increment(key) {
    try {
      const database = this.database();
      await ensureRateLimitIndexes(database);
      const expired = { $lte: [{ $ifNull: ["$resetTime", new Date(0)] }, "$$NOW"] };
      const update = [{ $set: {
        totalHits: { $cond: [expired, 1, { $add: ["$totalHits", 1] }] },
        resetTime: { $cond: [expired, { $add: ["$$NOW", this.windowMs] }, "$resetTime"] },
      } }];
      const collection = database.collection("rate_limits");
      let document;
      try { document = await collection.findOneAndUpdate({ _id: this.key(key) }, update, { upsert: true, returnDocument: "after", maxTimeMS: 5000 }); }
      catch (error) {
        if (error.code !== 11000) throw error;
        // Two cold instances may race to insert the same new counter.
        document = await collection.findOneAndUpdate({ _id: this.key(key) }, update, { upsert: true, returnDocument: "after", maxTimeMS: 5000 });
      }
      if (!Number.isSafeInteger(document?.totalHits) || document.totalHits < 1 || !(document.resetTime instanceof Date) || !Number.isFinite(document.resetTime.getTime())) throw new Error("Invalid rate-limit counter.");
      return { totalHits: document.totalHits, resetTime: document.resetTime };
    } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError("SERVICE_UNAVAILABLE"); }
  }
  async decrement(key) {
    try { await this.database().collection("rate_limits").updateOne({ _id: this.key(key), totalHits: { $gt: 0 } }, { $inc: { totalHits: -1 } }, { maxTimeMS: 5000 }); }
    catch { throw new ApiError("SERVICE_UNAVAILABLE"); }
  }
  async resetKey(key) {
    try { await this.database().collection("rate_limits").deleteOne({ _id: this.key(key) }, { maxTimeMS: 5000 }); }
    catch { throw new ApiError("SERVICE_UNAVAILABLE"); }
  }
}
