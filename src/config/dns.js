import dns from "node:dns";
import { isIP } from "node:net";

export function configureDns(environment = process.env) {
  // Production always retains the hosting platform's resolver configuration.
  if (environment.NODE_ENV === "production" || environment.DNS_SERVERS === undefined) {
    return false;
  }
  const servers = environment.DNS_SERVERS.split(",").map((server) => server.trim());
  if (servers.some((server) => isIP(server) === 0)) {
    const error = new Error("DNS_SERVERS must contain comma-separated IPv4 or IPv6 addresses.");
    error.code = "INVALID_DNS_SERVERS";
    throw error;
  }
  dns.setServers(servers);
  return true;
}
