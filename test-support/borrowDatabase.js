import { BSON, ObjectId } from "mongodb";
const clone = value => BSON.deserialize(BSON.serialize({ value })).value;
function matches(doc, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === "$expr") { const [left, right] = Object.values(value)[0].map(v => doc[v.slice(1)]); return "$lt" in value ? left < right : left <= right; }
    if (value instanceof ObjectId) return value.equals(doc[key]);
    if (value && typeof value === "object") {
      if ("$gt" in value) return doc[key] > value.$gt;
      if ("$gte" in value) return doc[key] >= value.$gte;
    }
    return doc[key] === value;
  });
}
export function makeBorrowDatabase({ supported = true } = {}) {
  let state = { books: [], borrows: [], user: [] };
  let queue = Promise.resolve();
  const stats = { sessions: 0, ended: 0, attempts: 0, indexes: 0, indexDefinitions: [], failure: null, ignoreActive: false };
  function fail(operation) { if (stats.failure === operation) throw new Error("SECRET database failure"); }
  function sessionRequired(options) { if (!options?.session?.active) throw new Error("Missing transaction session"); }
  const database = {
    get state() { return state; }, stats,
    admin() { return { command: async () => ({ ...(supported ? { setName: "test" } : {}), logicalSessionTimeoutMinutes: 30 }) }; },
    command: async () => ({ ok: 1 }),
    collection(name) {
      if (!Object.hasOwn(state, name)) throw new Error("Unexpected test collection");
      return {
        async createIndexes(definitions) { stats.indexes++; fail("indexes"); stats.indexDefinitions.push(...definitions); },
        async findOne(filter) { fail(`${name}.find`); if (stats.ignoreActive && name === "borrows" && filter.status === "borrowed") return null; return clone(state[name].find(d => matches(d, filter)) ?? null); },
        find(filter) {
          let offset = 0, limit = 12, sorting;
          return { sort(value) { sorting = value; return this; }, skip(value) { offset = value; return this; }, limit(value) { limit = value; return this; },
            async toArray() { fail(`${name}.list`); return clone(state[name].filter(d => matches(d, filter)).sort((a,b) => {
              for (const [key, direction] of Object.entries(sorting)) { const av=a[key] instanceof ObjectId ? a[key].toString() : a[key]; const bv=b[key] instanceof ObjectId ? b[key].toString() : b[key]; if (av < bv) return -direction; if (av > bv) return direction; } return 0;
            }).slice(offset, offset + limit)); } };
        },
        async countDocuments(filter) { fail(`${name}.count`); return state[name].filter(d => matches(d, filter)).length; },
        async insertOne(document, options) {
          sessionRequired(options); fail(`${name}.insert`);
          if (name === "borrows" && state.borrows.some(d => d.status === "borrowed" && document.status === "borrowed" && d.userId === document.userId && d.bookId.equals(document.bookId))) { const error = new Error("SECRET duplicate key"); error.code = 11000; throw error; }
          state[name].push(clone(document)); fail(`${name}.insertAfter`); return { insertedId: document._id };
        },
        async updateOne(filter, update, options) {
          sessionRequired(options); fail(`${name}.update`);
          const doc = state[name].find(d => matches(d, filter)); if (!doc) return { modifiedCount: 0 };
          for (const [key, value] of Object.entries(update.$inc ?? {})) doc[key] += value;
          Object.assign(doc, update.$set); fail(`${name}.updateAfter`); return { modifiedCount: 1 };
        },
        async findOneAndUpdate(filter, update, options) {
          if (name === "borrows") sessionRequired(options);
          fail(`${name}.transition`); const doc = state[name].find(d => matches(d, filter)); if (!doc) return null;
          Object.assign(doc, clone(update.$set)); fail(`${name}.transitionAfter`); return clone(doc);
        },
        async deleteOne(filter) { const index=state[name].findIndex(d=>matches(d,filter)); if(index<0)return {deletedCount:0}; state[name].splice(index,1); return {deletedCount:1}; },
      };
    },
    startSession() {
      stats.sessions++;
      return {
        active: false,
        async withTransaction(work, options) {
          if (options.readConcern.level !== "snapshot" || options.writeConcern.w !== "majority" || options.timeoutMS !== 15000) throw new Error("Unexpected transaction options");
          const predecessor = queue; let release; queue = new Promise(r => { release = r; }); await predecessor;
          const snapshot = clone(state); this.active = true; stats.attempts++;
          try { return await work(); } catch (error) { state = snapshot; throw error; }
          finally { this.active = false; release(); }
        },
        async endSession() { stats.ended++; },
      };
    },
  };
  return database;
}
