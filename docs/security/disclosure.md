# Disclosure channel setup

`SECURITY.md` is the public policy. This file is the maintainer checklist behind it. It exists so that "no PGP key is listed yet" is a tracked, dated decision rather than an omission.

## Current state (Phase 1)

| Item | Status | Notes |
| --- | --- | --- |
| GitHub private vulnerability reporting | **Active** | Primary channel. Repository Settings → Code security → Private vulnerability reporting. |
| `security@` mailbox | **Not provisioned** | Must exist before the first public release; a forwarder to a maintainer address is acceptable. |
| Project PGP key | **Not generated** | Must be generated, published with a fingerprint, and have a documented revocation path before 1.0. |
| Acknowledgement SLA (72 h) | **Active** | Stated in `SECURITY.md`; tracked per report, not by a bot count. |
| Advisory template | **Not written** | Add alongside the key, before 1.0. |

No placeholder address or fingerprint is published. An unusable encrypted channel is worse than a clear "use GitHub advisories", because it makes a reporter believe a message was received.

## Before 1.0 — release-blocking

1. Provision the mailbox and confirm it receives mail from an external account.
2. Generate an Ed25519 PGP key with no expiry shorter than two years. Store the private key offline; the passphrase is not in CI, not in a password manager shared with the repository, and not in an issue.
3. Publish the public key at `docs/security/keys/<fingerprint>.asc` and add the fingerprint to `SECURITY.md` in the same pull request.
4. Test the channel: encrypt a message to the published key, decrypt it, and record the date in this file.
5. Write `docs/security/advisory-template.md` with: affected versions, impact, workaround, fixed version, credit policy.
6. Add a release check that fails if `SECURITY.md` names a mailbox or fingerprint that is absent from the repository.

## Rotation and revocation

- A key is rotated at least every two years, or immediately on suspected compromise.
- Rotation publishes the new key, keeps the old public key for verifying past advisories, and states the overlap window.
- Revocation is announced in `SECURITY.md` and in the next advisory; it is never silent.

## Handling a report

1. Acknowledge within 72 hours with a private thread and a tracking id.
2. Reproduce against the reported commit; classify severity using the impact, not the reporter's wording.
3. Fix on a private branch, add a regression test that fails without the fix, and request a CVE when the impact warrants it.
4. Publish the advisory, credit the reporter unless they decline, and add the regression test to the permanent suite.
5. If the issue is a dependency advisory, the 72-hour patch target in roadmap §3.5 applies and the release cooldown is waived only for a fix that resolves it.
