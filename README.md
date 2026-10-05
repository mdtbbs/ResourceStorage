# MDTBBS ResourceStorage

`res.mdtbbs.cn` is the file service for forum resources. MindFourm remains the source of truth for resource metadata, ownership, review state, permissions, and download counts. `file.mdtbbs.cn` and the existing `download-site` continue to serve Mindustry game releases and public downloads.

This is a small, single-node Node.js/TypeScript service. It stores bytes on local disk, stores metadata in SQLite, and identifies physical objects by SHA-256.

## Request flow

```text
MindFourm backend -- Service API Key --> POST /api/v1/uploads
       |                                      |
       +---- passes short upload token ------+
Browser -- PUT binary + short token --> /upload/:sessionId
                                         |
                                         +--> SQLite + local SHA-256 object

Browser -- GET /o/:publicId/:filename --> EdgeOne --> ResourceStorage origin
MindFourm backend -- short private URL --> /private/:token
```

The browser only receives the one-time upload token or a short-lived private download token. It must never receive `RES_SERVICE_API_KEY`.

## Requirements and local development

- Node.js 22 or newer
- A writable persistent data directory

```bash
npm ci
cp .env.example .env
# Replace RES_SERVICE_API_KEY with: openssl rand -hex 32
npm run db:migrate
npm run dev
```

The service listens on port `5200` by default. The first startup applies pending files from `migrations/`; `npm run db:migrate` can also apply and list them explicitly.

Run checks with:

```bash
npm test
npm run lint
npm run build
git diff --check
```

The test suite creates temporary SQLite databases and file roots; it does not require a live forum, CDN, or production database.

## Configuration

Copy `.env.example` and set a unique key with at least 32 random bytes. Keep the environment file readable only by the service account.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `5200` | HTTP listener behind the origin reverse proxy |
| `DATA_ROOT` | `./data` | Persistent object and temporary upload directory |
| `DATABASE_PATH` | `$DATA_ROOT/resource-storage.sqlite` | SQLite database file |
| `RES_SERVICE_API_KEY` | required | Server-to-server bearer credential; minimum 32 bytes |
| `RES_ADMIN_API_KEY` | unset | Optional separate key for GC and integrity endpoints; the service key also works |
| `PUBLIC_BASE_URL` | `https://res.mdtbbs.cn` | Public URL placed in upload-session and private-link responses |
| `MAX_OBJECT_SIZE` | `268435456` | Maximum upload size in bytes (256 MiB) |
| `UPLOAD_SESSION_TTL_SECONDS` | `900` | Upload token validity; defaults to 15 minutes |
| `PRIVATE_DOWNLOAD_TTL_SECONDS` | `300` | Default signed-download lifetime |
| `GC_GRACE_DAYS` | `7` | Minimum unbound object age before GC |
| `ACCESS_LOG_RETENTION_DAYS` | `210` | Source access log retention, about seven months |
| `CORS_ALLOWED_ORIGINS` | `https://mdtbbs.cn,http://localhost:3000` | Exact browser origins allowed to use temporary upload tokens or read downloads |
| `TRUST_EDGEONE` | `false` | Trust EdgeOne client IP headers only behind a protected origin path |
| `TRUST_PROXY_HOPS` | `1` | X-Forwarded-For fallback hop count, used only when `TRUST_EDGEONE=true` |

In production, `PUBLIC_BASE_URL` must use HTTPS and contain only an origin. `CORS_ALLOWED_ORIGINS` must be a comma-separated list of exact HTTPS origins; wildcard origins are rejected. Remove local development origins from the production environment.

## API

All JSON errors use `{ "error": { "code": "...", "message": "..." }, "request_id": "..." }`. API responses, uploads, and private downloads use `Cache-Control: private, no-store`.

| Method and path | Authentication | Purpose |
| --- | --- | --- |
| `GET /health` | none | Checks process response, SQLite access, and `DATA_ROOT` writability |
| `POST /api/v1/uploads` | Service API Key | Deduplicate a known verified hash or create a short-lived upload session |
| `PUT /upload/:sessionId` | One-time upload token | Stream an `application/octet-stream` body to temporary disk, verify size/hash, install by SHA-256 |
| `GET /api/v1/objects/:id` | Service API Key | Read object metadata; `id` accepts internal ID or public ID |
| `GET /api/v1/objects/:id/content` | Service API Key | Stream content to MindFourm or a renderer; supports Range and ETag |
| `POST /api/v1/objects/:id/bindings` | Service API Key | Idempotently bind an object to an opaque owner key and visibility |
| `DELETE /api/v1/objects/:id/bindings/:bindingId` | Service API Key | Remove a binding; does not delete bytes |
| `POST /api/v1/objects/:id/signed-url` | Service API Key | Issue a short-lived private download URL |
| `GET /private/:token` | Short-lived URL token | Private, no-store download with Range support |
| `GET` or `HEAD /o/:publicId/:filename` | Public binding | Public download cached for 24 hours, with Range, ETag, and UTF-8 filename support |
| `POST /api/admin/gc` | Service or admin key | Run GC; `{ "dry_run": true }` reports candidates without deleting |
| `POST /api/admin/integrity/scan` | Service or admin key | Check all non-quarantined objects and mark missing/corrupt rows |

### Create and upload

The backend creates the session. It may send `sha256` when it has already calculated it:

```http
POST /api/v1/uploads
Authorization: Bearer <RES_SERVICE_API_KEY>
Content-Type: application/json

{
  "sha256": "optional 64-character lowercase hex digest",
  "size_bytes": 123456,
  "mime_type": "application/octet-stream",
  "original_filename": "example.msch",
  "purpose": "resource_version"
}
```

If a verified object with the same digest and size already exists, the response contains `deduplicated: true` and the object. Otherwise the service returns `upload.session_id`, `upload.url`, `upload.token`, and `upload.expires_at`. Return that short token to the browser for the upload only:

```http
PUT /upload/<session_id>
Authorization: Bearer <one-time upload token>
Content-Type: application/octet-stream
Content-Length: 123456

<raw file bytes>
```

The body is streamed to a unique `temp/*.part` file while counting bytes and computing SHA-256. A bad size, expected digest, content type, or interrupted body fails the session and removes the temporary file. An invalid token does not consume the session. A valid token can complete only one upload.

After upload, MindFourm binds the returned object. Public access is enabled only by an existing `visibility: "public"` binding. Private objects can be downloaded by issuing a short signed URL with optional `filename` and `expires_in` (30–3600 seconds).

```http
POST /api/v1/objects/<object-id>/bindings
Authorization: Bearer <RES_SERVICE_API_KEY>
Content-Type: application/json

{
  "namespace": "mindforum",
  "owner_type": "resource_file",
  "owner_id": "<ResourceFile public_id>",
  "visibility": "public"
}
```

For a private download, `POST /api/v1/objects/<object-id>/signed-url` with the same server-side bearer key and a body such as `{ "filename": "report.txt", "expires_in": 300 }`. The response contains the absolute short-lived URL and its expiry.

### Range and caching

The public endpoint returns `ETag: "<sha256>"`, `Accept-Ranges: bytes`, `Content-Length`, `Content-Disposition`, and `Cache-Control: public, max-age=86400`. It supports single byte ranges, conditional `If-None-Match` requests, and `HEAD`. Service content and private links also support a single byte range but are never publicly cacheable; API and private responses use `Cache-Control: private, no-store`.

Public binding is a publication decision. Removing a binding blocks future origin requests, but cannot recall a response already cached by EdgeOne or a browser. Only bind files intended for public distribution. Public responses are cached for 24 hours by default; administrators can manually purge EdgeOne in an urgent takedown. For updated content, upload a new object; it receives a different content hash and public ID. A purge cannot remove copies already stored by browsers.

## SQLite and object layout

SQLite runs in WAL mode with foreign keys enabled. The database and temporary upload files are created with owner-only file permissions. Versioned SQL migrations create:

- `objects`: IDs, public IDs, unique SHA-256, size, MIME type, display filename, relative storage key, state, creation and verification times.
- `upload_sessions`: expected size/hash, upload metadata, token hash, state, expiry, and completion time.
- `object_bindings`: opaque namespace/owner tuple, unique across `(namespace, owner_type, owner_id)`, plus public/private visibility.
- `private_download_tokens`: hash-only short private tokens with object and expiry references.
- `access_logs`: origin request time, object/action, client IP, user agent, method, sanitized path, status, bytes sent, and request ID.

Object states are `verified`, `missing`, `corrupt`, and `quarantined`. Integrity scan marks unavailable bytes `missing` or `corrupt`; it does not repair or re-verify a previously failed object automatically.

Physical paths do not use client filenames:

```text
DATA_ROOT/
├── objects/
│   └── sha256/
│       └── ab/
│           └── <64-character-sha256>
└── temp/
```

Installation verifies or creates a same-filesystem atomic hard link into the hash path before the SQLite write transaction. The short transaction re-checks upload session state and the hash row before inserting, so simultaneous uploads of identical bytes create one object row. On transaction failure, a failed newly installed file is removed only after a locked check confirms that no object row or in-flight upload can use it. Object deletion is a separate GC operation. GC requires no bindings, age beyond the grace period, no relevant active upload session, and no unexpired private link. Quarantined objects are retained for manual review.

## Logging and download counts

RES logs only requests that reach the origin. An EdgeOne cache hit is served at the edge and is absent from `access_logs`; full CDN request logs remain in EdgeOne. MindFourm continues to count resource downloads through `DownloadGrant` and its Resource/ResourceVersion/File statistics. RES does not treat Range requests as downloads and does not aggregate CDN logs.

Logs never store cookies, Authorization headers, upload/private tokens, request bodies, or passwords. Private-token paths are stored as `/private/:token`; upload paths are stored as `/upload/:sessionId`. Retention runs daily and defaults to 210 days.

## EdgeOne configuration

Add `res.mdtbbs.cn` to EdgeOne and point the origin at the ResourceStorage reverse proxy. Configure rules in this order:

1. `/api/*`, `/upload/*`, and `/private/*`: **do not cache**, regardless of origin response headers.
2. `/o/*`: follow the origin `Cache-Control` header (`public, max-age=86400`) so public resources can be cached for 24 hours. Do not force a generic cache header over private/API routes.
3. Keep the filename segment in the public URL/cache key because it controls `Content-Disposition`.
4. The service varies browser CORS responses by `Origin`; enable EdgeOne's `Vary: Origin` handling for `/o/*`, and do not add a second, conflicting CORS response-header rule at EdgeOne.
5. Enable Range origin pulls if desired and verify `206`, `Content-Range`, and the returned bytes through the public EdgeOne hostname.

Tencent's [EdgeOne content cache rules](https://intl.cloud.tencent.com/zh/document/product/1145/54213) describe source-header caching and the explicit no-cache policy. EdgeOne's default origin headers include [`EO-Connecting-IP` and `EO-LOG-UUID`](https://edgeone.ai/document/zh/54211). Set `TRUST_EDGEONE=true` only after the origin firewall or security group accepts traffic from trusted EdgeOne origin-pull IP ranges; otherwise a direct client could forge proxy headers. The service prefers `EO-Connecting-IP`, uses the configured X-Forwarded-For hop as a fallback, and accepts a request/log UUID when present.

EdgeOne may identify the preceding proxy in `EO-Connecting-IP` when another proxy sits in front of EdgeOne. Verify the actual proxy chain and forwarded-header behavior before enabling trust in that topology. Source-origin access restriction is the boundary that makes these headers trustworthy.

## Maintenance

```bash
npm run gc -- --dry-run
npm run gc
npm run integrity
```

Dry-run output includes `candidates`, `bytes_reclaimable`, `deleted`, and `failed`. `npm run gc` without `--dry-run` deletes eligible objects. Integrity output includes `checked`, `healthy`, `missing`, `corrupt`, and `failed`.

## Deployment

### Docker

```bash
docker build -t mdtbbs/resource-storage .
docker run -d --name resource-storage \
  --env-file /etc/resource-storage/resource-storage.env \
  -p 127.0.0.1:5200:5200 \
  -v /var/lib/resource-storage:/data \
  --restart unless-stopped \
  mdtbbs/resource-storage
```

The image runs as the unprivileged `node` user, uses `/data` for SQLite and objects, and includes a `/health` container check. Keep a durable volume mounted at `/data`; for a host bind mount, make the host directory writable by the image's `node` UID (1000).

### systemd

Install the built project under `/opt/resource-storage`, create the `resource-storage` system user and writable `/var/lib/resource-storage`, then copy `deploy/resource-storage.service` into `/etc/systemd/system/`. Store production variables in `/etc/resource-storage/resource-storage.env` with mode `0600`; set `DATA_ROOT=/var/lib/resource-storage` and optionally `DATABASE_PATH=/var/lib/resource-storage/resource-storage.sqlite`. Reload systemd and start the service. Put the origin reverse proxy in front of `127.0.0.1:5200` and use a persistent disk with enough capacity for active objects plus temporary uploads.

No production deployment or changes to `file.mdtbbs.cn` are performed by this repository's build/test workflow.
