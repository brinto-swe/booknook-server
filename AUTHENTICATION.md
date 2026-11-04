# BookNook authentication foundation

## Architecture and versions

Next.js owns Better Auth sessions, email/password authentication, optional Google OAuth, and JWT issuance. Express owns business APIs and verifies bearer JWTs using public JWKS; it never receives the Better Auth secret or a private signing key. MongoDB Atlas database `booknook` holds auth data alongside the existing application collections.

Checked installed versions: Better Auth 1.7.15, `@better-auth/mongo-adapter` 1.7.15, MongoDB driver 7.8.0, jose 6.2.15, Helmet 8.3.0, express-rate-limit 8.7.3, Next.js 16.4.4, and Express 5.3.0. No dependencies or package scripts were changed.

Implementation was checked against the installed package implementations and official documentation:

- [MongoDB adapter](https://better-auth.com/docs/adapters/mongo)
- [Next.js integration](https://better-auth.com/docs/integrations/next)
- [JWT plugin](https://better-auth.com/docs/plugins/jwt)
- [Hooks](https://better-auth.com/docs/concepts/hooks)
- [Email/password](https://better-auth.com/docs/authentication/email-password)
- [OAuth](https://better-auth.com/docs/concepts/oauth) and [Google setup](https://better-auth.com/docs/authentication/google)
- [jose remote JWKS](https://github.com/panva/jose/blob/v6.2.15/docs/jwks/remote/functions/createRemoteJWKSet.md)

## Next.js implementation

- `booknook-client/src/lib/auth.js` completes the existing scaffold and exports the Better Auth instance using the official MongoDB adapter with `{ client }` for Atlas transaction support.
- `auth-database.js` keeps one MongoClient pool and one connection promise in the server global cache, including during development hot reload. A failed connection clears its promise so a later request can retry. It connects at request time rather than during production builds. This pool is separate from Express because the apps are separate Node processes.
- Optional development `DNS_SERVERS` is validated as IP addresses and applied to both the callback and promise DNS APIs before using the pool. This is necessary for the local Atlas resolver issue. No DNS override is forced in production and no resolver addresses are hardcoded.
- `auth-options.js` centralizes testable configuration. A supported before hook enforces at least six characters and both uppercase and lowercase letters for registration and password changes. Better Auth's default password hashing is preserved. Photo URLs use Better Auth's standard `image` user field.
- `auth-client.js` uses the React auth client and official `jwtClient()` plugin. Auth requests use the same origin; server secrets are never public client variables.
- `src/app/api/auth/[...all]/route.js` exposes the official GET/POST adapter. It connects the shared pool before invoking Better Auth and returns a fixed 503 response for unexpected infrastructure failures. The default Node runtime is retained; the installed Next.js cache-components mode rejects an explicit route `runtime` export.

Google is configured only when both credentials are nonempty. Email/password works when either credential is absent. No GitHub provider, email verification flow, forgot-password flow, Login/Register pages, or homepage auth integration was added. Reset/verification paths are disabled for this assignment. Current library error logging is disabled to avoid raw driver/provider errors disclosing secrets.

## MongoDB collections

The adapter uses its default singular model names:

| Collection | Purpose |
| --- | --- |
| `user` | User ID, name, email, image, and timestamps. |
| `session` | Persisted sessions and their expiry; cookies reference these sessions. |
| `account` | Credential password hashes and linked Google provider account/token data. |
| `verification` | Transient verification state used by supported auth operations, including OAuth state where applicable; its existence does not enable email verification. |
| `jwks` | Public keys and encrypted private signing keys used by the JWT plugin. |

MongoDB does not require SQL schema generation/migration commands. Auth operations create their own records; no Book/Borrow schema or business indexes were changed. No fake users were inserted for testing. The live JWKS smoke check initialized/read the real signing-key collection through Better Auth.

## Environment configuration

Use the existing actual `.env` files, which are Git-ignored. No `.env.example` was created. Never print or commit these files. Restart the apps after environment changes.

Client names:

| Name | Purpose |
| --- | --- |
| `BETTER_AUTH_SECRET` | Server-only signing/encryption secret, including private JWK encryption. Existing configured value was retained. Missing/empty values must be generated using Node crypto with at least 32 random bytes. |
| `BETTER_AUTH_URL` | Next.js origin; also the JWT issuer and audience. |
| `MONGODB_URI` | Server-only Atlas connection URI. Existing configured value was retained; if missing, the existing server URI can be copied privately. |
| `DB_NAME` | Selects the existing `booknook` database. |
| `GOOGLE_CLIENT_ID` | Optional Google web OAuth client ID. |
| `GOOGLE_CLIENT_SECRET` | Optional Google OAuth secret. |
| `DNS_SERVERS` | Optional comma-separated IPs for the local resolver override. The existing server's configured resolver setting was reused privately when missing in the client. |

Existing client credentials were preserved. Both Google variable names contain configured strings; their validity and consent-screen configuration have not been verified with Google.

Server names:

| Name | Purpose |
| --- | --- |
| `CLIENT_URL` | Allowed frontend CORS origin. |
| `AUTH_ISSUER` | Required verified JWT issuer. |
| `AUTH_AUDIENCE` | Required verified JWT audience. |
| `AUTH_JWKS_URL` | Better Auth's public signing-key discovery endpoint. |

For local development, the frontend origin, issuer, and audience consistently use `http://localhost:3000`; JWKS is served at `http://localhost:3000/api/auth/jwks`. These are public local endpoint definitions, not secret values. Server `MONGODB_URI`, `DB_NAME`, `PORT`, `DNS_SERVERS`, and unrelated variables were preserved. Production auth URLs must use HTTPS, and the production frontend/base/issuer/audience/JWKS configuration must be aligned before deployment.

Keep `BETTER_AUTH_SECRET` stable: changing it can invalidate sessions and prevent decrypting stored signing keys. Never copy it into Express, logs, client bundles, or documentation.

## JWT issuance and Express verification

The JWT plugin defaults are retained: EdDSA/Ed25519, encrypted private-key storage, and a 15-minute expiry. `definePayload` adds only `email`; Better Auth supplies the user ID as standard `sub` and adds `iat`, `exp`, `iss`, and `aud`. No name, photo, session token, OAuth token, or other profile fields are added.

After a user has a valid Better Auth session, future frontend code can obtain a short-lived API token:

```js
import { authClient } from "@/lib/auth-client";

const { data, error } = await authClient.token();
if (error || !data?.token) {
  throw new Error("Please sign in before continuing.");
}

// For a future authorized private operation:
const headers = { Authorization: `Bearer ${data.token}` };
const apiOrigin = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";
const response = await fetch(new URL("/books?page=1&limit=6", apiOrigin), { headers });
// This public read demonstrates transport only. Future private routers must
// mount authenticate before their controller to enforce token verification.
```

Keep the token in memory and retrieve another from the persistent Better Auth session after expiry. Do not log tokens or use the session cookie itself as an Express bearer token. A JWT remains valid until its expiry even if the session is logged out; immediate revocation is not added in this foundation.

Express exports `authenticate` and the testable `createAuthenticate` factory from `src/middleware/authenticate.js`. Mount `authenticate` before future private controllers. No global auth guard is added: health and Books GET listing remain public, and the prepared private book-detail router remains unmounted until that route's integration phase.

Verification uses `createRemoteJWKSet` and `jwtVerify`, permits only EdDSA, verifies issuer/audience/expiry, requires `sub`, `email`, `exp`, and `iat`, and validates identity types. The verified identity is `req.user = { id, email }`; request bodies/queries never establish identity. The resolver is reused per configuration, with a five-second fetch timeout, ten-minute cache, and thirty-second refresh cooldown.

Missing/malformed/invalid/expired tokens and JWKS network failures fail closed with the existing JSON `UNAUTHORIZED` error (401) and `WWW-Authenticate: Bearer`. No raw network details or bearer values are returned or logged. Missing/invalid verifier configuration produces a fixed 503; startup validates configuration before serving requests. New signing keys are discovered through jose's resolver refresh behavior.

## CORS and request security

Express continues allowing exactly `CLIENT_URL` with Authorization and Content-Type headers. Better Auth cookies are same-origin with Next; Express bearer requests do not need cross-origin cookies or wildcard credentialed CORS.

Helmet adds API security headers. express-rate-limit allows 300 API requests per minute per IP with standard rate headers and consistent JSON 429 errors; health is exempt. Express does not blindly trust forwarded IP headers. Better Auth's own limiter is enabled, with its endpoint-specific defaults retained, to protect auth routes hosted by Next. Memory counters are per process and reset on restart; deployment proxy trust and a shared limiter store should be configured if the apps later run behind multiple instances.

## Google OAuth manual setup

1. In Google Cloud Console, configure the consent screen, audience, and testing users as appropriate.
2. Create/select an OAuth client of type Web application.
3. Set the local JavaScript origin to `http://localhost:3000` and the authorized redirect URI to `http://localhost:3000/api/auth/callback/google`.
4. Configure the matching client ID/secret privately in the existing client `.env`, then restart Next.js. For deployment, register the HTTPS production callback separately.
5. Future UI can call `authClient.signIn.social({ provider: "google", callbackURL: "/" })` when the credentials are ready. Do not add a second Google callback handler in Express.

No Google login, consent-screen changes, or external credential validation were performed by this task.

## Verification

From `booknook-client`:

```sh
node --test test/auth.test.js test/books-api.test.js
npm run lint
npm run build
```

Auth tests use Better Auth's memory adapter with generated test-only secrets, so they create no Atlas user accounts. They exercise password policy, Google absence, registration, independent session reads, hashed password storage, JWT minimal claims, 900-second lifetime, public JWKS, encrypted private JWK storage, login, password changes, and logout.

From `booknook-server`:

```sh
node --test
```

The existing `npm test` placeholder and dev/start scripts are unchanged. There is no configured server lint script; syntax checks use `node --check`. Server tests use real cryptographic signatures and a mocked remote JWKS fetch, covering missing/malformed headers, invalid signatures, expiry, wrong issuer/audience, valid identity, missing claims, algorithm rejection, JWKS failure, resolver reuse, rate limiting, and the existing public API contracts.

Live local checks also verified the client Atlas connection/ping and the real MongoDB adapter's public JWKS endpoint. Through Next.js, anonymous session lookup returns 200 with null, anonymous token retrieval returns 401, and JWKS returns 200 with public keys only. Google OAuth and real-user registration/login were not exercised against Atlas.

Final results for this phase: 21 client tests and 33 server tests passed; client ESLint and production build passed. Server syntax checks passed; no server lint script is configured. After restarting the apps to load local configuration, the real Express health and book-list endpoints returned 200 with matching CORS and Helmet's `nosniff` header. Direct Node client tests emit Node's module-detection warning because the client package has no explicit ESM type; it does not affect the test results or Next.js build.
