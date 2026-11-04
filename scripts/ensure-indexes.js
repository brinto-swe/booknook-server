import dotenv from "dotenv";
import { connectDatabase, closeDatabase } from "../src/config/database.js";
import { configureDns } from "../src/config/dns.js";
import { BOOK_INDEXES } from "../src/persistence/bookRepository.js";
import { BORROW_INDEXES } from "../src/persistence/borrowRepository.js";
import { RATE_LIMIT_INDEXES } from "../src/persistence/rateLimitStore.js";
import { verifyIndexes } from "../src/config/indexes.js";

// Explicit operator command, never imported by the app or run during Vercel builds.
dotenv.config({ quiet: true });
try {
  configureDns();
  const database = await connectDatabase();
  for (const [collection, indexes] of [["books", BOOK_INDEXES], ["borrows", BORROW_INDEXES], ["rate_limits", RATE_LIMIT_INDEXES]]) {
    await database.collection(collection).createIndexes(indexes, { maxTimeMS: 60000 });
    await verifyIndexes(database, collection, indexes);
  }
  console.info("Required database indexes provisioned and verified.");
} catch {
  console.error("Index provisioning failed. Check database access and existing index/data compatibility privately.");
  process.exitCode = 1;
} finally {
  try { await closeDatabase(); } catch { console.error("Index provisioning cleanup failed."); process.exitCode = 1; }
}
