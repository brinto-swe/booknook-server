// Only allowlisted metadata and fixed messages leave this boundary. Raw driver
// messages may contain credentials, URIs, hostnames, or arbitrary environment data.
const messages = new Map([
  ["INVALID_DNS_SERVERS", "DNS_SERVERS must contain comma-separated IPv4 or IPv6 addresses."],
  ["ENOTFOUND", "DNS lookup failed. Check the system resolver or optional DNS_SERVERS configuration."],
  ["EAI_AGAIN", "DNS lookup temporarily failed. Check resolver availability."],
  ["ECONNREFUSED", "Connection refused. Check network access and service availability."],
  ["ETIMEOUT", "DNS request timed out. Check resolver availability."],
  ["ETIMEDOUT", "Connection timed out. Check network access and the Atlas IP Access List."],
  ["ECONNRESET", "Connection reset by the remote service."],
  ["EADDRINUSE", "HTTP port is already in use."],
  ["EACCES", "Access denied by the operating system."],
  ["ENODATA", "DNS lookup returned no records."],
  ["ESERVFAIL", "DNS server failed to resolve the request."],
  ["EREFUSED", "DNS server refused the request."],
  ["18", "MongoDB authentication failed. Check credentials privately."],
]);
const names = new Map([
  ["Error", "Operation failed. Check configuration and service availability."],
  ["TypeError", "Invalid configuration type or operation."],
  ["MongoParseError", "Invalid MongoDB connection configuration."],
  ["MongoAPIError", "Invalid MongoDB client configuration."],
  ["MongoServerError", "MongoDB rejected the operation."],
  ["MongoServerSelectionError", "MongoDB server selection failed. Check DNS, network access, and the Atlas IP Access List."],
  ["MongoNetworkError", "MongoDB network connection failed."],
  ["MongoNetworkTimeoutError", "MongoDB network operation timed out."],
]);
const configurationMessages = new Set([
  "Environment file could not be loaded.",
  "MONGODB_URI is required.",
  "DB_NAME is required.",
  "CLIENT_URL is required.",
  "MONGODB_URI and DB_NAME are required.",
  "MONGODB_URI must be a MongoDB connection string.",
  "CLIENT_URL must be a valid HTTP or HTTPS origin.",
  "CLIENT_URL must be an HTTP or HTTPS origin without a path or credentials.",
  "PORT must be an integer between 1 and 65535.",
]);

export function safeErrorDetails(error) {
  const name = names.has(error?.name) ? error.name : "Error";
  let current = error;
  for (let depth = 0; current && depth < 5; depth++, current = current.cause) {
    const code = typeof current.code === "number" || typeof current.code === "string"
      ? String(current.code) : "";
    if (messages.has(code)) return { name, code, message: messages.get(code) };
  }
  if (configurationMessages.has(error?.message)) {
    return { name, code: "INVALID_CONFIGURATION", message: error.message };
  }
  return { name, code: "UNCLASSIFIED", message: names.get(name) };
}

export function logSafeError(context, error) {
  const { name, code, message } = safeErrorDetails(error);
  console.error(`${context}: name=${name} code=${code} message=${message}`);
}
