import { ObjectId } from "mongodb";
import { getDatabase, withDatabaseTransaction } from "../config/database.js";
import { createBorrowRepository, ensureBorrowIndexes } from "../persistence/borrowRepository.js";
import { findBookById, reserveBookCopy, restoreBookCopy } from "../persistence/bookRepository.js";
import { findAuthUser } from "../persistence/authUserRepository.js";
import { serializeBook } from "../validators/bookValidators.js";
import { serializeBorrow, dueDate } from "../validators/borrowValidators.js";
import { ApiError } from "../utils/apiError.js";

// Dependencies allow tests to use isolated collections without touching live books/users.
export function createBorrowService({ database = getDatabase, transact = withDatabaseTransaction,
  findUser = findAuthUser, now = () => new Date() } = {}) {
  async function transaction(operation) {
    try { return await transact(operation); } catch (error) {
      if (error.code === 11000) throw new ApiError("DUPLICATE_BORROW");
      if ([20, 303, "TRANSACTIONS_UNAVAILABLE"].includes(error.code)) throw new ApiError("TRANSACTIONS_UNAVAILABLE");
      if (error.hasErrorLabel?.("TransientTransactionError") || error.hasErrorLabel?.("UnknownTransactionCommitResult")
        || error.name === "MongoOperationTimeoutError") throw new ApiError("TRANSACTION_FAILED");
      throw error;
    }
  }
  return {
    async borrow({ bookId }, user) {
      await ensureBorrowIndexes(database());
      const profile = await findUser(user.id);
      if (!profile || typeof profile.name !== "string" || !profile.name.trim()
        || typeof profile.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)) throw new ApiError("UNAUTHORIZED");
      const id = new ObjectId();
      const borrowedAt = now();
      return transaction(async (db, session) => {
        const repo = createBorrowRepository(db);
        const book = await findBookById(bookId, { database: db, session });
        if (!book) throw new ApiError("BOOK_NOT_FOUND");
        const snapshot = serializeBook(book);
        if (await repo.findActive(bookId, user.id, session)) throw new ApiError("DUPLICATE_BORROW");
        if (snapshot.availableCopies === 0) throw new ApiError("BOOK_UNAVAILABLE");
        if (!await reserveBookCopy(bookId, session, db)) throw new ApiError("BOOK_UNAVAILABLE");
        const document = { _id: id, bookId, bookTitle: snapshot.title, bookImage: snapshot.image,
          userId: user.id, userName: profile.name, userEmail: profile.email,
          borrowDate: borrowedAt, returnDate: dueDate(borrowedAt), returnedAt: null,
          status: "borrowed", createdAt: borrowedAt, updatedAt: borrowedAt };
        // Serialize inside the transaction so invalid data cannot commit.
        return serializeBorrow(await repo.insert(document, session));
      });
    },
    async list(query, user) {
      await ensureBorrowIndexes(database());
      const { borrows, total } = await createBorrowRepository(database()).list(user.id, query);
      return { borrows: borrows.map(serializeBorrow), pagination: {
        page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit),
      } };
    },
    async returnBook(id, user) {
      await ensureBorrowIndexes(database());
      return transaction(async (db, session) => {
        const repo = createBorrowRepository(db);
        const record = await repo.findById(id, session);
        if (!record) throw new ApiError("BORROW_NOT_FOUND");
        if (record.userId !== user.id) throw new ApiError("FORBIDDEN");
        serializeBorrow(record);
        if (record.status !== "borrowed") throw new ApiError("BORROW_ALREADY_RETURNED");
        const book = await findBookById(record.bookId, { database: db, session });
        if (!book) throw new ApiError("INVENTORY_CONFLICT");
        serializeBook(book);
        const returned = await repo.markReturned(id, user.id, now(), session);
        if (!returned) throw new ApiError("BORROW_ALREADY_RETURNED");
        if (!await restoreBookCopy(record.bookId, session, db)) throw new ApiError("INVENTORY_CONFLICT");
        return serializeBorrow(returned);
      });
    },
  };
}
export const borrowService = createBorrowService();
