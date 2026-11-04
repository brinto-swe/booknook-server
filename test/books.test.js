import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import { createApp } from "../src/app.js";
import { connectDatabase, closeDatabase } from "../src/config/database.js";
import { ensureBookIndexes } from "../src/persistence/bookRepository.js";
import { serializeBook, validateBookQuery, validateBookId, BOOK_CATEGORIES } from "../src/validators/bookValidators.js";
import { createBookRoutes } from "../src/routes/bookRoutes.js";
import { errorHandler } from "../src/middleware/errorHandler.js";

function book(id, category = "Fiction", addedAt = new Date("2026-11-01T00:00:00Z")) {
  return {
    _id: new ObjectId(id), title: "A Library Book", author: "A Writer", category,
    description: "A thoughtful journey through stories.", imageUrl: "https://example.com/book.jpg",
    totalCopies: 3, availableCopies: 2, addedAt,
    ownerEmail: "private@example.com", internal: "SECRET sentinel",
  };
}

test("book document schema and safe serialization", () => {
  const valid = book("000000000000000000000001");
  assert.equal(serializeBook(valid)._id, valid._id.toHexString());
  assert.equal(serializeBook(valid).addedAt, valid.addedAt.toISOString());
  assert.equal(serializeBook(valid).ownerEmail, undefined);
  for (const category of BOOK_CATEGORIES) assert.equal(serializeBook({ ...valid, category }).category, category);
  for (const patch of [
    { _id: "invalid" }, { title: " " }, { author: null }, { description: "" },
    { category: "Poetry" }, { imageUrl: "javascript:alert(1)" },
    { imageUrl: "https://user:password@example.com/book" }, { imageUrl: "bad" },
    { totalCopies: -1 }, { totalCopies: 2.1 }, { availableCopies: -1 },
    { availableCopies: 4 }, { availableCopies: "2" },
    { addedAt: "2026-11-01" }, { addedAt: new Date("invalid") },
  ]) {
    assert.throws(() => serializeBook({ ...valid, ...patch }), { code: "INVALID_BOOK_DATA", status: 500 });
  }
  assert.equal(serializeBook({ ...valid, totalCopies: 0, availableCopies: 0 }).availableCopies, 0);
});

test("query and ObjectId validation boundaries", () => {
  assert.deepEqual(validateBookQuery({}), { page: 1, limit: 12 });
  assert.equal(validateBookQuery({ page: "2", limit: "100" }).page, 2);
  assert.equal(validateBookQuery({ page: "1000000", limit: "1" }).page, 1000000);
  assert.equal(validateBookId({ id: "ABCDEF0123456789ABCDEF01" }).id.toHexString(), "abcdef0123456789abcdef01");
  for (const query of [
    { page: "0" }, { page: "-1" }, { page: "1.5" }, { page: "1e2" },
    { page: "01" }, { page: "9007199254740992" }, { limit: "101" },
    { limit: "0" }, { limit: "" }, { page: "1000000", limit: "100" },
    { category: "fiction" }, { category: ["Fiction", "Kids"] },
    { page: ["1", "2"] }, { category: { $ne: "Kids" } }, { email: "someone@example.com" },
  ]) assert.throws(() => validateBookQuery(query), { code: "VALIDATION_ERROR" });
  for (const id of ["bad", "a".repeat(23), "g".repeat(24), 123, undefined]) {
    assert.throws(() => validateBookId({ id }), { code: "INVALID_BOOK_ID" });
  }
});

test("read endpoints over HTTP with mocked native MongoDB persistence", async (t) => {
  const previousEnvironment = { ...process.env };
  t.after(() => { process.env = previousEnvironment; });
  process.env.CLIENT_URL = "http://localhost:3000";
  process.env.MONGODB_URI = "mongodb://127.0.0.1:27017";
  process.env.DB_NAME = "books_test";
  const documents = [
    book("000000000000000000000001"),
    book("000000000000000000000002", "Science"),
    book("000000000000000000000003", "Fiction", new Date("2026-11-02T00:00:00Z")),
  ];
  let failure;
  let indexCalls = 0;
  let lastFilter;
  let lastSort;
  let malformed = false;
  const fail = operation => { if (failure === operation) throw new Error("SECRET mongodb://user:password@private-host"); };
  const collection = {
    async createIndexes(definitions) {
      indexCalls++;
      fail("indexes");
      assert.deepEqual(definitions.map(value => value.key), [
        { addedAt: -1, _id: -1 }, { category: 1, addedAt: -1, _id: -1 },
        { addedByUserId: 1, addedAt: -1, _id: -1 },
      ]);
    },
    find(filter, options) {
      lastFilter = filter;
      assert.equal(options.projection.ownerEmail, undefined);
      assert.equal(options.maxTimeMS, 5000);
      let skip = 0;
      let limit;
      return {
        sort(value) { lastSort = value; return this; },
        skip(value) { skip = value; return this; },
        limit(value) { limit = value; return this; },
        async toArray() {
          fail("find");
          const matching = documents.filter(value => !filter.category || value.category === filter.category);
          matching.sort((a, b) => b.addedAt - a.addedAt || b._id.toHexString().localeCompare(a._id.toHexString()));
          return matching.slice(skip, skip + limit).map(value => malformed ? { ...value, availableCopies: -1 } : value);
        },
      };
    },
    async countDocuments(filter) {
      fail("count");
      return documents.filter(value => !filter.category || value.category === filter.category).length;
    },
    async findOne(filter, options) {
      fail("detail");
      assert.ok(filter._id instanceof ObjectId);
      assert.equal(options.projection.internal, undefined);
      return documents.find(value => value._id.equals(filter._id)) ?? null;
    },
  };
  t.mock.method(MongoClient.prototype, "connect", async function () { return this; });
  t.mock.method(MongoClient.prototype, "close", async () => {});
  t.mock.method(MongoClient.prototype, "db", () => ({
    command: async () => ({ ok: 1 }),
    collection(name) { assert.equal(name, "books"); return collection; },
  }));
  const logs = [];
  t.mock.method(console, "error", message => logs.push(message));
  await connectDatabase();
  t.after(closeDatabase);

  // The private router is mounted only in this test harness, never the real app.
  const app = createApp();
  const detail = express();
  detail.use(createBookRoutes((_req, _res, next) => next()));
  detail.use(errorHandler);
  async function listen(application) {
    const server = application.listen(0, "127.0.0.1");
    t.after(() => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }));
    await once(server, "listening");
    return `http://127.0.0.1:${server.address().port}`;
  }
  const origin = await listen(app);
  const detailOrigin = await listen(detail);

  await t.test("index failures are safe and retried", async () => {
    failure = "indexes";
    const response = await fetch(`${origin}/books`);
    assert.equal(response.status, 500);
    assert.equal((await response.json()).error.code, "INTERNAL_ERROR");
    failure = undefined;
    await Promise.all([ensureBookIndexes(), ensureBookIndexes()]);
    assert.equal(indexCalls, 2);
  });
  await t.test("default listing is deterministic and excludes private fields", async () => {
    const response = await fetch(`${origin}/books`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.deepEqual(body.data.pagination, { page: 1, limit: 12, total: 3, totalPages: 1 });
    assert.deepEqual(body.data.books.map(value => value._id), [documents[2], documents[1], documents[0]].map(value => value._id.toHexString()));
    assert.deepEqual(lastSort, { addedAt: -1, _id: -1 });
    assert.deepEqual(lastFilter, {});
    assert.ok(!JSON.stringify(body).includes("private@example.com"));
    assert.ok(!JSON.stringify(body).includes("SECRET"));
    assert.equal(indexCalls, 2);
    assert.equal((await fetch(`${origin}/books/`)).status, 200);
  });
  await t.test("category filtering, page boundaries, and empty results", async () => {
    const response = await fetch(`${origin}/books?category=Fiction&page=2&limit=1`);
    const body = await response.json();
    assert.deepEqual(lastFilter, { category: "Fiction" });
    assert.equal(body.data.books[0]._id, documents[0]._id.toHexString());
    assert.deepEqual(body.data.pagination, { page: 2, limit: 1, total: 2, totalPages: 2 });
    const beyond = await (await fetch(`${origin}/books?page=99&limit=1`)).json();
    assert.deepEqual(beyond.data.books, []);
    assert.equal(beyond.data.pagination.total, 3);
    const empty = await (await fetch(`${origin}/books?category=Kids`)).json();
    assert.deepEqual(empty.data.books, []);
    assert.equal(empty.data.pagination.totalPages, 0);
    const latest = await (await fetch(`${origin}/books?limit=6`)).json();
    assert.equal(latest.data.pagination.limit, 6);
  });
  await t.test("invalid HTTP queries fail consistently", async () => {
    for (const query of ["page=0", "limit=101", "category=Invalid", "page=1&page=2", "category=Fiction&category=Kids", "category[$ne]=Kids", "$where=anything"]) {
      const response = await fetch(`${origin}/books?${query}`);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, "VALIDATION_ERROR");
    }
  });
  await t.test("single book, invalid IDs, and missing books", async () => {
    const found = await fetch(`${detailOrigin}/books/${documents[0]._id}`);
    assert.equal(found.status, 200);
    assert.deepEqual((await found.json()).data, serializeBook(documents[0]));
    for (const id of ["invalid", "g".repeat(24)]) {
      const invalid = await fetch(`${detailOrigin}/books/${id}`);
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).error.code, "INVALID_BOOK_ID");
    }
    const missing = await fetch(`${detailOrigin}/books/ffffffffffffffffffffffff`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "BOOK_NOT_FOUND");
  });
  await t.test("find, count, and detail database failures remain safe", async () => {
    for (const operation of ["find", "count", "detail"]) {
      failure = operation;
      const path = operation === "detail" ? `${detailOrigin}/books/${documents[0]._id}` : `${origin}/books`;
      const response = await fetch(path);
      assert.equal(response.status, 500);
      const body = await response.json();
      assert.equal(body.error.code, "INTERNAL_ERROR");
      assert.ok(!JSON.stringify(body).includes("SECRET"));
    }
    failure = undefined;
    assert.ok(logs.length >= 4 && logs.every(value => !value.includes("SECRET") && !value.includes("private-host")));
  });
  await t.test("malformed stored inventory fails with a server error", async () => {
    malformed = true;
    const response = await fetch(`${origin}/books`);
    assert.equal(response.status, 500);
    assert.equal((await response.json()).error.code, "INVALID_BOOK_DATA");
    malformed = false;
  });
  await t.test("mutation routes require authentication", async () => {
    for (const method of ["POST", "PATCH", "DELETE"]) {
      const response = await fetch(`${origin}${method === "POST" ? "/books" : "/books/000000000000000000000001"}`, { method });
      assert.equal(response.status, 401);
    }
  });
  await t.test("single-book router requires authentication in the application", async () => {
    const response = await fetch(`${origin}/books/${documents[0]._id}`);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "UNAUTHORIZED");
  });
});
