# ResourceStorage agent notes

This repository is the MDTBBS forum resource file service. Keep it a small, single-node Node.js/TypeScript and SQLite service with local SHA-256 content-addressed files.

Before changing code, inspect this file and `README.md`. Keep forum resource metadata, ownership, review state, and download counts in MindFourm; `object_bindings` only links an object to an opaque owner key and visibility.

## Commands

- `npm test`: Node test-runner integration tests using temporary SQLite databases and data roots.
- `npm run lint`: strict TypeScript check, including tests.
- `npm run build`: production TypeScript build.
- `npm run db:migrate`: apply and list SQLite migrations.
- `npm run gc -- --dry-run`: inspect old unbound object candidates.
- `npm run integrity`: scan stored object bytes and mark missing/corrupt rows.

## Safety boundaries

- Never place `RES_SERVICE_API_KEY`, upload tokens, private download tokens, cookies, or request bodies in logs.
- Browser clients receive only short-lived upload/private-download tokens. The service API key stays server-side.
- Do not use client-supplied proxy headers unless `TRUST_EDGEONE=true`; only trust EdgeOne headers when origin access is restricted to trusted EdgeOne traffic.
- Do not delete stored objects as part of binding deletion. Physical deletion belongs to grace-period GC.
- Do not change `file.mdtbbs.cn` or the existing `download-site` service from this repository.
- Public URLs use a 24-hour cache lifetime. Treat public binding as a publication decision; revocation does not recall copies already cached by EdgeOne or browsers. Administrators can manually purge EdgeOne for urgent takedowns.
- Keep migrations additive and versioned under `migrations/`.
