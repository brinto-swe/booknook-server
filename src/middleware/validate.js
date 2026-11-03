import { ApiError } from "../utils/apiError.js";

export function requireObjectBody(req, _res, next) {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return next(new ApiError("VALIDATION_ERROR"));
  }
  next();
}

// A validator returns a normalized allowlisted object, or throws ApiError.
// Store validated values separately: Express 5's req.query is a getter.
export function validate(source, validator) {
  if (!["body", "params", "query"].includes(source) || typeof validator !== "function") {
    throw new TypeError("Validation middleware requires a request source and validator.");
  }
  return async function validateRequest(req, _res, next) {
    const value = await validator(req[source]);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Validators must return an object.");
    }
    req.validated ??= {};
    req.validated[source] = value;
    next();
  };
}
