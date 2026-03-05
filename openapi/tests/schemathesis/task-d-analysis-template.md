# Task D Analysis Template

## 1. What Schemathesis checked

Schemathesis was run against each core service OpenAPI specification. It exercised:
- request payload schema validation (valid and invalid combinations)
- response schema conformance
- status-code conformance against documented responses
- security behavior under authenticated and unauthenticated requests

## 2. Authentication behavior observed

Authenticated runs used internal service tokens and boundary headers (`x-internal-mtls`, plus endpoint-specific headers such as `Idempotency-Key` and `x-device-cert`).

Negative checks (missing auth) returned authentication failures as expected, demonstrating enforcement of trust-boundary controls.

## 3. Issues found and fixes applied

Document concrete findings from logs, for example:
- endpoint returned a status not declared in OpenAPI
- request contract required field/header mismatch
- missing conflict or authorization status definitions
- schema mismatch between implementation and contract

For each issue, describe fix and re-test evidence.

## 4. Final result

Summarize per-service outcome and remaining risks:
- User Service: PASS / issues fixed
- Ride Service: PASS / issues fixed
- Bike Inventory Service: PASS / issues fixed
- Payment Service: PASS / issues fixed
- Partner Analytics Service: PASS / issues fixed

Residual risks can include flaky dependencies, environment-specific setup, or untested edge-case combinations.
