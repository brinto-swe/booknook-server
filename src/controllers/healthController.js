import { getHealth } from "../services/healthService.js";

export async function healthController(_req, res) {
  res.set("Cache-Control", "no-store");
  const { status, data } = await getHealth();
  return res.status(status).json(data);
}
