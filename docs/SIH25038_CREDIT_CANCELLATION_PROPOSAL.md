# Proposal: cancellation of issued credits and privacy-preserving retirement

**Status: proposal only.** It is implemented as a separate contract with its own tests. It is **not deployed anywhere, not used by the backend, and not a replacement** for `blockchain/contracts/BlueCarbonRegistry.sol`, whose SHA-256 (`629fd89b…`) is unchanged. Adopting it needs your decision, a redeployment and a balance migration.

## The limitation today
The deployed registry is a custom contract (not ERC-20 or ERC-1155): credits are balances per verified record, with `issueCredits`, `transfer` and `retire`, each protected by a single-use reference. It has **no way to cancel, freeze or reverse** issued units. Consequently:
- A confirmed dispute cannot change the token. The registry's dispute workflow (`credit_disputes`, migration 010) pauses transfers and retirements **only through this system's API**. A holder who signs a contract call directly is not stopped by it. The reconciler would report that as a divergence, but it cannot prevent it.
- No off-chain "reversal" is offered, because it would claim to undo something the chain cannot undo.
- `retire(…, string reason, …)` publishes free text in a public event, so personal data could be written on-chain.

## The proposed change (`contracts/proposals/BlueCarbonRegistryCancellation.sol`)
Everything in the original stays: every original function, event and storage slot. Added after the original storage:
| Addition | Behaviour |
|---|---|
| `cancelCredits(recordId, holder, amount, caseHash, ref)` | Administrator only; the record must be CREDITED; the administrator must not be the record's verifier; `caseHash` (hash of the off-chain dispute decision) and `ref` (single-use, shared with transfer and retirement references) are required; reduces the holder's batch balance and the global balance; increments `batchCancelled` and `totalCancelled`; emits `CreditsCancelled`. Retired units cannot be cancelled (retirement stays final). No reason text or personal data is published. |
| `retireHashed(recordId, amount, reasonHash, ref)` | Same accounting as `retire`, but the event carries only a hash of the reason (the text stays in the registry database). |
| `outstanding()` | Now `totalIssued − totalRetired − totalCancelled`; identical to the original result until a cancellation occurs. |
Invariant, tested after mixed sequences: `totalIssued = Σ balances + totalRetired + totalCancelled`. `totalIssued` and project totals keep recording history; cancellation never rewrites issuance.

## Backward compatibility
A test compares the ABI of both contracts and fails if any original function or event signature is missing; the only additions are the two functions, two events, and the `batchCancelled(bytes32)` / `totalCancelled()` getters. A second test shows balances, retirement and `outstanding()` behave identically before any cancellation. Existing backend calls would keep working against a redeployed proposal contract; the backend would additionally need a `CREDIT_CANCEL` durable operation (idempotency key, probe by reference, finalize) and a `credit_reversals` table before the function could be used.

## Evidence (11 tests, `blockchain/test/proposals/Cancellation.test.js`, run with the 26 original tests: 37 passing)
Authorization (verifier, registrar, holder, outsider rejected; separation of duties even after the verifier becomes administrator); invalid states (not credited, zero amount, missing hash or reference, more than the balance, wrong holder, retired units); replay (reference reuse, reference shared with transfers and retirements, a reverted call does not consume its reference); events; the supply invariant on two batches; `retireHashed` accounting and replay. A mutation check (removing the reference marking in `cancelCredits`) makes two tests fail.
Not covered: formal verification, static analysis (Slither is not installed here), gas analysis, reentrancy review beyond noting that neither new function makes an external call and both update state before emitting events, and any independent audit.

## Legal and governance questions this does not answer
Whether cancellation is legally appropriate for a given credit, who may decide (the proposal lets one administrator act on a case hash; a multi-party decision, a time lock or a buffer pool may be required), how buyers are compensated, and how retired credits found to be invalid are handled (they cannot be cancelled here). These need NCCR policy, not code.

## Decision needed
1. Approve, change or reject the contract design. 2. If approved: redeploy on a local network first, migrate balances, add the durable operation and table above with tests, and review with an independent auditor before any public network.
