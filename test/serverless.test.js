import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { MongoClient } from "mongodb";
import app, { createApp } from "../src/app.js";
import { connectDatabase, closeDatabase, getDatabase } from "../src/config/database.js";
import { readRuntimeConfiguration, readLocalPort } from "../src/config/environment.js";
import { ensureBookIndexes } from "../src/persistence/bookRepository.js";
import { MongoRateLimitStore } from "../src/persistence/rateLimitStore.js";
import { clientAddress, createApiRateLimiter } from "../src/middleware/security.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { getHealth } from "../src/services/healthService.js";
import { makeServerlessDatabase } from "../test-support/serverlessDatabase.js";

const production = { NODE_ENV:"production", VERCEL:"1", CLIENT_URL:"https://frontend.example.test",
  MONGODB_URI:"mongodb://127.0.0.1:27017", DB_NAME:"serverless_test", AUTH_ISSUER:"https://auth.example.test",
  AUTH_AUDIENCE:"https://auth.example.test", AUTH_JWKS_URL:"https://auth.example.test/api/auth/jwks" };
async function listen(t, application) {
  const server=application.listen(0,"127.0.0.1");await once(server,"listening");
  t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
  return `http://127.0.0.1:${server.address().port}`;
}
test("default export is an Express app with no import-time listener or database connection", () => {
  assert.equal(typeof app,"function");assert.equal(typeof app.use,"function");assert.equal(typeof app.listen,"function");
  assert.equal(app.get("trust proxy"),false);assert.equal(typeof createApp,"function");assert.throws(getDatabase,/not connected/);
});
test("shared configuration validates runtime without requiring PORT in serverless", () => {
  assert.equal(readRuntimeConfiguration({...production,PORT:"ignored"}).clientOrigin,production.CLIENT_URL);
  assert.equal(readLocalPort({}),5000);assert.throws(()=>readLocalPort({PORT:"invalid"}));
  assert.throws(()=>readRuntimeConfiguration({...production,CLIENT_URL:"http://frontend.example.test"}));
  assert.throws(()=>readRuntimeConfiguration({...production,AUTH_JWKS_URL:undefined}));
});
test("default Vercel-style requests initialize, retry failures, reuse Mongo and preserve health/CORS/contracts", async t => {
  const previous={...process.env};Object.assign(process.env,production);t.after(()=>{process.env=previous;});
  const database=makeServerlessDatabase();
  t.mock.method(console,"error",()=>{});
  t.mock.method(MongoClient.prototype,"connect",async function(){
    database.stats.connects++;
    assert.equal(this.options.maxPoolSize,10);assert.equal(this.options.minPoolSize,0);assert.equal(this.options.maxIdleTimeMS,60000);assert.equal(this.options.waitQueueTimeoutMS,5000);
    await new Promise(r=>setTimeout(r,15));
    if(database.stats.failConnect)throw new Error("SECRET mongodb://private");return this;
  });
  t.mock.method(MongoClient.prototype,"db",()=>database);t.mock.method(MongoClient.prototype,"close",async()=>{database.stats.closes++;});
  t.after(closeDatabase);
  assert.equal((await getHealth()).status,503);
  const origin=await listen(t,app);
  const headers={"X-Forwarded-For":"203.0.113.10",Origin:production.CLIENT_URL};
  database.stats.failConnect=true;
  let response=await fetch(origin+"/api/health");assert.equal(response.status,503);assert.equal(response.headers.get("cache-control"),"no-store");assert.deepEqual(await response.json(),{application:"ok",database:"unavailable"});
  response=await fetch(origin+"/books",{headers});assert.equal(response.status,503);assert.equal((await response.json()).error.code,"SERVICE_UNAVAILABLE");
  database.stats.failConnect=false;
  const before=database.stats.connects;
  const results=await Promise.all(Array.from({length:10},()=>fetch(origin+"/books?page=1&limit=6",{headers})));
  assert.equal(database.stats.connects,before+1,"concurrent requests must share one connection attempt");
  for(const result of results){assert.equal(result.status,200);assert.deepEqual((await result.json()).data,{books:[],pagination:{page:1,limit:6,total:0,totalPages:0}});}
  const connections=database.stats.connects;
  response=await fetch(origin+"/api/health");assert.equal(response.status,200);assert.deepEqual(await response.json(),{application:"ok",database:"connected"});assert.equal(database.stats.connects,connections);
  await Promise.all([connectDatabase(),connectDatabase()]);assert.equal(database.stats.connects,connections);assert.equal(database.stats.creates,0);assert.equal(database.stats.metadata,2,"rate and book indexes verified once per database");
  response=await fetch(origin+"/books",{method:"OPTIONS",headers:{Origin:production.CLIENT_URL,"Access-Control-Request-Method":"PATCH","Access-Control-Request-Headers":"Authorization,Content-Type"}});
  assert.equal(response.status,204);assert.equal(response.headers.get("access-control-allow-origin"),production.CLIENT_URL);assert.equal(response.headers.get("access-control-allow-headers"),"Content-Type,Authorization");assert.equal(database.stats.connects,connections);
  for(const [method,path]of[["GET","/books/000000000000000000000001"],["POST","/books"],["PATCH","/books/000000000000000000000001"],["DELETE","/books/000000000000000000000001"],["POST","/borrows"],["GET","/borrows"],["DELETE","/borrows/000000000000000000000001"],["GET","/books?mine=true"]]){
    const r=await fetch(origin+path,{method,headers});assert.equal(r.status,401);assert.equal((await r.json()).error.code,"UNAUTHORIZED");
  }
  await closeDatabase();assert.equal(database.stats.closes,database.stats.connects,"failed clients and final successful pool must close");
});
test("production index verification fails closed and retries without creating indexes", async t => {
  const previous={...process.env};Object.assign(process.env,production);t.after(()=>{process.env=previous;});
  const database=makeServerlessDatabase();const expected=database.indexes.books;database.indexes.books=[];
  await assert.rejects(ensureBookIndexes(database),{status:503,code:"DATABASE_NOT_READY"});
  database.indexes.books=expected;await Promise.all([ensureBookIndexes(database),ensureBookIndexes(database)]);
  assert.equal(database.stats.metadata,2);assert.equal(database.stats.creates,0);
});
test("proxy policy uses only a valid Vercel ingress address and ignores forwarded headers elsewhere", () => {
  const req={headers:{"x-forwarded-for":"203.0.113.20","x-real-ip":"198.51.100.7"},socket:{remoteAddress:"127.0.0.1"}};
  assert.equal(clientAddress(req,{NODE_ENV:"production"}),"127.0.0.1");assert.equal(clientAddress(req,{VERCEL:"1"}),"203.0.113.20");
  for(const value of [undefined,"bad","203.0.113.20, 198.51.100.1",["203.0.113.20"]])assert.throws(()=>clientAddress({...req,headers:{"x-forwarded-for":value}},{VERCEL:"1"}),{status:503});
});
test("separate serverless limiters share Mongo counters, group IPv6 safely and fail closed", async t => {
  const previous={...process.env};Object.assign(process.env,production);t.after(()=>{process.env=previous;});t.mock.method(console,"error",()=>{});
  const database=makeServerlessDatabase();
  async function instance() {const application=express();application.set("trust proxy",false);application.use(createApiRateLimiter({limit:2,store:new MongoRateLimitStore(()=>database),environment:()=>production}));application.get("/check",(_q,r)=>r.json({ok:true}));application.get("/api/health",(_q,r)=>r.json({ok:true}));application.use(errorHandler);return listen(t,application);}
  const first=await instance(),second=await instance();const h=ip=>({"X-Forwarded-For":ip});
  assert.equal((await fetch(first+"/check",{headers:h("203.0.113.21")})).status,200);
  assert.equal((await fetch(second+"/check",{headers:h("203.0.113.21")})).status,200);
  let response=await fetch(first+"/check",{headers:{...h("203.0.113.21"),"X-Real-IP":"198.51.100.99"}});assert.equal(response.status,429);assert.equal((await response.json()).error.code,"RATE_LIMITED");assert.ok(response.headers.get("retry-after"));
  assert.equal((await fetch(second+"/check",{headers:h("203.0.113.22")})).status,200);
  for(const ip of ["2001:db8:1234:5600::1","2001:db8:1234:5600::2"])assert.equal((await fetch(first+"/check",{headers:h(ip)})).status,200);
  assert.equal((await fetch(second+"/check",{headers:h("2001:db8:1234:5600::3")})).status,429);
  assert.ok([...database.counters.keys()].every(key=>/^[a-f0-9]{64}$/.test(key)));
  database.stats.failCounter=true;response=await fetch(first+"/check",{headers:h("203.0.113.23")});assert.equal(response.status,503);assert.ok(!(await response.text()).includes("SECRET"));assert.equal((await fetch(first+"/api/health")).status,200);
  assert.equal(database.stats.metadata,1);assert.equal(database.stats.creates,0);
});
test("Mongo counter handles expiry without TTL deletion, duplicate inserts, decrement and reset", async t => {
  const previous={...process.env};Object.assign(process.env,production);t.after(()=>{process.env=previous;});
  const database=makeServerlessDatabase();const store=new MongoRateLimitStore(()=>database);store.init({windowMs:60000});database.stats.duplicateInsert=true;
  assert.equal((await store.increment("test-client")).totalHits,1);assert.equal((await store.increment("test-client")).totalHits,2);
  database.stats.now+=60001;assert.equal((await store.increment("test-client")).totalHits,1);
  await store.decrement("test-client");assert.equal((await store.increment("test-client")).totalHits,1);await store.resetKey("test-client");assert.equal(database.counters.size,0);
});
test("local bootstrap loads synthetic configuration, creates one listener and closes Mongo gracefully", async t => {
  const cwd=await mkdtemp(join(tmpdir(),"booknook-startup-test-"));t.after(()=>rmdir(cwd));
  const reservation=createServer();reservation.listen(0,"127.0.0.1");await once(reservation,"listening");const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  const env={...process.env,...production,NODE_ENV:"test",PORT:String(port),CLIENT_URL:"http://localhost:3000"};delete env.VERCEL;delete env.DNS_SERVERS;
  const child=spawn(process.execPath,["--import",new URL("../test-support/serverBootstrapMock.js",import.meta.url).href,fileURLToPath(new URL("../src/server.js",import.meta.url))],{cwd,env,stdio:["ignore","pipe","pipe","ipc"],windowsHide:true});
  t.after(()=>{if(child.exitCode===null)child.kill();});const messages=[];child.on("message",message=>messages.push(message.event));
  const exited=once(child,"exit");let stderr="";let output="";child.stdout.on("data",chunk=>{output+=chunk;});child.stderr.on("data",chunk=>{stderr+=chunk;});
  for(let attempt=0;attempt<100&&!output.includes("API listening");attempt++)await new Promise(r=>setTimeout(r,20));
  assert.ok(output.includes("API listening"),"Synthetic bootstrap did not start: "+stderr);assert.equal(messages.filter(v=>v==="listener").length,1);
  const response=await fetch(`http://127.0.0.1:${port}/api/health`);assert.equal(response.status,200);assert.deepEqual(await response.json(),{application:"ok",database:"connected"});
  child.send("stop");const timer=setTimeout(()=>child.kill(),5000);const [code]=await exited;clearTimeout(timer);assert.equal(code,0);assert.ok(messages.includes("databaseClosed"));
});
