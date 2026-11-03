# Backend architecture

JavaScript ES Modules, Express 5, and the MongoDB Native Driver remain the stack.

## Responsibilities

- `src/server.js`: environment loading, configuration validation, DNS setup, database-first startup, HTTP listener, and shutdown.
- `src/app.js`: Express composition, CORS, JSON parser, routers, then not-found and error middleware.
- `src/config/`: database connection lifecycle, optional development DNS override, and safe diagnostics.
- `src/routes/`: HTTP method/path declarations and route-specific middleware.
- `src/controllers/`: translate validated HTTP input to service calls and send responses.
- `src/services/`: application operations and database work, independent of Express request/response objects. Health currently demonstrates this boundary.
- `src/middleware/`: reusable request validation, unmatched-route handling, and centralized error handling.
- `src/utils/`: fixed public API error definitions and response helpers.
- `src/persistence/`: native-driver collection queries and index initialization, using the shared database.
- `src/validators/`: route input validation and persisted book serialization/invariant checks.

The MongoDB driver is the persistence layer; no ORM or speculative models are introduced. Define collection-specific persistence modules and validators when implementing the relevant domain, rather than creating empty Book/Borrow modules now. Obtain the shared database through `getDatabase()` at operation time; never instantiate clients inside controllers or services. Transactions spanning future inventory/borrow writes belong within the service operation, not separate controller calls.

## Response and error conventions

Future business success responses use `sendSuccess(res, data, status)`:

```json
{"success":true,"data":{}}
```

Errors use `ApiError` catalog codes and centralized middleware:

```json
{"success":false,"error":{"code":"VALIDATION_ERROR","message":"Request validation failed."}}
```

Use 200 for reads/updates/JSON deletion acknowledgments and 201 for creation. Use 400 for validation, 401 for missing/invalid authentication, 403 for ownership denial, 404 for missing resources, 409 for state conflicts, and 500 for unexpected failures. These conventions do not implement authentication or domain policies. Never pass raw errors, input values, secrets, or stack traces into responses. Unexpected server errors use existing safe diagnostic logging. Parser errors receive fixed JSON responses; unknown client errors receive generic 400 responses.

`GET /api/health` is an infrastructure exception: preserve exactly `{"application":"ok","database":"connected"}` with 200, or `{"application":"ok","database":"unavailable"}` with 503. Both disable caching and perform a current ping. This is not a business API.

## Validation and Express 5 errors

Apply `requireObjectBody` to future JSON-object mutation routes, then `validate("body", validator)` (or `params`/`query`). Each validator must explicitly check allowed fields/types, reject invalid data using `ApiError("VALIDATION_ERROR")`, and return only normalized, allowlisted values. Controllers consume `req.validated.body`, `.params`, or `.query`; raw inputs are not database documents or filters. Middleware does not infer domain rules or automatically make arbitrary input safe. Do not replace Express 5's `req.query` getter.

Express 5 forwards rejected async middleware/controller promises to the error handler; no async-wrapper dependency is needed. Callback-based asynchronous work must still forward failures with `next(error)`. Mount future routers before `notFound`, and keep the four-argument `errorHandler` last. It delegates if response headers have already been sent.

Book reads are implemented as described below. No Book mutations, Borrow APIs, or authentication are implemented. Keep the required eight business routes at their specified paths; do not add an `/api` prefix to them merely because health uses one.

## Book reads (Phase 4)

`GET /books` (also `/books/`) is mounted publicly. The trailing slash is an alias for the list, not a single-book identifier. `GET /books/:id` is fully prepared as the separately exported `bookDetailRoutes` router but deliberately **not mounted** in `app.js`, per the user's decision to defer mounting until authentication is implemented. Requests for single books against the real app currently return `ROUTE_NOT_FOUND`; tests mount the prepared router in a separate harness. Do not expose it publicly by mounting it without the future authentication guard.

List query parameters:

| Parameter | Default | Validation |
| --- | --- | --- |
| `page` | `1` | Positive decimal integer, maximum 1,000,000; computed offset cannot exceed 1,000,000. |
| `limit` | `12` | Positive decimal integer, maximum 100. Use `limit=6` for latest six. |
| `category` | Omitted (all) | Exactly Fiction, Science, History, Kids, or Others. |

Unknown parameters, repeated parameters, empty values, unsupported categories, and malformed numbers return 400 `VALIDATION_ERROR`. Arbitrary email/owner and MongoDB operator filters are not accepted. No authenticated My Books filter is introduced before authentication.

List success (200):

```json
{"success":true,"data":{"books":[],"pagination":{"page":1,"limit":12,"total":0,"totalPages":0}}}
```

Results sort by `addedAt` descending, then `_id` descending for deterministic ties. `total` counts matches before pagination; a page beyond the result set returns an empty array. The find and count run separately, so their results are not a transactional snapshot if future writers modify books concurrently.

The prepared detail route returns `{"success":true,"data":{...book}}`. IDs must be 24 hexadecimal characters, converted to native `ObjectId` before querying. Invalid IDs return 400 `INVALID_BOOK_ID`; absent books return 404 `BOOK_NOT_FOUND`. Database/index failures use the existing 500 `INTERNAL_ERROR` response and safe diagnostics, without leaking driver errors.

Persisted book fields: `_id` (ObjectId), nonblank `title`, `author`, `description`, allowed `category`, HTTP(S) `imageUrl` without embedded credentials, safe-integer `totalCopies`/`availableCopies`, and valid BSON Date `addedAt`. Inventory must satisfy `0 <= availableCopies <= totalCopies`. Zero-total persisted records are readable; this does not settle the future policy for creating zero-copy books. Dates serialize to ISO strings and IDs to hex strings. `serializeBook` enforces these invariants before responding and allowlists the response fields. Malformed stored records return 500 `INVALID_BOOK_DATA`, rather than silently emitting invalid inventory. Ownership fields are neither invented nor exposed during this read-only phase; future authenticated writers must add trusted ownership.

The repository uses a positive field projection and never creates its own MongoClient. It initializes these nonunique indexes once per connected database on the first list request, with concurrent initialization sharing one promise and failures retryable:

- `books_latest`: `{ addedAt: -1, _id: -1 }` supports unfiltered newest-first pagination.
- `books_category_latest`: `{ category: 1, addedAt: -1, _id: -1 }` supports equality filtering with the same order.

The existing `_id` index supports detail reads; no duplicate index is added. Query execution is bounded with `maxTimeMS: 5000`. Index initialization requires index-creation privileges and may delay the first list request. It does not run during startup or health checks. No MongoDB schema migration, seed data, or write API is executed; the runtime document contract is defined in `src/validators/bookValidators.js`. Real Atlas permissions/indexes remain unverified until explicitly tested.

## Checks

Run `node --test test/architecture.test.js` for bounded local HTTP integration tests using a mocked MongoDB client and an ephemeral loopback port. Tests neither load `.env` nor connect to Atlas. `npm test` remains the original placeholder; package scripts/dependencies are unchanged. Syntax-check source files with `node --check`.

Run `node --test` to include `test/books.test.js`: document/query/ID validation, list filters and pagination, ordering, projection/serialization, prepared detail routing, missing documents, database and index failures, index retry/reuse, and assertions that mutations and the private detail router remain unmounted in the actual app. MongoDB is mocked; these tests are not Atlas integration tests.
