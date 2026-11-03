import { ApiError } from "../utils/apiError.js";

export function notFound(_req, _res, next) {
  next(new ApiError("ROUTE_NOT_FOUND"));
}
