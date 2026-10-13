# G8 P1-FIX acceptance — staging only

Date: 2026-10-13 (Asia/Ho_Chi_Minh). Branch: `feat/p3-7.3-g8-safety`.

## Verdict

**P1 review: NO-GO. G8 production: NO-GO.** The transactional audit and concurrent *admission* quota tests pass, but two safety guarantees remain unproven: (1) a failed emergency audit plus a failed durable latch write can leave another process with a readable, stale `ai_halted=false` row; (2) `tokenReservationPerTurn` is an accounting reservation, not a provider-enforced maximum on all OpenClaw/OpenAI consumption. No GitHub push, master merge, production migration, PM2 restart, production deployment, credential refresh, AI/worker/outbound enablement, or production event exclusion occurred in this work.

## Artifact and lineage

- Runtime code commit: `e327258e039f8a2971248427c0c2b1447cc9aac2`; staging image `kido-sales-staging:e327258`, image digest `sha256:3ad76cdf10a5a492cab6ae17cc3229ee62938444e56330c8a9f52da017b65189`, OCI revision label matches that commit. The provisional `63c1652`, `c966c55`, and `fde5b33` images/hashes are not release evidence.
- Acceptance script commit: `a44f16675540ea8072afd245b1de04fd723bb00a` (R1/G8/worker/control script corrections). These scripts run from the worktree; all temporary staging containers for final acceptance were explicitly pinned with `STAGING_API_TAG=e327258`. Main staging-api also ran that image.
- `git merge-base --is-ancestor baaedb9 HEAD` returned 0. No force-push or lineage rewrite.
- Final source diff from `0322f02` passes `git diff --check`. A heuristic scan of added lines found zero OpenAI/GitHub/AWS key patterns, private-key headers, literal bearer secrets, and listed secret environment assignments; no real `.env` was added (`.env.example` is tracked). `gitleaks`/`trufflehog` are unavailable, so this is not a full secret-scanner attestation.

## Root cause and changes

1. Existing `ActivityLogService.record()` is best-effort, so using it after a state write permitted an unaudited commit. Recruitment Operations now has `RecruitmentAuditService.recordMandatory(em, ...)` using the *same* `EntityManager` transaction for event exclusion, operator stop/resume, and auto-halt. The global ActivityLog service was not changed. State and audit commit together or roll back together; HTTP does not return 200 for a failed commit. Idempotent retries that make no change make no new business audit. Audit carries actor, action, before/after, result, and DB-created timestamp. A TypeORM `UPDATE ... RETURNING` tuple-handling bug found in review was fixed and verified against actual PostgreSQL audit snapshots.
2. The old quota check and provider call had a TOCTOU window. `reserve()` now locks the singleton runtime row (`id=1`) and then the event row in one short PostgreSQL transaction, computes VN day/month **after lock acquisition**, counts sender/global turns and reserved/actual tokens, and writes reservation fields on the event. The pre-existing singleton avoids first-counter-row creation races; fixed lock order avoids a lock-order cycle among these operations. The provider call happens after commit, never with a DB transaction open. The event's reservation survives crash/retry and is not duplicated.
3. The event gets `ai_provider_dispatched_at` before OpenClaw invocation. After that point timeout, 5xx, crash, or ambiguous response is **not retried blindly**; a stored canonical reply can be reused, otherwise the event is dead-lettered for HR reconciliation. Before dispatch, infrastructure retry is at most three claims, with exponential backoff from 30 seconds to 15 minutes by default. The gateway timeout defaults to 240 seconds. Missing usage or actual token usage above reservation triggers auto-halt, but cannot undo tokens already spent.
4. A failed emergency stop/auto-halt transaction attempts a separate durable `failsafe_halted` latch, aborts in-flight work locally, and makes unreadable runtime controls fail-closed. A 500 ms worker watchdog and fresh runtime checks fence completion and outbound dispatch. The latch is a **safety-only fallback state**, not a fake `RUNTIME_STOP` audit entry; clearing it requires an audited all-scope resume.

## Fault-injection and concurrency on PostgreSQL staging

| Test | Result |
| --- | --- |
| Audit INSERT failure: exclude; operator stop; resume; auto-halt | 4/4: business mutation rolled back; emergency failures engaged fallback; no false HTTP success |
| Actual HTTP audit failures: stop, resume, exclude | 3/3: non-2xx and rollback |
| Two concurrent operator stop/resume; two concurrent auto-halt workers | 2/2: serialized state changes; one audit per committed change, auto-halt one alert |
| Runtime-controls unreadable through PostgreSQL fault | 1/1: local fail-closed |
| 16, 32, 64 workers for one global slot | 3/3: exactly one reservation each run |
| Many senders for one global slot; one sender for one sender slot | 2/2: exactly one reservation |
| Same event retry and crash after reservation | 1/1: same reservation, no double charge; dispatched outcome becomes uncertain/no blind retry |
| VN day/month boundary SQL | 1/1: correct date bucketing; **not** a real clock-crossing load test |

The PostgreSQL script returned 14/14 PASS (`p1fix-1791871757037-bff3f0`); the HTTP script returned 3/3 PASS (`1791871763856`). In-flight stop → HR takeover → outbound resume and timeout-after-provider-dispatch are covered by G8 acceptance below. These results prove the tested failure modes, not a global guarantee under asymmetric DB/network failure.

## Regression matrix on the final runtime image

| Suite | Result | Evidence/limitation |
| --- | --- | --- |
| Build | PASS | `npm run build`; Docker image built from clean commit above |
| Recruitment unit | 27/27 suites, 475/475 tests | Includes bounded pre-dispatch retry test |
| Full unit | 98/99 suites, 1528/1529 tests | Sole pre-existing, out-of-scope `src/suggest/expense-request.spec.ts`: test mock lacks `manager.findOne`; not edited |
| R1 event exclusion | 18/18 | run `1791871112`, idempotency, HR auth, audit, no processing of excluded event |
| G8 safety | 44/44 | run `1791870947`; stop/resume, pilot, quota, policy, in-flight stop, takeover, outbound resume, timeout no-blind-retry |
| Worker | 36/36 | run `1791871141`; `SKIP_REAL=1`, mock OpenClaw and real staging PostgreSQL; real LLM conversation portion skipped |
| HR takeover / control | 56/56 | run `1791871226`; in-flight fence, HR message, UNKNOWN reconciliation, old AI outbox suppressed |
| Outbound | 41/41 | run `1791871421`; sender, retry/UNKNOWN, crash, OA teacher regression |
| Webhook | 55/55 | run `1791871559`; signature, dedupe, OA isolation, DB failure |
| Quarantine | 49/49 | run `1791871603`; capacity, concurrent verify, data retention, OA teacher regression |
| Tool E2E | 20/20 | run `1791871693`; gateway → Recruitment plugin → staging API → staging DB; not a real LLM conversation test |

The first two final-image G8 runs failed the token fixture because their test budget ignored historical staging rows with usage but no reservation. The acceptance script was corrected to count those legacy rows exactly as the admission query does; the third, final-image run passed 44/44. One run was also interrupted when that script was edited while running. These failed/invalid runs are **not** release evidence. The scripts use unique fixture run IDs and clean up temporary containers; the staging DB volume was **not recreated from zero**, so “clean” means fixture isolation rather than a pristine database. Some staging scripts back up then remove only their pending synthetic outbox fixtures; manifests include `/opt/kido-recruiter/backups/outbox-fixtures-20261013-125856.manifest`, `...-125741.manifest`, `...-130028.manifest`, and `...-130802.manifest`. No production rows were deleted.

## Quota, retry, and cost

- Defaults: sender 10/hour and 40/24h, global 300 turns/day, 30 million reserved tokens/day, 500 million/month, 200,000 tokens reserved per new turn. At default reservation the token budgets admit at most 150 new turns/day and 2,500/month, even before other limits and legacy usage. These are **admission** ceilings, not proven provider spend ceilings.
- The official OpenAI Docs page for `gpt-5.6-terra` lists text rates of USD $2/1M uncached input, $0.20/1M cached input, and $12/1M output as of this report: <https://developers.openai.com/api/docs/models/gpt-5.6-terra>. Illustrative case only: 150 turns/day at 90k input + 1k output each would be about **$28.80/day** with no cache, or **$9.36/day** if 80% of input is billed as cached. At 2,500 turns/month with the same mix: about **$480** or **$156** respectively. This excludes cache writes, tools, context surcharges, taxes, and any extra internal model calls. It is not a billing cap or a prediction of actual traffic.
- Even with atomic reservations, one OpenClaw turn can use more than 200k actual tokens or fail to report complete underlying usage. The code halts after detecting an overrun/missing usage, but the spend may already have occurred. A provider/project-side enforceable budget or a proven upper bound per turn, plus reconciliation against provider billing, is required before claiming “không vượt hard cap”.

## Migration, 3010/3011 compatibility, and rollback

- Original `1792700000000` remains unchanged. New additive `1792800000000` adds the fail-safe latch and per-event reservation/dispatch columns, checks, partial index, and `DISCARDED_RUNTIME_HALTED` enum value. On staging, `^recruitment_` entity/schema diff is 0; current runtime controls end at `false/false/false/false`. A deliberate `179280` down attempt with reservation data failed and rolled back with `P1-FIX state exists; reconcile before rollback`; schema remained intact. PostgreSQL cannot trivially remove an enum value, so `down` deliberately leaves an unused value if a data-safe down is eventually allowed.
- Static 3010/3011 compatibility: columns are additive and nullable/defaulted, so old binaries should ignore them; new binaries require `179270` then `179280` before startup. Both roles are configured with worker/outbound disabled by default. **Not verified by applying migrations or deploying new binaries to production 3010/3011.** Read-only local requests to each production port returned 503 on the AI route, which does not prove entity compatibility. The R1+AI Safety common release preflight remains a separate gate.
- Proposed rollback if later approved: keep AI/worker/outbound off; take verified DB backup; stop new dispatches; reconcile reservations, uncertain provider outcomes, pending outbox and audit; roll both backend binaries back together while retaining additive schema where possible. Do **not** run `179280.down()` or `179270.down()` while protected data exists. Rehearse any data migration and restoration on an isolated staging clone before production. No backup, migration, restart, or rollback was performed on production here.

## Open blockers and emergency fallback

1. **Cross-process asymmetric failure:** if the mandatory audit transaction and separate durable fail-safe `UPDATE` both fail in one instance, its RAM latch/abort protects that instance. A different instance that can still read an old healthy runtime row is not proven stopped. An independently operable, rehearsed emergency fallback must disable the dedicated worker/sender/gateway at the supervisor or network boundary under valid production authority, with verification that no new provider or Zalo requests occur. No such production action is authorized or tested here.
2. **Provider hard cap:** reservation is serialized and conservative, but actual provider usage is not bounded by it. Define and verify an enforceable per-turn/project cap and reconcile all provider usage, including timeout/unknown outcomes, before P1 GO.
3. **Evidence gaps:** no pristine-volume staging acceptance, real OpenClaw LLM conversation suite, real midnight-crossing concurrency test, or live 3010/3011 migration rehearsal on an isolated production-like clone. The unrelated full-unit failure also remains open.

**Requested handoff:** review this NO-GO report and approve a separate remediation/acceptance gate if desired. Do not proceed to P2, P3, G8.1, GitHub push, or production release from this report.
