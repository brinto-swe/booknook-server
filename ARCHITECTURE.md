# Backend architecture

JavaScript ES Modules, Express 5, and the MongoDB Native Driver remain the stack.

## Responsibilities

- `src/server.js`: local dotenv loading, shared configuration validation, local DNS setup, database-first startup, the sole local HTTP listener, and shutdown. Vercel imports app.js instead.
- `src/app.js`: named createApp factory plus a default real Express application export, runtime configuration/connection initialization, CORS, JSON parser, routers, then not-found and error middleware. Importing it opens no listener or database connection.
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

Express startup validates `AUTH_ISSUER`, `AUTH_AUDIENCE`, and `AUTH_JWKS_URL`. CORS remains restricted to `CLIENT_URL` and the existing allowed headers. Helmet supplies API security headers. The 300-request/minute limiter excludes health; development uses memory while production uses shared atomic MongoDB counters. Rate-limited requests use the catalog's JSON `RATE_LIMITED` response with status 429.

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

Reuse getDatabase; no new MongoClient or changes to connection/DNS/startup/shutdown. Index checks remain lazy, cached per database and retryable after failure. Development creates missing indexes; production only verifies indexes provisioned by scripts/ensure-indexes.js:

- books_latest: { addedAt: -1, _id: -1 }
- books_category_latest: { category: 1, addedAt: -1, _id: -1 }
- books_owner_latest: { addedByUserId: 1, addedAt: -1, _id: -1 }

The native _id index handles details. Index initialization occurs before lists/creation; index privileges are required. Collection queries/writes use maxTimeMS:5000. Production index metadata reads are bounded at 5 seconds; development creation at 10 seconds. No migration, fake data, new schema validator, or real database test writes are performed.

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

Index checks are lazy before Borrow operations, cached per database, shared for concurrent requests and retryable after failure. Development creates indexes; production verifies their exact definitions without DDL:

- borrows_active_user_book: unique {userId:1,bookId:1}, partialFilterExpression:{status:"borrowed"}. Only one active loan per user/book; returned loans do not block reborrowing.
- borrows_user_latest: {userId:1,borrowDate:-1,_id:-1} for current-user history.

Indexes are provisioned before production traffic with the explicit operator script; development creates them before opening transactions. Runtime production requires metadata/read/write permissions; the provisioning account needs index-creation permissions. Existing duplicate active data causes initialization to fail; it is never ignored or silently modified.

withDatabaseTransaction in config/database.js starts a session from the existing connected MongoClient, checks/caches transaction-capable topology with sessions, invokes the installed MongoDB driver 7.8.0 withTransaction API with primary reads, snapshot read concern, majority write concern, 5-second max commit time and 15-second transaction/retry budget, then always ends the session. The shared connect/ping lifecycle is retained; request-time initialization supports Vercel and serverless pool limits apply in production. Local DNS/startup/shutdown behavior is retained. No additional client/pool is created. Every operation inside the callback receives the same session; operations run sequentially inside a transaction. Driver-supported transient-transaction and uncertain-commit retries are retained. Callbacks contain only database work and serialization, with no external side effects.

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

Final Borrow verification results:

- node --test: 77 discovered tests, 76 passed, 0 failed, 1 intentionally skipped opt-in Atlas test.
- Explicit opt-in Atlas run: 1 integration test passed, 0 failed; actual transactions, unique-index enforcement, rollback and concurrent operations verified. Temporary collections removed and absence verified. This tests the production service/repository/transaction logic against Atlas, not an end-to-end Better Auth browser session.
- node --check passed for all JavaScript in src/, test/, and test-support/.
- git diff --check passed (Git reports only ordinary LF→CRLF working-copy warnings).
- Live GET /api/health: 200 with application ok/database connected.
- Live GET /books?page=1&limit=6: 200 with unchanged success/books/pagination envelope.
- Live anonymous GET /borrows: 401 UNAUTHORIZED.

No known unresolved Borrow module failures. Full deployed/browser-to-API acceptance is outside this backend phase. npm test remains the pre-existing failing placeholder and no server lint script exists; run the real suite using node --test. Pre-existing package/lockfile edits (including the already-installed Multer dependency) were preserved; this phase installs or uses none of them. No commits, frontend changes, real application fixture records, environment changes or authentication changes were made.

## Vercel production readiness

The deployment targets for this phase are Express on Vercel and the Next.js/Better Auth frontend on Netlify, as explicitly requested by the user. These supersede the earlier deployment-target planning notes.

### Entry point and initialization

src/app.js imports Express and default-exports an actual Express application, matching Vercel's supported native Express entry-point format. Its named createApp factory remains available for isolated tests. No custom serverless wrapper, vercel.json, rewrites, or second listener is introduced. Only src/server.js starts the local listener; it loads dotenv quietly before importing the app, validates configuration, applies the optional development DNS override, connects first, and retains signal-based HTTP/Mongo cleanup.

The default app can be imported without any configuration or network access. On requests, configuration is read/validated at runtime and connectDatabase is awaited. The existing connected client, database, and in-flight connection promise are shared per warm instance; concurrent initialization shares one attempt. Failed attempts close the failed client and clear state so later requests can retry. Connections are not closed at the end of each request. Transaction/session handling and all JWT algorithms, claims, issuer/audience/JWKS behavior are unchanged.

Successful cold-start health requests connect then ping. Failed configuration/initialization returns the existing exact health shape with status 503 and Cache-Control:no-store; normal healthy responses remain status 200. Other initialization failures use the existing fixed SERVICE_UNAVAILABLE JSON error. CORS preflight completes before connection work. Production CLIENT_URL must be an exact HTTPS origin; local HTTP origins remain supported. Request configuration and initialization errors never echo environment values or raw driver errors.

### Production rate limiting and ingress trust

Platform-level Vercel WAF rate limiting was inspected. It requires project firewall configuration, outside this code-only/no-deployment task. Existing MongoDB Atlas is therefore used as the shared store with the already-installed native driver and express-rate-limit. No new package/service credentials are necessary. Platform rules may additionally protect traffic before it reaches the function.

Production means NODE_ENV production or the Vercel runtime flag. The application keeps the established 300 requests per 60 seconds and JSON RATE_LIMITED 429 response; health remains exempt. Production uses rate_limits, a new infrastructure collection containing a SHA-256 counter key, totalHits, and resetTime. A single findOneAndUpdate aggregation pipeline increments/resets each counter using MongoDB's clock. Concurrent first inserts handle the duplicate-key race. Different instances share the same counters. A TTL index removes expired documents, but logical expiration works independently of delayed TTL cleanup. Failures return safe 503 errors; there is no fallback to a per-instance counter. Development retains the existing memory-backed limiter. Middleware is constructed once at app composition, never on each request.

Express trust proxy is explicitly false. No forwarded headers affect Express req.ip or authorization. Only when the server-side VERCEL flag identifies the Vercel runtime does the limiter consume the Vercel-overwritten X-Forwarded-For ingress header. It must contain one valid IP address; missing, malformed, repeated or comma-separated values fail closed. Outside Vercel all forwarded IP headers are ignored and the socket address is used. X-Real-IP is never accepted as an alternative. The existing library's ipKeyGenerator normalizes IPv4-mapped addresses and groups native IPv6 by /56 before hashing, preventing easy address-rotation bypass within that subnet. Additional custom proxies must be reviewed rather than enabling unrestricted trust or accepting arbitrary forwarding chains.

This design follows the [Vercel ingress header contract](https://vercel.com/docs/headers/request-headers) and the installed express-rate-limit 8.7.3 [custom store interface](https://express-rate-limit.mintlify.app/guides/creating-a-store).

### Pool and index management

Production MongoClient options now bound each server's application pool to 10 sockets, minPoolSize 0, maxConnecting 2, maxIdleTimeMS 60000, waitQueueTimeoutMS 5000 and socketTimeoutMS 20000. Existing connection/server-selection timeouts stay 10000. Transaction timeout/retry budget stays 15000 with a 5000 maximum commit time. These are conservative starting limits per instance/server, not a global connection budget; size the Atlas cluster and test Vercel scaling accordingly. Driver monitoring uses additional sockets. Local connection options remain unchanged.

Production requests never create indexes. src/config/indexes.js verifies the required index name, keys, uniqueness, partial filter and TTL definition through bounded metadata reads, cached per database/collection. Missing or incompatible indexes return DATABASE_NOT_READY (503). Failed checks are retryable after provisioning. Development preserves the existing lazy/retryable creation behavior.

Run the explicit command from the backend directory using the intended environment's securely configured database access:

```powershell
node scripts/ensure-indexes.js
```

The command quietly loads local dotenv where appropriate, uses the same pool, creates/verifies the three Book indexes, two Borrow indexes and rate_limits_expiry:{resetTime:1},expireAfterSeconds:0, then closes its connection. It never mutates application records, prints credentials, or runs automatically at build/startup/request time. A conflict or duplicate active data stops provisioning; no data repair is attempted. Run this once for each database/environment before traffic. The production runtime account need not have DDL permissions if indexes are provisioned separately.

### Exact deployment configuration

- Backend-only Git repository: Root Directory is its repository root. If importing the parent project instead, Root Directory is booknook-server.
- Framework preset: Express, native detection.
- Entry point: src/app.js, default Express app export.
- Node.js runtime: explicitly choose 24.x in Vercel project settings. The package manifest/scripts/dependencies are unchanged.
- Build command: no custom override; this JavaScript backend has no compilation step.
- Install command: automatic npm/lockfile detection; npm ci may be selected for reproducible installation.
- Output Directory: no custom override; Vercel's Express preset handles output.
- vercel.json, API-prefix rewrites and custom serverless wrappers: unnecessary.
- Duration/memory: start with the platform defaults, measure cold starts/load, and retain sufficient headroom for DB/JWKS/index work plus transaction retries. Choose a region near Atlas.

[Vercel Express documentation](https://vercel.com/docs/frameworks/backend/express) supports this file/export arrangement. Actual deployment/build-platform execution was not performed and must be confirmed in an isolated preview.

Required backend configuration names: MONGODB_URI, DB_NAME, CLIENT_URL, AUTH_ISSUER, AUTH_AUDIENCE, AUTH_JWKS_URL. Runtime-provided mode/detection names: NODE_ENV, VERCEL. Local-only configuration: PORT, optional DNS_SERVERS. Test-only: RUN_ATLAS_TRANSACTION_TESTS. No new secret or rate-limit environment variable is introduced. Production/Preview/Development need independent database access and matching canonical frontend/auth origins; the DNS override stays disabled in production. Better Auth/Google secrets and NEXT_PUBLIC_API_URL remain frontend-host environment concerns, not Express configuration.

Remaining deployment prerequisites: provision indexes in the target database, configure canonical Netlify/Vercel origins and auth/JWKS URLs, allow the chosen Vercel/Netlify egress through Atlas network access, verify deployment access protection does not block legitimate API/JWKS requests, and run preview cold/warm/proxy/load acceptance. These are not asserted as configured. No domains, plan settings, static egress addresses or deployment results are invented.

### Changed files and verification

Modified:
- src/app.js — supported default app export and runtime request readiness.
- src/server.js — serve that app once locally, reuse shared configuration validation.
- src/config/database.js — production pool limits; existing lifecycle/transactions retained.
- src/middleware/security.js — shared production limiter and explicit ingress IP policy.
- src/persistence/bookRepository.js and borrowRepository.js — shared index verification/provisioning boundary.
- src/utils/apiError.js — fixed DATABASE_NOT_READY response.
- test/borrows.atlas.test.js — production-mode pools/index verification and real shared-counter contention coverage, retaining every previous transaction assertion.
- ARCHITECTURE.md — current runtime, configuration, operational prerequisites and results.

Created:
- src/config/environment.js — shared runtime/origin/local-port validation.
- src/config/indexes.js — retryable metadata verification and development creation.
- src/persistence/rateLimitStore.js — native MongoDB fixed-window store and TTL specification.
- scripts/ensure-indexes.js — explicit bounded provisioning command.
- test/serverless.test.js — entry-point, cold-start, retry, health, connection, index, rate/IP and local startup regression tests.
- test-support/serverlessDatabase.js and serverBootstrapMock.js — isolated synthetic DB/child-bootstrap fixtures; not production imports or routes.

Final validation:
- node --test: 85 discovered tests, 84 passed, 0 failed, 1 skipped (opt-in Atlas test). Existing Book, Borrow, auth and architecture tests remain unchanged and pass.
- Explicit Atlas integration: 1 passed, 0 failed, 0 skipped. It used production pool settings, pre-provisioned/verified temporary indexes, preserved transaction/rollback/uniqueness/contention tests, and verified concurrent counters across separate MongoRateLimitStore instances plus logical window expiration. All three temporary fixture collections were dropped and absence verified. No real books, borrows, user data or production rate counters were changed.
- Syntax checks passed for src/, scripts/, test/, test-support/; git diff --check passed with only ordinary line-ending warnings.
- The real local bootstrap ran in a child process against mocked MongoDB with synthetic configuration in an empty temporary working directory, served health, created exactly one listener, then gracefully closed HTTP and MongoDB. Existing actual .env values were not displayed or modified.
- No frontend changes, installed packages, lockfile changes, authentication changes, commits or deployments.
