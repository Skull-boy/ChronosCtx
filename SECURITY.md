# Security Policy

ChronosCtx stores a user's reasoning state and file history on their own machine, and serves it over a loopback HTTP daemon. A vulnerability here is not only a crash: it can expose private project content, restore the wrong files, or launder untrusted text into trusted context.

## Reporting a vulnerability

**Primary channel: GitHub private vulnerability reporting.** Open the repository's **Security** tab → **Report a vulnerability**. This creates a private advisory visible only to you and the maintainers.

If you cannot use GitHub, open a public issue containing only the words "security contact requested" and no technical detail; a maintainer will provide a private channel.

Do **not** include exploit details, credentials, or user data in a public issue.

### Encryption and contact status

- A project PGP key and a `security@` mailbox are **release-blocking deliverables for 1.0**, tracked in `docs/security/disclosure.md`.
- No fingerprint or address is listed here until a real key exists with a documented owner. A placeholder fingerprint in a security policy is worse than none, because it invites encrypted reports nobody can read.
- Until then, GitHub private advisories are the supported encrypted-at-rest channel; GitHub handles transport encryption and access control.

## What to include

- Affected version or commit (and platform, if it matters).
- A minimal reproduction: command sequence, config, and the smallest project state that triggers it.
- The impact you believe it has, and the boundary you crossed (for example: "a web-sourced node renders as `verified`", "a `Host` header from a non-loopback origin is accepted", "a symlink escapes `CHRONOS_HOME`").
- Whether the issue is already public.

Do not attach a real project database or captures. A synthetic reproduction is enough, and safer for you.

## Response targets

| Stage | Target |
| --- | --- |
| Acknowledgement | ≤ 72 hours |
| Triage and severity assignment | ≤ 5 business days |
| Fix — critical / high | ≤ 30 days; 72 hours if actively exploited |
| Fix — medium | ≤ 90 days |
| Fix — low | Next scheduled release |
| Patch for an advisory in a runtime dependency | **≤ 72 hours** from the advisory (roadmap §3.5) |
| Emergency revocation of a bad release | Same day: deprecate/unpublish, publish a fixed version, post an advisory |

These are targets, not a warranty. If a fix will take longer, you get an explanation and a revised date rather than silence.

## Disclosure

Coordinated disclosure, **90 days** by default, shorter by mutual agreement, longer only if a fix genuinely requires it and both sides agree in writing. We will credit you in the advisory unless you ask us not to.

## Supported versions

ChronosCtx has no public release yet. This table activates at 1.0 and is updated in the same pull request that changes the supported set.

| Version | Supported | Notes |
| --- | --- | --- |
| `main` (unreleased) | Security fixes only | Development branch; no stability promise |
| `0.x` prereleases | No | Superseded by the next prerelease |
| `1.x` | Activates at 1.0 | Latest minor receives fixes; previous minor receives critical fixes for 90 days |

## Scope

In scope:

- the daemon's HTTP surface: authentication, `Host`/`Origin` handling, request limits, route validation;
- path handling: node-path grammar, alias resolution, object-store and workspace containment, symlink and case-collision refusal;
- the epistemic gate: any path that renders `unverified` or `stale` content as trusted, or that writes `status` outside the gate;
- snapshot and rewind correctness: a rewind that loses data, restores outside the workspace, or claims to undo an irreversible side effect;
- supply chain: a published artifact that resolves or executes a dependency at install time;
- secret handling: credentials or tokens appearing in nodes, capsules, logs or captures.

Out of scope:

- vulnerabilities in a harness or browser that ChronosCtx integrates with, unless our integration causes them;
- physical access to an unlocked machine, or an attacker who already controls the user's account;
- denial of service by a local process that can already read `CHRONOS_HOME`;
- the web bridge's dependence on third-party DOM structure — selector breakage is a correctness issue handled by the adapter update SLA, not a security report.

## Safe harbour

Good-faith research on your own machine and data is welcome. Do not test against other users, do not exfiltrate data, and do not run destructive rewinds against a project you do not own. We will not pursue legal action for research that follows this policy.

## More detail

`docs/security/threat-model.md` (Phase 1 deliverable) covers the loopback-only default, DNS rebinding, token scoping and theft, path traversal, prompt injection via captured content, synced-drive corruption, and the extension permission surface.
