# OpenAPI Debugging Issues Log

This document records the concrete issues encountered while validating, testing, and hardening the CityBike OpenAPI contracts and Schemathesis workflow.

## 1. Initial OpenAPI validation failures

- Symptom:
  - `Swagger schema validation failed` on `components/securitySchemes/mutualTLS`.
- Root cause:
  - `swagger-cli` did not accept the initial `mutualTLS` modeling style used in the spec.
- Action:
  - Adjusted security scheme definitions and aligned all services to a consistent, validator-compatible pattern.
- Result:
  - All OpenAPI files validate successfully via `swagger-cli`.

## 2. Docker access & environment control failures

- Symptom:
  - `permission denied while trying to connect to the Docker daemon socket`.
- Root cause:
  - Current shell user lacked Docker daemon permission.
- Action:
  - Run Docker lifecycle commands with `sudo` in local environment.
- Result:
  - Containers can be rebuilt and restarted when run with sufficient privileges.

## 3. Schemathesis runtime bootstrap issues

- Symptom A:
  - `Schemathesis is not installed` even when venv existed.
- Symptom B:
  - `.venv-schemathesis/bin/schemathesis: cannot execute: required file not found` in CI.
- Symptom C:
  - `No module named schemathesis.__main__` when using `python -m schemathesis`.
- Root cause:
  - Entrypoint/tool invocation differences across local and CI environments.
- Action:
  - Hardened runner command selection fallback in `run_task_d.sh` (binary / `st` / `python -m schemathesis.cli`).
- Result:
  - Stable CLI invocation path across environments.

## 4. CI smoke check failures

- Symptom:
  - `curl: (52) Empty reply from server` / `curl: (56) Recv failure`.
- Root cause:
  - Service startup timing / protocol mismatch after gateway TLS changes.
- Action:
  - Added robust readiness checks with retries; switched gateway readiness to HTTPS (`curl -k`) while keeping internal services on HTTP.
- Result:
  - Improved CI readiness reliability.

## 5. HTTP vs HTTPS consistency gap (TB1/TB4/TB5)

- Symptom:
  - Architecture narrative required TLS boundaries, but gateway endpoint and tests were HTTP.
- Root cause:
  - Implementation and contract docs diverged.
- Action:
  - Upgraded external gateway entrypoint to HTTPS (self-signed cert in gateway container), updated OpenAPI server URL, CI smoke checks, Schemathesis gateway target, and README examples.
- Result:
  - External boundary now concretely runs over HTTPS.

## 6. Contract-vs-implementation drift from Schemathesis

- Symptom:
  - Repeated findings like:
    - `API rejected schema-compliant request`
    - `API accepted schema-violating request`
    - `Schema validation mismatch`
- Typical root causes:
  - Schema too permissive vs runtime validators.
  - Optional/loose payload definitions for endpoints with stricter handlers.
  - Missing path pattern constraints (e.g., payment IDs).
- Actions taken:
  - Tightened request schemas (`LoginRequest`, path patterns, ride end payload expectations).
  - Added explicit runtime path validation for payment ID.
  - Kept OpenAPI and Express validators synchronized.
- Result:
  - Reduced mismatch surface and clearer failure semantics.

## 7. HTML error payload vs JSON error contract

- Symptom:
  - `Undocumented Content-Type: text/html; charset=utf-8` on malformed JSON.
- Root cause:
  - Express/body-parser syntax errors returned default HTML when not intercepted.
- Action:
  - Added JSON parse error middleware returning structured `ErrorResponse` JSON.
- Result:
  - Content type and error body now align with OpenAPI error contracts.

## 8. Auth warning noise on privileged endpoints

- Symptom:
  - `Missing authentication` warnings for admin/maintainer endpoints during fuzzing.
- Root cause:
  - Test tokens lacked required maintainer actor/role context for those operations.
- Action:
  - Switched gateway test token to maintainer identity in Task D runner.
  - Continued explicit auth negative checks in `run_auth_negative.sh`.
- Result:
  - Reduced non-actionable auth warning noise in standard contract runs.

## 9. Missing test data warnings (404-heavy operations)

- Symptom:
  - `Missing valid test data` warnings for ride/resource-dependent operations.
- Root cause:
  - Property-based generation frequently produced syntactically valid but non-existent resource IDs.
- Action:
  - Improved schemas and flow constraints; kept warnings policy configurable in runner.
- Result:
  - Better signal-to-noise; remaining cases are understood as data-availability limitations, not service crashes.

## 10. Tooling caveat: deprecated validator package

- Symptom:
  - `@apidevtools/swagger-cli` deprecation warning.
- Root cause:
  - Upstream package no longer actively maintained.
- Action:
  - Continue using current validator for coursework reproducibility; note migration path to `@redocly/cli` for future hardening.
- Result:
  - Validation workflow remains stable for current submission scope.

## Current status snapshot

- All service OpenAPI files are lint-valid.
- Gateway external boundary is HTTPS.
- Schemathesis runner supports robust CLI fallback and TLS handling.
- Major contract/implementation drifts found during debugging have been documented and progressively reduced.
