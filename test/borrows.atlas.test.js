import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { connectDatabase, closeDatabase, withDatabaseTransaction } from "../src/config/database.js";
import { createBorrowService } from "../src/services/borrowService.js";
import { safeErrorDetails } from "../src/config/diagnostics.js";
import { configureDns } from "../src/config/dns.js";

// Explicit opt-in only; default node --test never loads local credentials or Atlas.
test("Atlas Borrow transactions: commits, rollback, uniqueness and real contention", {
  skip: process.env.RUN_ATLAS_TRANSACTION_TESTS !== "1", timeout: 120000,
}, async () => {
  const prefix = `booknook_tx_test_${randomUUID().replaceAll("-", "")}`;
  const created = [];
  let db;
  let stage = "connection";
  let cleanupFailed = false;
  try {
    const { default: dotenv } = await import("dotenv");
    dotenv.config({ quiet: true }); // Runtime loading only; never print configuration.
    configureDns(); db = await connectDatabase();
    for (const name of ["books", "borrows"]) {
      await db.createCollection(`${prefix}_${name}`); created.push(`${prefix}_${name}`);
    }
    const books = db.collection(`${prefix}_books`), borrows = db.collection(`${prefix}_borrows`);
    let failInsert = false, failRestore = false, ignoreActive = false;
    const isolated = { collection(name) {
      assert.ok(["books", "borrows"].includes(name));
      const collection = name === "books" ? books : borrows;
      return new Proxy(collection, { get(target, prop) {
        if (name === "borrows" && prop === "findOne") return async (filter, options) => ignoreActive && filter.status === "borrowed" ? null : target.findOne(filter, options);
        if (name === "borrows" && prop === "insertOne") return async (...args) => {
          const result = await target.insertOne(...args);
          if (failInsert) throw new Error("Injected rollback");
          return result;
        };
        if (name === "books" && prop === "updateOne") return async (...args) => {
          const result = await target.updateOne(...args);
          if (failRestore && args[1].$inc?.availableCopies === 1) throw new Error("Injected rollback");
          return result;
        };
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    } };
    const first = { id: new ObjectId().toHexString(), email: "first@example.test" };
    const second = { id: new ObjectId().toHexString(), email: "second@example.test" };
    const service = createBorrowService({ database: () => isolated,
      transact: operation => withDatabaseTransaction((_db, session) => operation(isolated, session)),
      findUser: async id => ({ name: "Transaction test reader", email: id === first.id ? first.email : second.email }),
    });
    async function book(copies) {
      const date = new Date();
      const document = { _id: new ObjectId(), title: "Temporary transaction fixture", author: "Test Author", category: "Science",
        image: "https://example.test/cover.jpg", description: "Isolated test fixture, removed after the test.",
        totalCopies: copies, availableCopies: copies, addedByUserId: first.id, addedByName: "Test reader", addedByEmail: first.email,
        addedAt: date, createdAt: date, updatedAt: date };
      await books.insertOne(document); return document;
    }
    stage = "commit and UTC dates";
    const b = await book(3);
    const record = await service.borrow({ bookId: b._id }, first);
    assert.equal((await books.findOne({ _id: b._id })).availableCopies, 2);
    assert.equal(await borrows.countDocuments({ _id: new ObjectId(record._id) }), 1);
    assert.equal(Date.parse(record.returnDate) - Date.parse(record.borrowDate), 7 * 86400000);
    assert.equal(record.returnedAt, null);
    await books.updateOne({ _id: b._id }, { $set: { title: "Changed after loan" } });
    assert.equal((await service.list({ page: 1, limit: 12 }, first)).borrows[0].bookTitle, b.title);
    stage = "unique partial index rollback";
    ignoreActive = true;
    await assert.rejects(service.borrow({ bookId: b._id }, first), { code: "DUPLICATE_BORROW" });
    ignoreActive = false;
    assert.equal((await books.findOne({ _id: b._id })).availableCopies, 2);
    assert.equal(await borrows.countDocuments({ bookId: b._id, status: "borrowed" }), 1);
    stage = "borrow rollback after both writes";
    const rollbackBook = await book(2);
    failInsert = true;
    await assert.rejects(service.borrow({ bookId: rollbackBook._id }, first), /Injected rollback/);
    failInsert = false;
    assert.equal((await books.findOne({ _id: rollbackBook._id })).availableCopies, 2);
    assert.equal(await borrows.countDocuments({ bookId: rollbackBook._id }), 0);
    stage = "return rollback after both writes";
    failRestore = true;
    await assert.rejects(service.returnBook(new ObjectId(record._id), first), /Injected rollback/);
    failRestore = false;
    assert.equal((await books.findOne({ _id: b._id })).availableCopies, 2);
    assert.equal((await borrows.findOne({ _id: new ObjectId(record._id) })).status, "borrowed");
    stage = "two users competing for last copy";
    const last = await book(1);
    const competing = await Promise.allSettled([service.borrow({ bookId: last._id }, first), service.borrow({ bookId: last._id }, second)]);
    assert.equal(competing.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(competing.find(r => r.status === "rejected").reason.code, "BOOK_UNAVAILABLE");
    assert.equal((await books.findOne({ _id: last._id })).availableCopies, 0);
    assert.equal(await borrows.countDocuments({ bookId: last._id, status: "borrowed" }), 1);
    stage = "same user concurrent active loans";
    const same = await book(3);
    const duplicates = await Promise.allSettled([service.borrow({ bookId: same._id }, first), service.borrow({ bookId: same._id }, first)]);
    assert.equal(duplicates.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(duplicates.find(r => r.status === "rejected").reason.code, "DUPLICATE_BORROW");
    assert.equal((await books.findOne({ _id: same._id })).availableCopies, 2);
    stage = "concurrent and repeat return";
    const returns = await Promise.allSettled([service.returnBook(new ObjectId(record._id), first), service.returnBook(new ObjectId(record._id), first)]);
    assert.equal(returns.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(returns.find(r => r.status === "rejected").reason.code, "BORROW_ALREADY_RETURNED");
    assert.equal((await books.findOne({ _id: b._id })).availableCopies, 3);
    await assert.rejects(service.returnBook(new ObjectId(record._id), first), { code: "BORROW_ALREADY_RETURNED" });
    assert.equal((await books.findOne({ _id: b._id })).availableCopies, 3);
    assert.ok((await borrows.findOne({ _id: new ObjectId(record._id) })).returnedAt instanceof Date);
    stage = "reborrow after return and history isolation";
    await service.borrow({ bookId: b._id }, first);
    const history = await service.list({ page: 1, limit: 100 }, first);
    assert.ok(history.borrows.every(r => r.userId === first.id));
    assert.ok(history.borrows.some(r => r.status === "returned"));
  } catch (error) {
    console.log(JSON.stringify({ stage, ...safeErrorDetails(error), numericCode: Number.isInteger(error.code) ? error.code : null }));
    // Assertion/driver errors may embed connection info: never forward raw objects.
    throw new Error(`Atlas transaction integration failed at: ${stage}. Driver details suppressed.`);
  } finally {
    if (db) {
      for (const name of created.reverse()) {
        try { await db.collection(name).drop(); } catch (error) { cleanupFailed = true; console.log(JSON.stringify({ stage: "cleanup", ...safeErrorDetails(error), numericCode: Number.isInteger(error.code) ? error.code : null })); }
      }
      if (!cleanupFailed) {
        try { for (const name of created) { if ((await db.listCollections({ name }, { nameOnly: true }).toArray()).length) cleanupFailed = true; } }
        catch (error) { cleanupFailed = true; console.log(JSON.stringify({ stage: "cleanup verification", ...safeErrorDetails(error), numericCode: Number.isInteger(error.code) ? error.code : null })); }
      }
    }
    try { await closeDatabase(); } catch { cleanupFailed = true; }
    if (!cleanupFailed && created.length) console.log("Temporary Atlas fixture collections removed; absence verified.");
    if (cleanupFailed) throw new Error("Temporary Atlas integration collection cleanup needs attention. No driver details logged.");
  }
});
