// src/asyncHandler.js — Express 4 does not automatically catch
// rejected promises thrown inside `async (req, res) => {}` handlers;
// an unhandled rejection there just hangs the request instead of
// reaching the error-handling middleware. Wrapping every route with
// this fixes that — any thrown/rejected error gets forwarded to
// next(err), which server.js's error handler turns into a clean
// "Internal server error" JSON response instead of a silent hang.
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
