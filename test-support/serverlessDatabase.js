import { BOOK_INDEXES } from "../src/persistence/bookRepository.js";
import { BORROW_INDEXES } from "../src/persistence/borrowRepository.js";
import { RATE_LIMIT_INDEXES } from "../src/persistence/rateLimitStore.js";

export function makeServerlessDatabase() {
  const counters = new Map();
  const indexes = { books: BOOK_INDEXES, borrows: BORROW_INDEXES, rate_limits: RATE_LIMIT_INDEXES };
  const stats = { connects: 0, closes: 0, metadata: 0, creates: 0, failConnect: false, failCounter: false, duplicateInsert: false, now: Date.now() };
  function evaluate(value, doc, now) {
    if (value === "$$NOW") return now;
    if (typeof value === "string" && value.startsWith("$")) return doc[value.slice(1)];
    if (!value || typeof value !== "object" || value instanceof Date) return value;
    const args = Object.values(value)[0];
    if ("$cond" in value) return evaluate(args[evaluate(args[0],doc,now) ? 1 : 2],doc,now);
    if ("$ifNull" in value) return evaluate(args[0],doc,now) ?? evaluate(args[1],doc,now);
    if ("$lte" in value) return evaluate(args[0],doc,now) <= evaluate(args[1],doc,now);
    if ("$add" in value) { const a=evaluate(args[0],doc,now), b=evaluate(args[1],doc,now); return a instanceof Date ? new Date(a.getTime()+b) : a+b; }
    throw new Error("Unexpected test expression");
  }
  const db = { counters, indexes, stats,
    command: async () => ({ok:1}),
    collection(name) {
      return {
        listIndexes() { stats.metadata++; return { async toArray() { if (!indexes[name]) { const e=new Error("Missing namespace");e.code=26;throw e; } return indexes[name]; } }; },
        async createIndexes() { stats.creates++; throw new Error("Production must not create indexes"); },
        find() { return {sort(){return this;},skip(){return this;},limit(){return this;},async toArray(){return [];}}; },
        async countDocuments(){return 0;},
        async findOne(){return null;},
        async findOneAndUpdate(filter, pipeline) {
          if(stats.failCounter)throw new Error("SECRET rate-limit connection details");
          if(stats.duplicateInsert){stats.duplicateInsert=false;const e=new Error("SECRET duplicate key");e.code=11000;throw e;}
          const previous=counters.get(filter._id) ?? {_id:filter._id};
          const next={...previous};for(const [key,value]of Object.entries(pipeline[0].$set))next[key]=evaluate(value,previous,new Date(stats.now));
          counters.set(filter._id,next);return {...next};
        },
        async updateOne(filter, update) {const doc=counters.get(filter._id);if(doc&&doc.totalHits>0)doc.totalHits+=update.$inc.totalHits;},
        async deleteOne(filter){counters.delete(filter._id);},
      };
    },
  };
  return db;
}
