const definitions = {
  BAD_REQUEST: [400, "Invalid request."],
  VALIDATION_ERROR: [400, "Request validation failed."],
  INVALID_BOOK_ID: [400, "Book ID must be a 24-character hexadecimal ObjectId."],
  BOOK_NOT_FOUND: [404, "Book not found."],
  INVALID_BOOK_DATA: [500, "Stored book data is invalid."],
  INVALID_JSON: [400, "Invalid JSON request body."],
  UNAUTHORIZED: [401, "Authentication required."],
  RATE_LIMITED: [429, "Too many requests. Please try again later."],
  FORBIDDEN: [403, "Access denied."],
  NOT_FOUND: [404, "Resource not found."],
  ROUTE_NOT_FOUND: [404, "Route not found."],
  CONFLICT: [409, "Request conflicts with the current resource state."],
  PAYLOAD_TOO_LARGE: [413, "Request body is too large."],
  UNSUPPORTED_MEDIA_TYPE: [415, "Unsupported request content type or encoding."],
  INTERNAL_ERROR: [500, "Internal server error."],
  SERVICE_UNAVAILABLE: [503, "Service temporarily unavailable."],
};

// Public errors use fixed messages; never pass driver messages or input values.
export class ApiError extends Error {
  constructor(code = "INTERNAL_ERROR") {
    const knownCode = Object.hasOwn(definitions, code) ? code : "INTERNAL_ERROR";
    const [status, message] = definitions[knownCode];
    super(message);
    this.name = "ApiError";
    this.code = knownCode;
    this.status = status;
  }
}
