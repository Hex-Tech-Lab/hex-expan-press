# Follow-up: full-history secret audit

- **Status:** open. No audit run is recorded in this document.
- **Priority:** High.
- **Owner:** blank, for the founder to assign.

## Scope

- Every commit reachable from every branch and every tag in the repository.
- Scanned with a gitleaks config read from the protected base branch, not from the branch under review.

## Handling rules

- Findings are reviewed in a private channel.
- No secret value goes into this repository, a pull request, or CI logs. A finding is recorded by its commit, path and rule only.
- Each finding is classified as one of: confirmed, false positive, or unresolved.

## Closing rule

Close this follow-up only when both hold:

1. Every finding has a final disposition. A false positive needs no further action. A confirmed finding is dispositioned only after its credential is rotated or revoked. An unresolved finding keeps the follow-up open.
2. Every confirmed credential is rotated or revoked at its provider, and the old credential is verified dead.

## Findings

None recorded yet.
