import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { MongoClient, ObjectId } from "mongodb";
import { SignJWT, generateKeyPair, exportJWK, createRemoteJWKSet, customFetch } from "jose";
import { createApp } from "../src/app.js";
import { createAuthenticate } from "../src/middleware/authenticate.js";
import { connectDatabase, closeDatabase } from "../src/config/database.js";

const ownerId = "000000000000000000000001";
const otherId = "000000000000000000000002";
const input = { title: "The Library", author: "A Writer", category: "Fiction",
  image: "https://example.com/cover.jpg", description: "Stories worth sharing.", totalCopies: 5 };

test("Book Management HTTP contracts with signed JWTs and mocked MongoDB", async t => {
  const previous = { ...process.env };
  Object.assign(process.env, { CLIENT_URL: "http://localhost:3000", MONGODB_URI: "mongodb://127.0.0.1:27017", DB_NAME: "book_module_test" });
  t.after(() => { process.env = previous; });
  const documents = [];
  const profiles = [ownerId, otherId].map((id, i) => ({ _id: new ObjectId(id), name: `Reader ${i}`, email: `reader${i}@example.com` }));
  let failure;
  let beforeWrite;
  let writes = 0;
  let profileFilter;
  const fail = op => { if (failure === op) throw new Error("SECRET database detail"); };
  const matches = (doc, filter) => Object.entries(filter).every(([key, value]) => value instanceof ObjectId ? value.equals(doc[key]) : doc[key] === value);
  const books = {
    async createIndexes() {},
    find(filter) {
      let offset = 0, size = 12;
      return { sort() { return this; }, skip(n) { offset = n; return this; }, limit(n) { size = n; return this; },
        async toArray() { fail("find"); return documents.filter(d => matches(d, filter)).sort((a,b) => b.addedAt-a.addedAt || b._id.toString().localeCompare(a._id.toString())).slice(offset, offset+size); } };
    },
    async countDocuments(filter) { fail("count"); return documents.filter(d => matches(d, filter)).length; },
    async findOne(filter) { fail("detail"); const doc = documents.find(d => matches(d, filter)); return doc ? { ...doc } : null; },
    async insertOne(document) { fail("insert"); writes++; const _id = new ObjectId(); documents.push({ ...document, _id }); return { insertedId: _id }; },
    async findOneAndUpdate(filter, update, options) {
      fail("update"); beforeWrite?.();
      assert.equal(options.returnDocument, "after");
      const doc = documents.find(d => matches(d, filter));
      if (!doc) return null;
      writes++; Object.assign(doc, update.$set); return { ...doc };
    },
    async deleteOne(filter) {
      fail("delete"); beforeWrite?.();
      const index = documents.findIndex(d => matches(d, filter));
      if (index < 0) return { deletedCount: 0 };
      writes++; documents.splice(index, 1); return { deletedCount: 1 };
    },
  };
  t.mock.method(MongoClient.prototype, "connect", async function() { return this; });
  t.mock.method(MongoClient.prototype, "close", async () => {});
  t.mock.method(MongoClient.prototype, "db", () => ({ command: async () => ({ok:1}), collection(name) {
    if (name === "books") return books;
    assert.equal(name, "user");
    return { async findOne(filter, options) { fail("profile"); profileFilter = filter; assert.deepEqual(options.projection, { _id:1, name:1, email:1 }); return profiles.find(p => matches(p, filter)) ?? null; } };
  } }));
  const logs = [];
  t.mock.method(console, "error", value => logs.push(value));
  await connectDatabase(); t.after(closeDatabase);
  const keys = await generateKeyPair("EdDSA");
  const wrong = await generateKeyPair("EdDSA");
  const issuer = "http://auth.example.test";
  const jwks = createRemoteJWKSet(new URL(`${issuer}/jwks`), {
    [customFetch]: async () => Response.json({ keys: [{ ...await exportJWK(keys.publicKey), kid:"books", alg:"EdDSA" }] }),
  });
  const authenticateMiddleware = createAuthenticate(() => ({ issuer, audience:issuer, jwks }));
  const server = createApp({ authenticateMiddleware }).listen(0, "127.0.0.1");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function token(id = ownerId, overrides = {}) {
    return new SignJWT({ email: "verified@example.com" }).setProtectedHeader({ alg:"EdDSA", kid:"books" })
      .setSubject(id).setIssuer(overrides.issuer ?? issuer).setAudience(overrides.audience ?? issuer)
      .setIssuedAt().setExpirationTime(overrides.expiry ?? "15m").sign(overrides.key ?? keys.privateKey);
  }
  const owner = await token(), other = await token(otherId);
  async function request(method, path, payload, jwt) {
    const response = await fetch(`${origin}${path}`, { method, headers: {
      ...(jwt ? { Authorization:`Bearer ${jwt}` } : {}), ...(payload !== undefined ? {"Content-Type":"application/json"} : {}),
    }, ...(payload === undefined ? {} : {body:JSON.stringify(payload)}) });
    const body = await response.json();
    assert.ok(!JSON.stringify(body).includes("SECRET"));
    return { status:response.status, body, cache:response.headers.get("cache-control") };
  }
  async function expectError(method, path, payload, jwt, status, code) {
    const r = await request(method,path,payload,jwt);
    assert.equal(r.status,status); assert.equal(r.body.success,false); assert.equal(r.body.error.code,code);
    return r;
  }
  let id;
  await t.test("public listing remains accessible with the original pagination envelope", async () => {
    const r = await request("GET", "/books?page=1&limit=6");
    assert.equal(r.status,200); assert.deepEqual(r.body.data,{ books:[], pagination:{page:1,limit:6,total:0,totalPages:0} });
  });
  await t.test("private routes and mine require authentication before accessing persistence", async () => {
    for (const [method,path,body] of [["GET","/books?mine=true"],["GET",`/books/${ownerId}`],["POST","/books",input],["PATCH",`/books/${ownerId}`,{title:"New"}],["DELETE",`/books/${ownerId}`]])
      await expectError(method,path,body,undefined,401,"UNAUTHORIZED");
    assert.equal(writes,0);
  });
  await t.test("creation initializes inventory, trusted owner fields, and server timestamps", async () => {
    const r = await request("POST","/books",input,owner);
    assert.equal(r.status,201); const b=r.body.data; id=b._id;
    assert.equal(b.availableCopies,5); assert.equal(b.totalCopies,5);
    assert.equal(b.addedByUserId,ownerId); assert.equal(b.addedByName,"Reader 0"); assert.equal(b.addedByEmail,"reader0@example.com");
    assert.ok(profileFilter._id.equals(new ObjectId(ownerId)));
    assert.ok(Number.isFinite(Date.parse(b.createdAt))); assert.equal(b.createdAt,b.updatedAt);
    assert.equal(b.image,input.image); assert.equal(b.imageUrl,input.image); assert.equal(b.addedAt,b.createdAt);
    assert.equal(documents[0].availableCopies,documents[0].totalCopies);
  });
  await t.test("details include all UI fields and disable caching", async () => {
    const r = await request("GET",`/books/${id}`,undefined,other); assert.equal(r.status,200); assert.equal(r.cache,"no-store");
    for (const key of ["image","title","author","category","description","addedByName","addedByEmail","totalCopies","availableCopies"]) assert.ok(key in r.body.data);
  });
  await t.test("invalid category and missing required fields", async () => {
    await expectError("POST","/books",{...input,category:"Poetry"},owner,400,"VALIDATION_ERROR");
    for (const key of Object.keys(input)) { const body={...input}; delete body[key]; await expectError("POST","/books",body,owner,400,"VALIDATION_ERROR"); }
  });
  await t.test("unsafe image URLs and invalid totalCopies rejected", async () => {
    for (const image of ["javascript:alert(1)","data:image/png,test","file:///tmp/a","https://name:password@example.com/a","not-a-url"])
      await expectError("POST","/books",{...input,image},owner,400,"VALIDATION_ERROR");
    for (const totalCopies of [0,-1,1.5,"5",null,Number.MAX_SAFE_INTEGER+1])
      await expectError("POST","/books",{...input,totalCopies},owner,400,"VALIDATION_ERROR");
  });
  await t.test("mass assignment cannot spoof ownership, inventory, dates, or operators", async () => {
    for (const field of ["_id","addedByUserId","addedByName","addedByEmail","availableCopies","createdAt","updatedAt","addedAt","$set"]) {
      await expectError("POST","/books",{...input,[field]:"attacker"},owner,400,"VALIDATION_ERROR");
      await expectError("PATCH",`/books/${id}`,{[field]:"attacker"},owner,400,"VALIDATION_ERROR");
    }
  });
  await t.test("malformed bodies, empty updates, and unknown filters are rejected", async () => {
    await expectError("PATCH",`/books/${id}`,null,owner,400,"INVALID_JSON");
    for (const value of [[],{}, {title:" "}]) await expectError("PATCH",`/books/${id}`,value,owner,400,"VALIDATION_ERROR");
    for (const query of ["mine=false","mine=true&mine=true","addedByUserId=attacker","email=attacker@example.com","category[$ne]=Kids"])
      await expectError("GET",`/books?${query}`,undefined,owner,400,"VALIDATION_ERROR");
  });
  await t.test("all private identifier routes validate IDs and return missing-book errors", async () => {
    for (const method of ["GET","PATCH","DELETE"]) {
      const payload=method === "PATCH" ? {title:"New"} : undefined;
      await expectError(method,"/books/invalid",payload,owner,400,"INVALID_BOOK_ID");
      await expectError(method,"/books/ffffffffffffffffffffffff",payload,owner,404,"BOOK_NOT_FOUND");
    }
  });
  await t.test("mine isolates verified subject and supports category/pagination", async () => {
    const second=await request("POST","/books",{...input,category:"Kids"},other); assert.equal(second.status,201);
    const r=await request("GET","/books?mine=true&category=Fiction&page=1&limit=1",undefined,owner);
    assert.equal(r.status,200); assert.equal(r.cache,"no-store"); assert.deepEqual(r.body.data.books.map(b=>b._id),[id]);
    assert.deepEqual(r.body.data.pagination,{page:1,limit:1,total:1,totalPages:1});
    const otherBooks=await request("GET","/books?mine=true",undefined,other);
    assert.ok(otherBooks.body.data.books.every(b=>b.addedByUserId===otherId));
    const publicBooks=await request("GET","/books?limit=1&page=2"); assert.equal(publicBooks.body.data.pagination.total,2); assert.equal(publicBooks.body.data.books.length,1);
    const filtered=await request("GET","/books?category=Kids"); assert.equal(filtered.body.data.books.length,1);
  });
  await t.test("owner update normalizes fields and preserves immutable ownership", async () => {
    const before={...documents[0]};
    const r=await request("PATCH",`/books/${id}`,{title:"  Revised title  ",image:"https://example.com/new.jpg"},owner);
    assert.equal(r.status,200); assert.equal(r.body.data.title,"Revised title"); assert.equal(r.body.data.availableCopies,5);
    assert.equal(r.body.data.createdAt,before.createdAt.toISOString()); assert.equal(r.body.data.addedByUserId,ownerId);
  });
  await t.test("other users cannot update or delete", async () => {
    const count=writes;
    await expectError("PATCH",`/books/${id}`,{title:"Stolen"},other,403,"FORBIDDEN");
    await expectError("DELETE",`/books/${id}`,undefined,other,403,"FORBIDDEN");
    assert.equal(writes,count);
  });
  await t.test("copy increases and decreases preserve outstanding loans", async () => {
    documents[0].availableCopies=3; // Two outstanding loans; only mocked inventory.
    let r=await request("PATCH",`/books/${id}`,{totalCopies:7},owner); assert.equal(r.status,200); assert.equal(r.body.data.availableCopies,5);
    r=await request("PATCH",`/books/${id}`,{totalCopies:2},owner); assert.equal(r.status,200); assert.equal(r.body.data.availableCopies,0);
    await expectError("PATCH",`/books/${id}`,{totalCopies:1},owner,409,"CONFLICT");
    assert.equal(documents[0].totalCopies,2); assert.equal(documents[0].availableCopies,0);
  });
  await t.test("deletion rejects outstanding copies", async () => {
    await expectError("DELETE",`/books/${id}`,undefined,owner,409,"CONFLICT"); assert.ok(documents.some(b=>b._id.toString()===id));
  });
  await t.test("concurrent inventory changes cause update/delete conflicts without lost copies", async () => {
    documents[0].availableCopies=2;
    beforeWrite=()=>{documents[0].availableCopies--;};
    await expectError("PATCH",`/books/${id}`,{totalCopies:3},owner,409,"CONFLICT");
    assert.equal(documents[0].totalCopies,2); assert.equal(documents[0].availableCopies,1);
    documents[0].availableCopies=2;
    await expectError("DELETE",`/books/${id}`,undefined,owner,409,"CONFLICT");
    assert.equal(documents[0].availableCopies,1); beforeWrite=undefined;
  });
  await t.test("JWT signature, expiry, issuer and audience failures cannot mutate books", async () => {
    for (const overrides of [{key:wrong.privateKey},{expiry:Math.floor(Date.now()/1000)-1},{issuer:"https://wrong.test"},{audience:"https://wrong.test"}])
      await expectError("POST","/books",input,await token(ownerId,overrides),401,"UNAUTHORIZED");
  });
  await t.test("missing trusted profile fails closed", async () => {
    await expectError("POST","/books",input,await token("ffffffffffffffffffffffff"),401,"UNAUTHORIZED");
    await expectError("POST","/books",input,await token("unsupported-id"),401,"UNAUTHORIZED");
  });
  await t.test("database failures use safe JSON errors for reads and writes", async () => {
    for (const [operation,method,path,payload] of [
      ["find","GET","/books"],["count","GET","/books"],["detail","GET",`/books/${id}`],
      ["insert","POST","/books",input],["profile","POST","/books",input],
      ["update","PATCH",`/books/${id}`,{title:"Failure"}],["delete","DELETE",`/books/${id}`],
    ]) {
      documents[0].availableCopies=documents[0].totalCopies;
      failure=operation; await expectError(method,path,payload,owner,500,"INTERNAL_ERROR"); failure=undefined;
    }
    assert.ok(logs.length>=7 && logs.every(line=>!line.includes("SECRET")));
  });
  await t.test("owner deletion succeeds once and repeated deletion returns 404", async () => {
    const r=await request("DELETE",`/books/${id}`,undefined,owner); assert.equal(r.status,200); assert.deepEqual(r.body.data,{_id:id,deleted:true});
    await expectError("DELETE",`/books/${id}`,undefined,owner,404,"BOOK_NOT_FOUND");
  });
  await t.test("existing health remains public and unchanged", async () => {
    const r=await request("GET","/api/health"); assert.equal(r.status,200); assert.deepEqual(r.body,{application:"ok",database:"connected"});
  });
});
