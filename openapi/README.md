Task C OpenAPI specifications for the five core services:

- `user-service.yaml`
- `ride-service.yaml`
- `bike-inventory-service.yaml`
- `payment-service.yaml`
- `partner-analytics-service.yaml`

Each spec models internal trust boundaries with `serviceJwt + mutualTLS` and includes a local development mTLS simulation header (`x-internal-mtls`).
