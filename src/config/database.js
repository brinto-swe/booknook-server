import { MongoClient } from "mongodb";
import { safeErrorDetails } from "./diagnostics.js";

let client;
let database;
let connectionPromise;

export async function connectDatabase() {
  if (database) return database;
  if (connectionPromise) return connectionPromise;

  const { MONGODB_URI, DB_NAME } = process.env;
  if (!MONGODB_URI?.trim() || !DB_NAME?.trim()) {
    throw new Error("MONGODB_URI and DB_NAME are required.");
  }

  connectionPromise = (async () => {
    try {
      client = new MongoClient(MONGODB_URI, {
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000,
      });
      await client.connect();
      const connectedDatabase = client.db(DB_NAME);
      await connectedDatabase.command({ ping: 1 }, { timeoutMS: 5000 });
      database = connectedDatabase;
      return database;
    } catch (error) {
      // Driver errors can contain connection details; never log or forward them.
      await client?.close().catch(() => {});
      client = undefined;
      database = undefined;
      const details = safeErrorDetails(error);
      const safeError = new Error(details.message);
      safeError.name = details.name;
      safeError.code = details.code;
      throw safeError;
    }
  })();

  try {
    return await connectionPromise;
  } finally {
    connectionPromise = undefined;
  }
}

export function getDatabase() {
  if (!database) throw new Error("MongoDB is not connected.");
  return database;
}

export async function closeDatabase() {
  // Let an in-flight connection settle before closing its client.
  await connectionPromise?.catch(() => {});
  database = undefined;
  const connectedClient = client;
  client = undefined;
  await connectedClient?.close();
}

// Reuse the connected client; never create a second pool for transactions.
const transactionChecks = new WeakMap();
export async function withDatabaseTransaction(operation) {
  const connectedDatabase = getDatabase();
  if (!transactionChecks.has(connectedDatabase)) {
    const check = connectedDatabase.admin().command({ hello: 1 }, { maxTimeMS: 5000 }).then(hello => {
      if (!(hello.setName || hello.msg === "isdbgrid") || hello.logicalSessionTimeoutMinutes == null) {
        const error = new Error("MongoDB transactions are required for inventory operations.");
        error.code = "TRANSACTIONS_UNAVAILABLE";
        throw error;
      }
    }).catch(error => { transactionChecks.delete(connectedDatabase); throw error; });
    transactionChecks.set(connectedDatabase, check);
  }
  await transactionChecks.get(connectedDatabase);
  const session = client.startSession();
  try {
    return await session.withTransaction(() => operation(connectedDatabase, session), {
      readPreference: "primary", readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" }, maxCommitTimeMS: 5000, timeoutMS: 15000,
    });
  } finally {
    await session.endSession();
  }
}
