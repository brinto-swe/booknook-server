import { getDatabase } from "../config/database.js";

export async function getHealth() {
  try {
    await getDatabase().command({ ping: 1 }, { timeoutMS: 5000 });
    return { status: 200, data: { application: "ok", database: "connected" } };
  } catch {
    return { status: 503, data: { application: "ok", database: "unavailable" } };
  }
}
