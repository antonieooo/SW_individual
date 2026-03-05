# Task D - Schemathesis Contract Testing

## Test execution setup

Schemathesis was run against all implemented services (five core services plus architecture-specific gateway and database services) in a containerized staging setup.

Execution flow:
1. Build and start all containers with Docker Compose.
2. Verify service readiness using `/status`.
3. Generate short-lived user/service tokens aligned with trust boundaries.
4. Run Schemathesis per service with required headers (`Authorization`, `x-internal-mtls`, and boundary-specific headers such as `Idempotency-Key`, `x-device-cert`, `x-db-credential`).
5. Run an additional negative authentication script to verify unauthorized internal calls are rejected.

Main scripts and evidence:
- [`openapi/tests/schemathesis/run_task_d.sh`](/home/holden/porject/UoB/Sec_SW/individual/citybike/citybike/openapi/tests/schemathesis/run_task_d.sh)
- [`openapi/tests/schemathesis/run_auth_negative.sh`](/home/holden/porject/UoB/Sec_SW/individual/citybike/citybike/openapi/tests/schemathesis/run_auth_negative.sh)
- Latest full logs: [`openapi/tests/schemathesis/logs/20260305-105043`](/home/holden/porject/UoB/Sec_SW/individual/citybike/citybike/openapi/tests/schemathesis/logs/20260305-105043)
- Latest negative-auth evidence: [`openapi/tests/schemathesis/logs/20260305-112555/auth-negative.log`](/home/holden/porject/UoB/Sec_SW/individual/citybike/citybike/openapi/tests/schemathesis/logs/20260305-112555/auth-negative.log)

## What Schemathesis checked

Schemathesis validated, per service:
- status code conformance
- content-type conformance
- response headers conformance
- response schema conformance
- positive data acceptance
- required header behavior
- stateful link-driven sequences (where applicable)

`unsupported_method` was excluded because Express returns `404` for unsupported verbs by default (instead of `405`), which is framework behavior, not trust-boundary failure.

`negative_data_rejection` was excluded after reproducing a false-positive pattern in this setup where an allegedly mutated negative case replayed an unchanged valid request; this exclusion is documented in test README.

## Findings and fixes

Initial runs exposed contract/implementation drift. Main issues and actions:

1. Undocumented error statuses (`400` for path/query validation):
- Added missing `400` responses to relevant OpenAPI operations.

2. HTML parser errors on malformed JSON:
- Added explicit JSON syntax error handlers returning structured JSON `ErrorResponse`.

3. Request validation too permissive:
- Added strict path ID format checks (`userId`, `rideId`, `bikeId`, etc.).
- Added query-parameter allowlists and rejection of unexpected query keys.
- Tightened payload field allowlists and value patterns.

4. Patch and idempotency consistency:
- Enforced profile patch field semantics in schema and runtime.
- Enforced header-based idempotency key requirements on ride/payment write paths.

5. Device/internal boundary enforcement:
- Enforced device certificate allowlist checks.
- Verified missing internal auth is consistently rejected (`401`).

## Final result and security-design reflection

The latest full Task D execution completed with zero failures across all services. Contract checks now align with trust boundaries and authentication assumptions, and regressions that would weaken those boundaries are caught automatically.

This process demonstrated the value of contract testing for secure SOA: OpenAPI definitions become executable controls, and mismatches are detected early as concrete, reproducible failures rather than post-deployment surprises.
