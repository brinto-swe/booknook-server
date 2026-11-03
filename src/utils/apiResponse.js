export function sendSuccess(res, data, status = 200) {
  return res.status(status).json({ success: true, data });
}

export function sendError(res, error) {
  return res.status(error.status).json({
    success: false,
    error: { code: error.code, message: error.message },
  });
}
