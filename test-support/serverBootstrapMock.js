import { MongoClient } from "mongodb";
import { Server } from "node:net";
MongoClient.prototype.connect = async function () { return this; };
MongoClient.prototype.db = () => ({ command: async () => ({ ok: 1 }) });
MongoClient.prototype.close = async () => { if (process.connected) process.send({ event: "databaseClosed" }, () => process.disconnect()); };
const originalListen = Server.prototype.listen;
Server.prototype.listen = function (...args) { process.send?.({ event: "listener" }); return originalListen.apply(this, args); };
process.on("message", message => {
  if (message === "stop") { process.emit("SIGTERM"); }
});
