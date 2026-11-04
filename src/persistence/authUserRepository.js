import { ObjectId } from "mongodb";
import { getDatabase } from "../config/database.js";

// Better Auth 1.7.15's installed Mongo adapter maps user.id to user._id (ObjectId).
// No email-based fallback: ownership must remain tied to the verified subject.
export async function findAuthUser(id) {
  if (!/^[a-fA-F0-9]{24}$/.test(id)) return null;
  return getDatabase().collection("user").findOne({ _id: new ObjectId(id) }, {
    projection: { _id: 1, name: 1, email: 1 }, maxTimeMS: 5000,
  });
}
