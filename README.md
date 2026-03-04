# CityBike Minimal Architecture Implementation

This repository now includes a runnable minimal implementation of your architecture from `SW_individual.pdf` and `未命名绘图.drawio`.

## Implemented services

Core services:
- `user-service`
- `ride-service`
- `bike-inventory-service`
- `payment-service`
- `partner-analytics-service`

Added architecture services:
- `api-gateway-service` (single entry for TB1/TB3/TB4/TB5)
- `database-cluster-service` (shared in-memory schemas + analytics aggregation for TB6)

## Security model in this MVP

- External user/maintainer access: gateway JWT (`Authorization: Bearer ...`)
- External partner access: gateway API key (`x-api-key`)
- Device ingress: gateway device certificate marker (`x-device-cert`)
- Internal service-to-service: signed service token + `x-internal-mtls: true`
- DB access: service token + schema credential (`x-db-credential`)

Note: real mTLS and real database are intentionally simulated with headers and in-memory state to keep the implementation minimal.

## Start

```bash
docker compose up --build
```

## Quick smoke flow

1. Login as rider:
```bash
curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"alice@citybike.example","password":"alice123"}'
```

2. Start ride:
```bash
curl -s -X POST http://localhost:3000/api/v1/rides/start \
  -H "authorization: Bearer <TOKEN_FROM_LOGIN>" \
  -H 'content-type: application/json' \
  -H 'x-idempotency-key: demo-start-001' \
  -d '{"bikeId":"bike-001"}'
```

3. Partner analytics:
```bash
curl -s "http://localhost:3000/api/v1/partner/reports/daily-usage?date=$(date +%F)" \
  -H 'x-api-key: partner-a-demo-key'
```

## OpenAPI

The Task C OpenAPI files for the five core services are under `openapi/`.
