import { ApiError } from "../utils/apiError.js";
import { sendError } from "../utils/apiResponse.js";
import { logSafeError } from "../config/diagnostics.js";

export function errorHandler(error, _req, res, next) {
  if (res.headersSent) return next(error);

  let publicError;
  if (error instanceof ApiError) {
    // Reconstruct from the catalog rather than exposing mutated error fields.
    publicError = new ApiError(error.code);
  } else if (error?.type === "entity.parse.failed") {
    publicError = new ApiError("INVALID_JSON");
  } else if (error?.status === 413) {
    publicError = new ApiError("PAYLOAD_TOO_LARGE");
  } else if (error?.status === 415) {
    publicError = new ApiError("UNSUPPORTED_MEDIA_TYPE");
  } else if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) {
    publicError = new ApiError("BAD_REQUEST");
  } else {
    publicError = new ApiError();
  }

  if (publicError.status >= 500) logSafeError("Request failed", error);
  return sendError(res, publicError);
}
