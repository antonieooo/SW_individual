# Task C - OpenAPI Specifications

## Scope and completeness

I defined OpenAPI contracts for the five required core services:
- `user-service` (6 operations)
- `ride-service` (5 operations)
- `bike-inventory-service` (6 operations)
- `payment-service` (4 operations)
- `partner-analytics-service` (2 operations)

In line with my architecture, I also specified two additional services:
- `api-gateway-service` (11 operations)
- `database-cluster-service` (6 operations)

This ensures all interfaces used in the real data flow are contract-defined, including public entry points and internal service-to-service calls. Across the five core services, endpoints cover health, internal orchestration paths, partner access, device ingestion, idempotent payment/ride operations, and aggregation flows needed by dashboard and reporting scenarios.

## Completeness and consistency of endpoints, schemas, and errors

The specifications include request/response schemas and structured `ErrorResponse` objects with consistent status handling. Common status codes are aligned across services:
- success: `200`, `201`, `202`
- client/security/path/payload issues: `400`, `401`, `403`, `404`, `409`
- upstream/internal dependency failures: `502`

Schema consistency was enforced by:
- strict path patterns (e.g., `userId`, `rideId`, `bikeId`, `paymentBindingId`)
- constrained payload objects (`additionalProperties: false` where applicable)
- explicit header contracts for boundary controls (e.g., `Idempotency-Key`, `x-device-cert`, `x-db-credential`)
- nullable and typed response fields aligned to implementation behavior.

Idempotency is modelled explicitly in ride and payment write paths, and error conditions for conflicts are documented (`409`).

## Security modelling aligned with trust boundaries

Security schemes reflect boundary-specific trust assumptions:

1. External user boundary (user/maintainer to gateway):
- `userJwt` bearer token on user-facing endpoints.

2. External partner boundary:
- `partnerApiKey` for analytics access.

3. Device boundary:
- `deviceCert` style header for simulated device credential enforcement.

4. Internal service boundary:
- `serviceJwt` + `internalMtls` (simulated by `x-internal-mtls`) for service-to-service calls.

5. Database trust boundary:
- `serviceJwt` + `internalMtls` + `dbCredential` for schema-scoped DB operations.

This modelling enforces least privilege by separating external/public authentication mechanisms from internal service credentials, and by requiring additional credentials where risk is higher (device ingress and DB access).

## Technical validity and linting correctness

All OpenAPI files were validated using Swagger CLI:

```bash
for f in openapi/user-service.yaml openapi/ride-service.yaml \
  openapi/bike-inventory-service.yaml openapi/payment-service.yaml \
  openapi/partner-analytics-service.yaml openapi/api-gateway-service.yaml \
  openapi/database-cluster-service.yaml; do
  npx swagger-cli validate "$f"
done
```

Lint output confirms all specifications are valid. Evidence file:
- [`openapi-lint-all.log`](/home/holden/porject/UoB/Sec_SW/individual/citybike/citybike/openapi-lint-all.log)

## How the specifications reflect design decisions

The specifications directly encode the trust-boundary architecture: gateway mediation for public actors, internal-only APIs protected by service trust controls, dedicated device and partner constraints, and a separate DB boundary with additional credentials. This makes the contracts not only syntactically valid, but also security-meaningful and traceable to architectural intent.
