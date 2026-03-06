#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
LOG_DIR="$ROOT_DIR/openapi/tests/schemathesis/logs/$TIMESTAMP"
LOG_FILE="$LOG_DIR/negative-data.log"
mkdir -p "$LOG_DIR"

overall_exit=0

ensure_service_up() {
  local base_url="$1"
  local service_name="$2"
  local attempts="${3:-60}"
  local sleep_seconds="${4:-1}"
  local i

  for ((i = 1; i <= attempts; i++)); do
    if [[ "$base_url" == https:* ]]; then
      if curl -k -fsS "$base_url/status" >/dev/null 2>&1; then
        return 0
      fi
    elif curl -fsS "$base_url/status" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$sleep_seconds"
  done

  echo "Service readiness check failed: $service_name ($base_url/status)" | tee -a "$LOG_FILE"
  return 1
}

build_token() {
  local audience="$1"
  local issuer="$2"
  node "$SCRIPT_DIR/generate_service_token.js" "$audience" "$issuer"
}

build_user_token() {
  local user_id="$1"
  local role="$2"
  node "$SCRIPT_DIR/generate_user_token.js" "$user_id" "$role"
}

assert_status() {
  local name="$1"
  local expected_status="$2"
  shift 2

  local raw_output
  local body
  local status
  raw_output="$("$@" -w $'\n%{http_code}')"
  body="${raw_output%$'\n'*}"
  status="${raw_output##*$'\n'}"

  echo "=== $name ===" | tee -a "$LOG_FILE"
  echo "status=$status expected=$expected_status" | tee -a "$LOG_FILE"
  echo "$body" | tee -a "$LOG_FILE"

  if [[ "$status" != "$expected_status" ]]; then
    overall_exit=1
    echo "FAILED: $name" | tee -a "$LOG_FILE"
  fi
}

echo "Checking service readiness..." | tee -a "$LOG_FILE"
ensure_service_up "https://localhost:3000" "api-gateway-service"
ensure_service_up "http://localhost:3001" "user-service"
ensure_service_up "http://localhost:3002" "ride-service"
ensure_service_up "http://localhost:3003" "bike-inventory-service"
ensure_service_up "http://localhost:3004" "payment-service"
ensure_service_up "http://localhost:3005" "partner-analytics-service"
ensure_service_up "http://localhost:3006" "database-cluster-service"

gateway_user_token="$(build_user_token u-100 user)"
gateway_maintainer_token="$(build_user_token m-900 maintainer)"
user_service_token="$(build_token user-service api-gateway-service)"
ride_service_token="$(build_token ride-service api-gateway-service)"
bike_inventory_token="$(build_token bike-inventory-service api-gateway-service)"
payment_service_token="$(build_token payment-service ride-service)"
partner_analytics_token="$(build_token partner-analytics-service api-gateway-service)"
db_service_token="$(build_token database-cluster-service database-cluster-service)"

assert_status \
  "gateway login missing password" \
  "400" \
  curl -k -sS -X POST "https://localhost:3000/api/v1/auth/login" \
    -H "content-type: application/json" \
    -d '{"email":"alice@citybike.example"}'

assert_status \
  "gateway start ride invalid bikeId" \
  "400" \
  curl -k -sS -X POST "https://localhost:3000/api/v1/rides/start" \
    -H "authorization: Bearer $gateway_user_token" \
    -H "content-type: application/json" \
    -H "x-idempotency-key: neg-gw-start-001" \
    -d '{"bikeId":"invalid"}'

assert_status \
  "gateway end ride invalid body type" \
  "400" \
  curl -k -sS -X POST "https://localhost:3000/api/v1/rides/ride-0/end" \
    -H "authorization: Bearer $gateway_user_token" \
    -H "x-idempotency-key: neg-gw-end-001" \
    -H "content-type: application/json" \
    -d '""'

assert_status \
  "gateway device event invalid type" \
  "400" \
  curl -k -sS -X POST "https://localhost:3000/api/v1/device/events" \
    -H "x-device-cert: device-cert-taskd-001" \
    -H "content-type: application/json" \
    -d '{"bikeId":"bike-001","eventType":"hack","nonce":"nonce001","timestamp":"2026-03-05T00:00:00Z"}'

assert_status \
  "gateway admin invalid lockState" \
  "400" \
  curl -k -sS -X POST "https://localhost:3000/api/v1/admin/bikes/bike-001/override-lock" \
    -H "authorization: Bearer $gateway_maintainer_token" \
    -H "content-type: application/json" \
    -d '{"lockState":"broken"}'

assert_status \
  "user-service login missing password" \
  "400" \
  curl -sS -X POST "http://localhost:3001/internal/auth/login" \
    -H "authorization: Bearer $user_service_token" \
    -H "x-internal-mtls: true" \
    -H "content-type: application/json" \
    -d '{"email":"alice@citybike.example"}'

assert_status \
  "ride-service start invalid IDs" \
  "400" \
  curl -sS -X POST "http://localhost:3002/internal/rides/start" \
    -H "authorization: Bearer $ride_service_token" \
    -H "x-internal-mtls: true" \
    -H "Idempotency-Key: neg-ride-start-001" \
    -H "content-type: application/json" \
    -d '{"userId":"invalid","bikeId":"invalid"}'

assert_status \
  "ride-service end invalid dockId" \
  "400" \
  curl -sS -X POST "http://localhost:3002/internal/rides/ride-0/end" \
    -H "authorization: Bearer $ride_service_token" \
    -H "x-internal-mtls: true" \
    -H "Idempotency-Key: neg-ride-end-001" \
    -H "content-type: application/json" \
    -d '{"dockId":""}'

assert_status \
  "bike-inventory invalid device event type" \
  "400" \
  curl -sS -X POST "http://localhost:3003/internal/device-events" \
    -H "authorization: Bearer $bike_inventory_token" \
    -H "x-internal-mtls: true" \
    -H "x-device-cert: device-cert-taskd-001" \
    -H "content-type: application/json" \
    -d '{"bikeId":"bike-001","eventType":"hack","nonce":"nonce001","timestamp":"2026-03-05T00:00:00Z"}'

assert_status \
  "payment-service invalid amount type" \
  "400" \
  curl -sS -X POST "http://localhost:3004/internal/payments/charge" \
    -H "authorization: Bearer $payment_service_token" \
    -H "x-internal-mtls: true" \
    -H "Idempotency-Key: neg-pay-001" \
    -H "content-type: application/json" \
    -d '{"userId":"u-100","rideId":"ride-100","amount":"","currency":"GBP","paymentBindingId":"paybind-u-100"}'

assert_status \
  "partner-analytics invalid date" \
  "400" \
  curl -sS -X GET "http://localhost:3005/internal/reports/daily-usage?date=invalid" \
    -H "authorization: Bearer $partner_analytics_token" \
    -H "x-internal-mtls: true"

assert_status \
  "database-cluster invalid date" \
  "400" \
  curl -sS -X GET "http://localhost:3006/internal/db/analytics/daily-usage?date=invalid" \
    -H "authorization: Bearer $db_service_token" \
    -H "x-internal-mtls: true" \
    -H "x-db-credential: db-analytics-secret"

echo "Negative data log written to: $LOG_FILE" | tee -a "$LOG_FILE"
exit "$overall_exit"
