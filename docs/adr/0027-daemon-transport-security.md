# ADR-0027 — Daemon transport security: loopback guard, scrypt bearer tokens, filesystem probe

- **Status:** Accepted (Phase 1, 2026-11-24)
- **Related:** ADR-0001 (daemon-first), ADR-0025 (supply-chain model), roadmap §3.3–§3.4, gates 1.13 and 1.14
- **Evidence:** `packages/core-engine/src/daemon/{guard,server,tokens}.test.ts`, `packages/core-engine/src/fs/probe.test.ts`

## Context

The daemon is a local process, but "local" is not a security boundary. A web page can resolve its own hostname to `127.0.0.1` and issue requests to any port; the browser will attach the attacker's `Origin`. If the server trusts `Host` or omits CORS restrictions, a page can read the state graph, which contains proprietary architecture notes.

Two further constraints shape the implementation:

1. **Token storage must survive a stolen `CHRONOS_HOME`.** A plaintext token file would hand an attacker every scoped credential. A password-hashing function is required.
2. **Install-time dependencies are a hard budget.** ADR-0025 permits 1 package, 0 transitive dependencies and 0 lifecycle scripts at install time. `argon2` is a native addon with a build/install step, so the roadmap's original `argon2id` choice cannot be shipped without breaking that budget.

The filesystem is the third surface. WAL mode plus a shadow git repository assumes coherent locking and durable writes. SMB/NFS/AFP and sync clients (OneDrive, Dropbox, iCloud, Google Drive) do not provide that, and a checkpoint written through them is a corruption vector rather than a feature.

## Decision

### 1. Every request passes the loopback guard before routing

`guardRequest` validates `Host` first, then `Origin`.

- Accepted `Host`: `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>`. The port must equal the bound port. Missing, duplicated, malformed, userinfo-bearing, path-bearing, or non-loopback hosts are rejected with `403 HOST_NOT_ALLOWED`.
- Missing `Origin` is allowed for CLI and stdio clients. A present `Origin` must match an exact extension allowlist entry or `http://localhost:<port>` / `http://127.0.0.1:<port>` / `http://[::1]:<port>`. The literal `null` origin is rejected. Anything else gets `403 ORIGIN_NOT_ALLOWED`.
- CORS headers echo the exact origin and never use `*`. A rejected origin receives no CORS headers.
- WebSocket/SSE upgrades repeat the same guard. The upgrade handler currently answers `501` because no upgrade route exists yet; the check is in place before one is added.
- `X-Forwarded-Host` is never consulted. A reverse proxy must preserve the loopback `Host` or the daemon will (correctly) refuse the request.

### 2. Tokens are scrypt-hashed, scoped and expiring

- Format: `chr_<id>_<secret>`. The id is the base64url encoding of 8 random bytes and is therefore **fixed-width at 11 characters**. Parsing is positional, not a greedy regex, because base64url secrets may themselves contain `_`.
- Secret: 32 random bytes, base64url. Only the scrypt hash and a 16-byte salt are stored.
- Parameters: scrypt `N=16384`, `r=8`, `p=1`, `keylen=32`, `maxmem=64 MiB`. This is ~16 MiB of memory and roughly 50 ms per verification on a modern laptop. Parameters are stored per record so they can be raised later without invalidating existing tokens.
- Comparison uses `timingSafeEqual`. An unknown id, a wrong secret and an expired token all return the same `UNAUTHORIZED` shape.
- Scopes are `read < write < admin`. `admin` satisfies every requirement; `write` satisfies `read`.
- Expiry is absolute epoch milliseconds and optional. Revocation deletes the record.
- The token file is written atomically (temp file + rename), chmod `0600` on POSIX, and fails closed with `INTERNAL` if it is corrupt. It lives under `CHRONOS_HOME/tokens/`.

### 3. Filesystem type is probed before the database opens

- Network filesystem types (`nfs`, `nfs4`, `cifs`, `smbfs`, `smb3`, `afs`, `sshfs`, `fuse.sshfs`, `9p`, `virtiofs`, `glusterfs`, `ceph`, `davfs`, `ncpfs`) are refused.
- Sync-folder names and environment roots (`OneDrive*`, `Dropbox`, `Google Drive`, `iCloud Drive`, `pCloud`, `MEGA`, `Nextcloud`, `Seafile`, `Syncthing`, `Yandex.Disk`, `Box Sync/Drive`, macOS `~/Library/CloudStorage`) are refused.
- UNC paths are refused on Windows and POSIX.
- A write probe (create, fsync, rename, remove) runs for an existing directory and refuses read-only or write-broken volumes.
- An **undetermined** filesystem type is allowed and reported as `unknown`. Refusing every `unknown` would make the daemon unusable on platforms that do not expose a type; the write probe still catches the failure mode that matters.

All refusals use `UNSAFE_FILESYSTEM` with a remediation hint naming local-disk placement and `CHRONOS_HOME`.

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| Keep `argon2id` and ship a prebuilt native addon | Adds a binary artifact and a platform matrix to the release, and an install-time download/build path. Violates the 1-package / 0-transitive / 0-script contract. |
| `bcrypt` / `bcryptjs` | `bcrypt` is native; `bcryptjs` is pure JS but slower and adds a dependency for a primitive already in `node:crypto`. |
| Store tokens in plaintext with file permissions only | A stolen or backed-up `CHRONOS_HOME` exposes every scoped credential. Hashing is cheap here. |
| `Access-Control-Allow-Origin: *` | Lets any page read the graph. The whole point of the guard is that the origin is authenticated, not merely present. |
| Trust `X-Forwarded-Host` | Makes the guard bypassable by any client that can set a header. |
| Refuse `unknown` filesystems | Blocks containers, overlay filesystems and platforms that do not expose a type. The write probe is the actionable check. |
| Parse `Host` with a URL parser | `new URL("http://" + host)` accepts forms (userinfo, paths, trailing dots) that a `Host` header must never contain. The parser is explicit. |

## Consequences

- Every HTTP request pays one scrypt verification (~50 ms). The daemon is request-driven and the alternative — a session cache — weakens revocation, so the cost is accepted. A future cache can be added with an explicit revocation epoch.
- Tokens cannot be recovered from disk; the CLI prints them once at issue time. Rotation means issue + revoke.
- The exact-port `Host` rule means tests and clients must use the discovered port from `run/daemon.json`, not a guessed one.
- `allowAnonymous` exists for tests and an explicit local-development opt-in. It is not a default and the server constructor refuses to start without a token store unless it is set.
- The filesystem probe is conservative in the direction of refusing known-bad volumes, not in the direction of refusing unknown ones. The distinction is recorded in every result (`kind`, `fs_type`, `evidence`, `safe`).
- Gate 1.13 is the eight-case Host/Origin suite; gate 1.14 is the network/synced-drive probe. Both are executed by `scripts/verify-phase.mjs`.
