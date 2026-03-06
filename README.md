# CityBike Security Architecture MVP

This repository contains a minimal, runnable microservice implementation for the CityBike security architecture coursework.  
The focus is on trust-boundary enforcement and contract verification, not production-grade infrastructure.

## Services

| Service | Host Port | Purpose |
| --- | --- | --- |
| `api-gateway-service` | `3000` (HTTPS) | Public entrypoint for users, maintainers, partners, and device events |
| `user-service` | `3001` | Login, profile, payment binding, dashboard composition |
| `ride-service` | `3002` | Ride start/end lifecycle and ride history |
| `bike-inventory-service` | `3003` | Bike state, reserve/release, device event processing |
| `payment-service` | `3004` | Charge processing and billing summary |
| `partner-analytics-service` | `3005` | Read-only partner analytics endpoint |
| `database-cluster-service` | `3006` | In-memory schema-isolated storage and analytics aggregation |

## Security Model (MVP)

- User / maintainer access: JWT bearer token at gateway (`Authorization`)
- Partner access: API key (`x-api-key`)
- Device flow: device certificate marker (`x-device-cert`)
- Internal service calls: service token + simulated mTLS marker (`x-internal-mtls: true`)
- DB boundary: schema credential (`x-db-credential`) + internal service auth

Note: mTLS and DB are intentionally simulated (headers + in-memory storage) to keep the project minimal and testable.

## Project Structure

- Service implementations: `services/*/src/index.js`
- OpenAPI contracts: `openapi/*.yaml`
- Shared OpenAPI components: `openapi/components/common.yaml`
- Contract test scripts: `openapi/tests/schemathesis/`
- CI workflow: `.github/workflows/ci.yml`

## Quick Start

From repository root:

```bash
docker compose down -v --remove-orphans
docker compose up -d --build
```

Quick readiness check:

```bash
curl -k https://localhost:3000/status
curl http://localhost:3001/status
curl http://localhost:3002/status
curl http://localhost:3003/status
curl http://localhost:3004/status
curl http://localhost:3005/status
curl http://localhost:3006/status
```

## Smoke Example

Login:

```bash
curl -k -sS -X POST https://localhost:3000/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"alice@citybike.example","password":"alice123"}'
```

Start ride:

```bash
curl -k -sS -X POST https://localhost:3000/api/v1/rides/start \
  -H "authorization: Bearer <TOKEN_FROM_LOGIN>" \
  -H 'content-type: application/json' \
  -H 'x-idempotency-key: demo-start-001' \
  -d '{"bikeId":"bike-001"}'
```

Read partner report:

```bash
curl -k -sS "https://localhost:3000/api/v1/partner/reports/daily-usage?date=$(date +%F)" \
  -H 'x-api-key: partner-a-demo-key'
```

Automated smoke script (recommended):

```bash
bash openapi/tests/smoke/run_smoke.sh
```

## OpenAPI Validation

Install root dependencies once:

```bash
npm ci
```

Validate all API contracts:

```bash
npx swagger-cli validate openapi/user-service.yaml
npx swagger-cli validate openapi/ride-service.yaml
npx swagger-cli validate openapi/bike-inventory-service.yaml
npx swagger-cli validate openapi/payment-service.yaml
npx swagger-cli validate openapi/partner-analytics-service.yaml
npx swagger-cli validate openapi/api-gateway-service.yaml
npx swagger-cli validate openapi/database-cluster-service.yaml
```

## Testing (CI-equivalent)

Create Schemathesis virtual environment (one-time):

```bash
python3 -m venv .venv-schemathesis
.venv-schemathesis/bin/pip install --upgrade pip
.venv-schemathesis/bin/pip install schemathesis
```

Run the same logical sequence used in CI:

```bash
bash openapi/tests/schemathesis/run_auth_negative.sh
bash openapi/tests/schemathesis/run_negative_data.sh
bash openapi/tests/schemathesis/run_task_d.sh
```

Equivalent npm scripts:

```bash
npm run test:contract:auth-negative
npm run test:contract:data-negative
npm run test:contract:all
```

Run a single service only:

```bash
bash openapi/tests/schemathesis/run_one_service.sh <service-name>
```

Supported service names:

- `api-gateway-service`
- `user-service`
- `ride-service`
- `bike-inventory-service`
- `payment-service`
- `partner-analytics-service`
- `database-cluster-service`

Per-service shortcut scripts:

```bash
bash openapi/tests/schemathesis/run_api_gateway_service.sh
bash openapi/tests/schemathesis/run_user_service.sh
bash openapi/tests/schemathesis/run_ride_service.sh
bash openapi/tests/schemathesis/run_bike_inventory_service.sh
bash openapi/tests/schemathesis/run_payment_service.sh
bash openapi/tests/schemathesis/run_partner_analytics_service.sh
bash openapi/tests/schemathesis/run_database_cluster_service.sh
```

Equivalent npm scripts:

```bash
npm run test:contract:gateway
npm run test:contract:user
npm run test:contract:ride
npm run test:contract:inventory
npm run test:contract:payment
npm run test:contract:partner-analytics
npm run test:contract:db-cluster
```

Unit tests (fast, local):

```bash
npm run test:unit
```

## Logs

- Full suite logs: `openapi/tests/schemathesis/logs/<timestamp>/`
- Single service logs: `openapi/tests/schemathesis/logs_per_service/<timestamp>/`
- Smoke logs: `openapi/tests/smoke/logs/<timestamp>/`

## Cleanup

```bash
docker compose down -v --remove-orphans
```
