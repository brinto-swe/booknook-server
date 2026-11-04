import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { MongoClient, ObjectId } from "mongodb";
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from "jose";
import { createApp } from "../src/app.js";
import { createAuthenticate } from "../src/middleware/authenticate.js";
import { connectDatabase, closeDatabase } from "../src/config/database.js";
import { createBorrowService } from "../src/services/borrowService.js";
import { dueDate, validateBorrowQuery, serializeBorrow } from "../src/validators/borrowValidators.js";
import { makeBorrowDatabase } from "../test-support/borrowDatabase.js";

const firstId = "000000000000000000000001", secondId = "000000000000000000000002";
function fixture(id = new ObjectId(), copies = 2) {
  return { _id:id, title:"A Library Book", author:"A Writer", category:"Fiction", image:"https://example.com/cover.jpg", description:"A shared story.",
    totalCopies:copies, availableCopies:copies, addedByUserId:firstId, addedByName:"First Reader", addedByEmail:"first@example.com", createdAt:new Date(), updatedAt:new Date(), addedAt:new Date() };
}

test("UTC calendar due date and strict history query validation", () => {
  for (const date of ["2024-02-25T12:34:56.789Z","2026-12-29T23:00:00Z","2026-03-07T12:00:00Z"]) {
    const start=new Date(date); assert.equal(dueDate(start)-start,7*86400000); assert.equal(start.toISOString(),date.replace('23:00:00Z','23:00:00.000Z').replace('12:00:00Z','12:00:00.000Z'));
  }
  for (const query of [{userId:firstId},{email:"other@example.com"},{status:"borrowed"},{page:["1","2"]},{limit:"0"}]) assert.throws(()=>validateBorrowQuery(query),{code:"VALIDATION_ERROR"});
});

test("Borrow HTTP, transaction rollback, inventory and authorization contracts", async t => {
  const previous={...process.env}; Object.assign(process.env,{CLIENT_URL:"http://localhost:3000",MONGODB_URI:"mongodb://127.0.0.1:27017",DB_NAME:"borrow_test"});t.after(()=>{process.env=previous;});
  const database=makeBorrowDatabase(); const initial=fixture(); database.state.books.push(initial);
  database.state.user.push({_id:new ObjectId(firstId),name:"First Reader",email:"first@example.com"},{_id:new ObjectId(secondId),name:"Second Reader",email:"second@example.com"});
  t.mock.method(MongoClient.prototype,"connect",async function(){return this;});t.mock.method(MongoClient.prototype,"close",async()=>{});t.mock.method(MongoClient.prototype,"db",()=>database);t.mock.method(MongoClient.prototype,"startSession",()=>database.startSession());
  const logs=[];t.mock.method(console,"error",line=>logs.push(line));await connectDatabase();t.after(closeDatabase);
  const {privateKey,publicKey}=await generateKeyPair("EdDSA");const issuer="http://auth.example.test";
  // Resolve JWK once; the synchronous middleware configuration function cannot await.
  const jwk=await exportJWK(publicKey);const auth=createAuthenticate(()=>({issuer,audience:issuer,jwks:createLocalJWKSet({keys:[{...jwk,kid:"borrow",alg:"EdDSA"}]})}));
  const token=async id=>new SignJWT({email:"verified@example.com"}).setSubject(id).setProtectedHeader({alg:"EdDSA",kid:"borrow"}).setIssuer(issuer).setAudience(issuer).setIssuedAt().setExpirationTime("15m").sign(privateKey);
  const first=await token(firstId),second=await token(secondId);
  const service=createBorrowService({now:()=>new Date("2026-11-05T12:34:56.789Z")});
  const server=createApp({authenticateMiddleware:auth,borrowService:service}).listen(0,"127.0.0.1");await once(server,"listening");t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));const origin=`http://127.0.0.1:${server.address().port}`;
  async function request(method,path,body,jwt=first) {
    const r=await fetch(origin+path,{method,headers:{...(jwt?{Authorization:`Bearer ${jwt}`} : {}),...(body===undefined?{}:{"Content-Type":"application/json"})},...(body===undefined?{}:{body:JSON.stringify(body)})});const json=await r.json();assert.ok(!JSON.stringify(json).includes("SECRET"));return {status:r.status,json,cache:r.headers.get("cache-control")};
  }
  async function error(method,path,body,jwt,status,code) {const r=await request(method,path,body,jwt);assert.equal(r.status,status);assert.equal(r.json.error.code,code);return r;}
  let active;
  await t.test("all borrow endpoints require authentication",async()=>{for(const [method,path,body]of[["POST","/borrows",{bookId:initial._id.toString()}],["GET","/borrows"],["DELETE",`/borrows/${initial._id}`]])await error(method,path,body,null,401,"UNAUTHORIZED");assert.equal(database.stats.sessions,0);});
  await t.test("invalid IDs, bodies, spoofed user/book information and query filters rejected",async()=>{
    for(const body of [{},{bookId:"bad"},{bookId:123},{bookId:initial._id.toString(),userId:secondId},{bookId:initial._id.toString(),bookTitle:"Spoof"}])await error("POST","/borrows",body,first,400,body.bookId==="bad"?"INVALID_BOOK_ID":"VALIDATION_ERROR");
    await error("DELETE","/borrows/bad",undefined,first,400,"INVALID_BORROW_ID");
    for(const q of ["userId="+secondId,"email=other@example.com","page=1&page=2","limit=0"])await error("GET","/borrows?"+q,undefined,first,400,"VALIDATION_ERROR");
  });
  await t.test("nonexistent book does not create a record or alter inventory",async()=>{await error("POST","/borrows",{bookId:new ObjectId().toString()},first,404,"BOOK_NOT_FOUND");assert.equal(database.state.borrows.length,0);assert.equal(database.state.books[0].availableCopies,2);});
  await t.test("successful borrowing snapshots trusted fields and sets seven-day due date",async()=>{
    const r=await request("POST","/borrows",{bookId:initial._id.toString()});assert.equal(r.status,201);assert.equal(r.cache,"no-store");active=r.json.data;assert.equal(active.userId,firstId);assert.equal(active.userName,"First Reader");assert.equal(active.userEmail,"first@example.com");assert.equal(active.bookTitle,initial.title);assert.equal(active.bookImage,initial.image);assert.equal(active.status,"borrowed");assert.equal(active.returnedAt,null);assert.equal(Date.parse(active.returnDate)-Date.parse(active.borrowDate),7*86400000);assert.equal(database.state.books[0].availableCopies,1);
    const unique=database.stats.indexDefinitions.find(i=>i.unique);assert.deepEqual(unique.key,{userId:1,bookId:1});assert.deepEqual(unique.partialFilterExpression,{status:"borrowed"});
  });
  await t.test("duplicate active loan precheck and unique-index race both roll back",async()=>{
    await error("POST","/borrows",{bookId:initial._id.toString()},first,409,"DUPLICATE_BORROW");
    database.stats.ignoreActive=true;await error("POST","/borrows",{bookId:initial._id.toString()},first,409,"DUPLICATE_BORROW");database.stats.ignoreActive=false;
    assert.equal(database.state.borrows.length,1);assert.equal(database.state.books[0].availableCopies,1);
  });
  await t.test("history is current-user-only, paginated and newest-first",async()=>{
    const otherBook=fixture();database.state.books.push(otherBook);await request("POST","/borrows",{bookId:otherBook._id.toString()},second);
    const r=await request("GET","/borrows?page=1&limit=1");assert.equal(r.status,200);assert.equal(r.json.data.borrows.length,1);assert.ok(r.json.data.borrows.every(b=>b.userId===firstId));assert.deepEqual(r.json.data.pagination,{page:1,limit:1,total:1,totalPages:1});
    const empty=await request("GET","/borrows?page=99");assert.deepEqual(empty.json.data.borrows,[]);
  });
  await t.test("other borrower cannot return a record",async()=>{await error("DELETE",`/borrows/${active._id}`,undefined,second,403,"FORBIDDEN");assert.equal(database.state.books[0].availableCopies,1);});
  await t.test("missing return record is 404",async()=>{await error("DELETE",`/borrows/${new ObjectId()}`,undefined,first,404,"BORROW_NOT_FOUND");});
  await t.test("Book PATCH preserves outstanding loans and DELETE rejects active borrowing",async()=>{
    await error("DELETE",`/books/${initial._id}`,undefined,first,409,"CONFLICT");
    const r=await request("PATCH",`/books/${initial._id}`,{totalCopies:3});assert.equal(r.status,200);assert.equal(r.json.data.availableCopies,2);
    await error("PATCH",`/books/${initial._id}`,{totalCopies:0},first,400,"VALIDATION_ERROR");
  });
  await t.test("failed borrow insertion rolls back decrement and partial insert",async()=>{
    const b=fixture();database.state.books.push(b);database.stats.failure="borrows.insertAfter";
    await error("POST","/borrows",{bookId:b._id.toString()},first,500,"INTERNAL_ERROR");database.stats.failure=null;
    assert.equal(database.state.books.find(v=>v._id.equals(b._id)).availableCopies,2);assert.ok(!database.state.borrows.some(v=>v.bookId.equals(b._id)));
  });
  await t.test("failed return after status transition or inventory increment rolls back both",async()=>{
    for(const failure of ["borrows.transitionAfter","books.updateAfter"]){database.stats.failure=failure;await error("DELETE",`/borrows/${active._id}`,undefined,first,500,"INTERNAL_ERROR");database.stats.failure=null;assert.equal(database.state.borrows.find(v=>v._id.toString()===active._id).status,"borrowed");assert.equal(database.state.books[0].availableCopies,2);}
  });
  await t.test("full/missing inventory cannot be incremented and transition is rolled back",async()=>{
    database.state.books[0].availableCopies=3;await error("DELETE",`/borrows/${active._id}`,undefined,first,409,"INVENTORY_CONFLICT");assert.equal(database.state.books[0].availableCopies,3);assert.equal(database.state.borrows.find(v=>v._id.toString()===active._id).status,"borrowed");database.state.books[0].availableCopies=2;
    const removed=database.state.books.shift();await error("DELETE",`/borrows/${active._id}`,undefined,first,409,"INVENTORY_CONFLICT");database.state.books.unshift(removed);
  });
  await t.test("concurrent returns increment exactly once and retain history",async()=>{
    const results=await Promise.all([request("DELETE",`/borrows/${active._id}`),request("DELETE",`/borrows/${active._id}`)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal(database.state.books[0].availableCopies,3);
    const returned=results.find(r=>r.status===200).json.data;assert.equal(returned.status,"returned");assert.ok(returned.returnedAt);await error("DELETE",`/borrows/${active._id}`,undefined,first,409,"BORROW_ALREADY_RETURNED");assert.equal(database.state.books[0].availableCopies,3);
  });
  await t.test("returned history permits a new active borrow",async()=>{const r=await request("POST","/borrows",{bookId:initial._id.toString()});assert.equal(r.status,201);assert.equal(database.state.borrows.filter(b=>b.userId===firstId&&b.bookId.equals(initial._id)).length,2);const latest=await request("GET","/borrows?page=1&limit=1");assert.equal(latest.json.data.borrows[0]._id,r.json.data._id);assert.equal(latest.json.data.pagination.total,2);const older=await request("GET","/borrows?page=2&limit=1");assert.equal(older.json.data.borrows[0]._id,active._id);});
  await t.test("two users competing for last copy produce one success",async()=>{
    const b=fixture(new ObjectId(),1);database.state.books.push(b);const results=await Promise.all([request("POST","/borrows",{bookId:b._id.toString()},first),request("POST","/borrows",{bookId:b._id.toString()},second)]);assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);assert.equal(database.state.books.find(v=>v._id.equals(b._id)).availableCopies,0);await error("POST","/borrows",{bookId:b._id.toString()},results[0].status===201?second:first,409,"BOOK_UNAVAILABLE");
  });
  await t.test("database history errors and malformed stored records are safe",async()=>{
    database.stats.failure="borrows.list";await error("GET","/borrows",undefined,first,500,"INTERNAL_ERROR");database.stats.failure=null;
    const record=database.state.borrows[0];const prior=record.returnDate;record.returnDate=new Date(0);assert.throws(()=>serializeBorrow(record),{code:"INVALID_BORROW_DATA"});await error("GET","/borrows",undefined,first,500,"INVALID_BORROW_DATA");record.returnDate=prior;
    assert.ok(logs.length>0&&logs.every(v=>!v.includes("SECRET")));
  });
  await t.test("every transaction ends its session",()=>assert.equal(database.stats.sessions,database.stats.ended));
});

test("unsupported topology fails closed without inventory writes or transaction sessions", async t => {
  const previous={...process.env};Object.assign(process.env,{MONGODB_URI:"mongodb://127.0.0.1:27017",DB_NAME:"unsupported_test"});t.after(()=>{process.env=previous;});
  const database=makeBorrowDatabase({supported:false});const book=fixture();database.state.books.push(book);database.state.user.push({_id:new ObjectId(firstId),name:"Reader",email:"reader@example.com"});
  t.mock.method(MongoClient.prototype,"connect",async function(){return this;});t.mock.method(MongoClient.prototype,"close",async()=>{});t.mock.method(MongoClient.prototype,"db",()=>database);t.mock.method(MongoClient.prototype,"startSession",()=>database.startSession());
  await connectDatabase();t.after(closeDatabase);
  await assert.rejects(createBorrowService().borrow({bookId:book._id},{id:firstId}),{code:"TRANSACTIONS_UNAVAILABLE",status:503});
  assert.equal(database.stats.sessions,0);assert.equal(database.state.books[0].availableCopies,2);assert.equal(database.state.borrows.length,0);
});

test("borrow index initialization is shared and retryable after failure", async () => {
  const {ensureBorrowIndexes}=await import("../src/persistence/borrowRepository.js");
  const database=makeBorrowDatabase();database.stats.failure="indexes";
  await assert.rejects(ensureBorrowIndexes(database));database.stats.failure=null;
  await Promise.all([ensureBorrowIndexes(database),ensureBorrowIndexes(database)]);assert.equal(database.stats.indexes,2);
});

test("driver transaction errors map to safe, retry-aware API errors without a fallback", async () => {
  const database=makeBorrowDatabase();
  for(const [failure,code]of[[{code:20},"TRANSACTIONS_UNAVAILABLE"],[{code:303},"TRANSACTIONS_UNAVAILABLE"],[{hasErrorLabel:label=>label==="UnknownTransactionCommitResult"},"TRANSACTION_FAILED"],[{name:"MongoOperationTimeoutError"},"TRANSACTION_FAILED"]]){
    const service=createBorrowService({database:()=>database,transact:async()=>{throw failure;}});
    await assert.rejects(service.returnBook(new ObjectId(),{id:firstId}),{code,status:503});assert.equal(database.state.borrows.length,0);
  }
});
