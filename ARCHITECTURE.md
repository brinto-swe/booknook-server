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
- `src/config/auth.js` caches the jose remote JWKS resolver and validates auth URL configuration. `src/middleware/authenticate.js` supplies opt-in JWT verification for future private routers; `security.js` supplies API rate limiting.
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

Book Management, Borrow Management, and the authentication foundation are implemented. Keep the required eight business routes at their specified paths; do not add an `/api` prefix to them merely because health uses one. See [AUTHENTICATION.md](./AUTHENTICATION.md) for the Next.js Better Auth configuration, local environment setup, Google OAuth steps, JWT flow, and verification details.

Better Auth is hosted only by Next.js at `/api/auth/[...all]`. Express verifies its short-lived JWTs using cached public JWKS, EdDSA signature verification, issuer/audience/expiry checks, and trusted `sub`/`email` claims. Identity is attached as `req.user` only after successful verification. The exported auth middleware is not mounted globally; health and the existing public book listing remain public, while details and mutations require authentication; mine=true authenticates only that listing request.

Express startup validates `AUTH_ISSUER`, `AUTH_AUDIENCE`, and `AUTH_JWKS_URL`. CORS remains restricted to `CLIENT_URL` and the existing allowed headers. Helmet supplies API security headers, and a per-process 300-request/minute limiter excludes health. Rate-limited requests use the catalog's JSON `RATE_LIMITED` response with status 429.

## Book Management

The existing repository → service → controller → router layers own all five Book routes. Zod 4 validates strict mutation objects through the existing validation middleware. Express never creates Better Auth sessions or tokens. No new packages are needed. The factory createBookRoutes accepts an authentication dependency for isolated tests; production defaults to the unchanged jose middleware.

### Document and compatibility

New books contain native ObjectId _id, title, author, category, image, description, totalCopies, availableCopies, addedByUserId, addedByName, addedByEmail, createdAt, updatedAt, and addedAt. Timestamps are BSON Dates generated by the server; addedAt is an intentional compatibility alias of immutable createdAt that preserves existing latest-first ordering and indexes. image is an already-uploaded HTTP(S) URL. The API also emits imageUrl as an alias of image, retaining existing homepage consumers. No image is downloaded or uploaded by Express.

Categories are exactly Fiction, Science, History, Kids, Others. Total copies on creation/edit must be a positive safe integer. Creation initializes availability to total. Persisted zero-copy legacy records remain readable. Serialization enforces integer inventory and 0 <= availableCopies <= totalCopies, validates dates and fields, and exposes only allowlisted data. BSON IDs become hex strings and dates become ISO strings.

Legacy documents with imageUrl/addedAt remain readable without a migration; canonical image/createdAt take precedence. Missing legacy ownership fields serialize as null. Such records are never assigned to an owner based on an email match and cannot be edited/deleted through owner routes. Existing list envelope, imageUrl, addedAt, pagination, and category behavior are preserved; canonical fields are additive.

### Routes

| Route | Access | Input / result |
| --- | --- | --- |
| GET /books | Public by default | List envelope below; page, limit, category, optional mine=true. |
| GET /books/:id | Authenticated | 200 full serialized book in data, including descriptive fields, owner name/email, and inventory. |
| POST /books | Authenticated | Strict creation body; 201 serialized book in data. |
| PATCH /books/:id | Original owner | Nonempty strict partial creation body; 200 updated serialized book in data. |
| DELETE /books/:id | Original owner | 200 data containing _id and deleted:true. |

Creation body (all six fields required):

```json
{"title":"A Library Book","author":"A Writer","category":"Fiction","image":"https://example.com/cover.jpg","description":"A thoughtful journey.","totalCopies":3}
```

Strings are trimmed. Title max 300, author max 200, description max 5000, image URL max 2048 characters. Blank strings, credential-bearing URLs, non-HTTP(S) schemes, numeric strings/fractions, empty PATCH bodies, unknown keys, database operators, and all client identity/inventory/timestamp fields are rejected with 400 VALIDATION_ERROR. Callers send Content-Type: application/json. The existing strict JSON parser rejects scalar/null JSON as INVALID_JSON.

The URL is validated as data, not fetched; consumers still own their image display policy. Image upload and storage configuration are outside this module.

### Pagination and owner mode

| Parameter | Default | Validation |
| --- | --- | --- |
| page | 1 | Positive decimal integer <= 1,000,000; computed offset <= 1,000,000. |
| limit | 12 | Positive decimal integer <= 100. Homepage uses page=1&limit=6. |
| category | All | One exact allowed category. |
| mine | Absent | Only the literal true is accepted; requires a valid bearer JWT. |

Unknown/repeated/empty parameters are rejected. mine=false is rejected rather than silently changing scope. Owner IDs and email filters are never accepted. For mine=true the controller passes verified req.user to the service, which constructs addedByUserId from req.user.id; category and pagination can be combined. Public requests retain public behavior even if they carry an Authorization header. Private details and mine listings send Cache-Control: no-store.

```json
{"success":true,"data":{"books":[],"pagination":{"page":1,"limit":12,"total":0,"totalPages":0}}}
```

Results sort by addedAt descending then _id descending. Count and list are separate operations, so concurrent writes can make them differ momentarily. Beyond-last pages are empty. GET /books/ remains a list alias.

### Trusted identity and authorization

Existing jose middleware verifies signature, EdDSA algorithm, issuer, audience, expiry and subject/email claims. req.user.id is the only owner key. Current Better Auth 1.7.15 Mongo adapter maps user.id to ObjectId user._id; the new narrow authUserRepository reads name/email by verified subject from the existing user collection through the shared database. No raw auth documents or session secrets are returned. Missing/malformed trusted profiles fail creation closed with 401; database lookup failures return safe 500 errors. The adapter/configuration were inspected; custom ID modes or renamed auth collections would require coordinated changes.

Owner identity is captured from trusted user data at creation and remains immutable, including after profile changes. Existing unowned records need a separately reviewed migration if ownership is ever assigned. Missing/invalid JWTs return 401; a different owner returns 403; missing books return 404 BOOK_NOT_FOUND; malformed ObjectIds return 400 INVALID_BOOK_ID after authentication. All mutation responses use the existing success/error helpers. Driver failures use safe diagnostics and fixed INTERNAL_ERROR, never raw objects or stack traces.

### Book inventory compatibility

PATCH adjusts availableCopies by the totalCopies difference, preserving totalCopies - availableCopies outstanding copies. Reducing total below outstanding copies returns 409 CONFLICT. DELETE rejects books with outstanding copies (availableCopies differs from totalCopies), also with 409.

Both writes compare the originally read totalCopies, availableCopies, owner and ID in the atomic MongoDB filter. Concurrent inventory changes prevent the write and return 409; clients may refresh and retry. They never overwrite a borrow/return adjustment based on stale data. Other simultaneous descriptive edits follow ordinary last-write-wins semantics. No client controls availability, ownership, or dates.

Borrow and return operations now update this same book within MongoDB transactions, together with the associated borrow record. The Book PATCH/DELETE compare-and-write filters remain compatible: any concurrent inventory change prevents a stale write, and a concurrent deletion forces the loan transaction to abort/retry. The outstanding-copy deletion guard rejects books with active loans under the inventory invariant maintained by all sanctioned APIs. Existing manually corrupted inventory would require operational repair; no unsafe reconciliation is attempted.

### Indexes and database lifecycle

Reuse getDatabase; no new MongoClient or changes to connection/DNS/startup/shutdown. Index initialization remains lazy, cached per database and retryable after failure:

- books_latest: { addedAt: -1, _id: -1 }
- books_category_latest: { category: 1, addedAt: -1, _id: -1 }
- books_owner_latest: { addedByUserId: 1, addedAt: -1, _id: -1 }

The native _id index handles details. Index initialization occurs before lists/creation; index privileges are required. Collection queries/writes use maxTimeMS:5000. No migration, fake data, new schema validator, or real database test writes are performed.

## Checks

Run node --test from booknook-server. The unchanged npm test script remains its original failing placeholder; no lint script is configured. Run node --check on src and test JavaScript files. Existing architecture and JWT regression tests remain in the suite; obsolete tests expecting unmounted routes now assert authentication instead.

The new test/bookManagement.test.js uses actual EdDSA-signed JWTs and the production verifier with mocked remote JWKS. MongoDB Native Driver methods are mocked through the shared lifecycle. It covers public/private contracts, trusted profiles, pagination/filtering/mine, payload validation and mass assignment, missing/invalid IDs, cross-owner denial, copy adjustments, deletion safety, simulated inventory races, database failures, and auth regressions. These tests do not load .env or write to Atlas.

Book-module verification before Borrow Management: 54 tests passed, 0 failed; syntax checks for all src/test JavaScript passed. Local GET /api/health returned 200 and database connected; GET /books?page=1&limit=6 returned 200 with the expected envelope. These are live read smoke checks only; authenticated Atlas mutation integration was not run. No client changes, package changes, secret changes, or commits were made.



## Borrow Management

Only these three assignment routes are added; all use existing JWT authentication, response helpers, centralized errors, and Cache-Control: no-store. The frontend and authentication configuration are unchanged.

| Method / path | Contract |
| --- | --- |
| POST /borrows | Authenticate; JSON object containing only bookId, a 24-hex Book ObjectId. 201 with serialized Borrow in data. |
| GET /borrows | Authenticate; current user's entire history, including returned loans. 200 data: {borrows:[],pagination:{page,limit,total,totalPages}}. |
| DELETE /borrows/:id | Authenticate; borrow ObjectId. Return the book, retaining history. 200 with updated Borrow in data. |

Query parameters for GET are only page (default 1) and limit (default 12, maximum 100), using the existing Book pagination limits including offset <= 1,000,000. Unknown/repeated/empty/malformed parameters, userId and email filters are rejected with VALIDATION_ERROR. Repository filters always use verified req.user.id. History sorts by borrowDate descending, then _id descending. Pages beyond the end are empty; count and page are separate reads and may differ during concurrent writes.

### Borrow document

- _id: native ObjectId; API hex string.
- bookId: native ObjectId pointing to books; API hex string.
- bookTitle, bookImage: validated title and image snapshots at borrowing time, never client-supplied.
- userId: stable verified JWT subject, stored as string.
- userName, userEmail: trusted Better Auth profile resolved by that subject with the existing authUserRepository. Never read identity from the body or query.
- borrowDate: server timestamp in BSON UTC Date.
- returnDate: due date, exactly seven UTC calendar days after borrowDate (same UTC time, milliseconds preserved). UTC has no daylight-saving offset changes.
- returnedAt: null while borrowed; actual server return timestamp when returned.
- status: borrowed or returned.
- createdAt, updatedAt: server BSON UTC Dates.

Only allowlisted fields leave serializeBorrow; dates become ISO UTC strings. Invalid stored types, statuses, due dates or returnedAt combinations fail with safe INVALID_BORROW_DATA. Descriptive snapshots and borrower identity are immutable. There is no TTL index or physical loan deletion. Returned history survives later permitted book deletion.

### Indexes and transactions

Index initialization is lazy before Borrow operations, cached per database, shared for concurrent requests and retryable after failure:

- borrows_active_user_book: unique {userId:1,bookId:1}, partialFilterExpression:{status:"borrowed"}. Only one active loan per user/book; returned loans do not block reborrowing.
- borrows_user_latest: {userId:1,borrowDate:-1,_id:-1} for current-user history.

Indexes are created before opening transactions. Index-creation permissions are required. Existing duplicate active data causes initialization to fail; it is never ignored or silently modified.

withDatabaseTransaction in config/database.js starts a session from the existing connected MongoClient, checks/caches transaction-capable topology with sessions, invokes the installed MongoDB driver 7.8.0 withTransaction API with primary reads, snapshot read concern, majority write concern, 5-second max commit time and 15-second transaction/retry budget, then always ends the session. Existing connect/ping/DNS/startup/shutdown behavior is unchanged. No additional client/pool is created. Every operation inside the callback receives the same session; operations run sequentially inside a transaction. Driver-supported transient-transaction and uncertain-commit retries are retained. Callbacks contain only database work and serialization, with no external side effects.

Borrow flow, in one transaction: read/validate book; reject existing active loan; conditionally decrement availability only when >0 and <=total; insert loan with trusted snapshots. The partial unique index also closes races if two same-user requests both passed the precheck. Any insert/validation failure aborts the decrement.

Return flow, in one transaction: load record; enforce borrower identity and borrowed status; validate current book inventory; conditionally transition borrowed→returned; increment book only if 0<=availableCopies<totalCopies. A failure to restore inventory aborts the status change. Two concurrent returns conflict on the record/book; after retry only one can increment, and the other sees already returned. Dates and retained history reflect the successful transition.

No standalone/nontransactional fallback exists. Unsupported topology or unsupported transaction operations return 503 TRANSACTIONS_UNAVAILABLE. Read-only history remains available where its database/index operations are permitted. Exhausted driver retry/timeout or uncertain final commit returns 503 TRANSACTION_FAILED; callers must refresh before retrying because a commit acknowledgement may have been lost. Repeated POST cannot add a duplicate active loan, and repeated return cannot restore inventory twice.

Book PATCH still preserves totalCopies-availableCopies, rejecting reductions below outstanding loans. Book DELETE still requires availableCopies===totalCopies and compares current inventory/owner at deletion; this prevents deletion of books borrowed through these transaction-protected APIs. No extra business endpoints are introduced.

Implementation follows the [official Node driver transaction API](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/) and [MongoDB partial unique index rules](https://www.mongodb.com/docs/manual/core/index-partial/). Real transactions are required; a successful ping alone is not treated as proof of support.

### Borrow errors

All responses use the existing fixed-message catalog; no driver objects, JWTs, environment values, connection strings or stack traces are exposed.

| Status | Codes |
| --- | --- |
| 400 | VALIDATION_ERROR, INVALID_BOOK_ID (POST bookId), INVALID_BORROW_ID (return ID), existing parser errors |
| 401 | UNAUTHORIZED: missing/invalid JWT or unavailable trusted profile |
| 403 | FORBIDDEN: returning another user's loan |
| 404 | BOOK_NOT_FOUND, BORROW_NOT_FOUND |
| 409 | DUPLICATE_BORROW, BOOK_UNAVAILABLE, BORROW_ALREADY_RETURNED, INVENTORY_CONFLICT |
| 500 | INVALID_BORROW_DATA, INVALID_BOOK_DATA, INTERNAL_ERROR |
| 503 | TRANSACTIONS_UNAVAILABLE, TRANSACTION_FAILED |

INVENTORY_CONFLICT covers missing/inconsistent book inventory on return; the loan remains active and no partial return is committed. A repeated return is rejected, rather than represented as a successful new return.

### Files and verification

Created: src/validators/borrowValidators.js, src/persistence/borrowRepository.js, src/services/borrowService.js, src/controllers/borrowController.js, src/routes/borrowRoutes.js, test/borrows.test.js, test/borrows.atlas.test.js, test-support/borrowDatabase.js.

Modified: src/config/database.js (shared-client transaction helper only), src/persistence/bookRepository.js (session-aware detail reads and conditional inventory operations), src/app.js (Borrow router), src/utils/apiError.js (fixed Borrow errors), ARCHITECTURE.md. Existing authentication, connection lifecycle, environment files, dependencies and frontend remain untouched by this module.

Run node --test for the local suite. The Atlas test is skipped by default and does not load .env when skipped. Unit/HTTP tests use signed EdDSA tokens and mocked native-driver persistence with atomic rollback fixtures; existing authentication and Book suites remain included. Tests cover both active-loan checks and unique-index collisions, authorization/isolation, seven-day dates, unsafe payloads/queries, inventory conflicts, rollback after writes, competing borrowers/returns, retained history/reborrowing, Book edit/delete compatibility, session cleanup, unsupported topology and index retry.

Explicit Atlas verification (PowerShell, server directory):

```powershell
$env:RUN_ATLAS_TRANSACTION_TESTS = '1'
try { node --test test/borrows.atlas.test.js }
finally { Remove-Item Env:RUN_ATLAS_TRANSACTION_TESTS }
```

The opt-in test loads existing environment configuration only inside the test, with dotenv output suppressed. It uses the production transaction/service/repository logic against two uniquely named temporary collections in the configured database. It never edits the real books, borrows, or Better Auth user collections. It verifies commits, snapshot history, UTC dates, the real partial unique index, rollback after both borrow/return writes, last-copy contention, same-user contention, simultaneous/repeated returns and reborrowing. Cleanup drops only its exact created collection names and verifies their absence with equality filters. Atlas rejected an earlier listCollections $in cleanup-verification filter with server code 8000; the test now uses supported exact-name checks. No credentials or raw driver messages are printed.
