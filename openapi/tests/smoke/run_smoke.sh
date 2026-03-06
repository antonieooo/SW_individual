#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TOKEN_DIR="$ROOT_DIR/openapi/tests/schemathesis"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
LOG_DIR="$ROOT_DIR/openapi/tests/smoke/logs/$TIMESTAMP"
LOG_FILE="$LOG_DIR/smoke.log"
mkdir -p "$LOG_DIR"

overall_exit=0

ensure_service_up() {
  local base_url="$1"
  local service_name="$2"
  local attempts="${3:-60}"
  local sleep_seconds="${4:-1}"
  local i
  local status_url="${base_url}/status"

  echo "[readiness] waiting for ${service_name} -> ${status_url}" | tee -a "$LOG_FILE"

  for ((i = 1; i <= attempts; i++)); do
    if [[ "$base_url" == https:* ]]; then
      if curl -k -fsS "$status_url" >/dev/null 2>&1; then
        echo "[readiness] ready: ${service_name} (attempt ${i}/${attempts})" | tee -a "$LOG_FILE"
        return 0
      fi
    elif curl -fsS "$status_url" >/dev/null 2>&1; then
      echo "[readiness] ready: ${service_name} (attempt ${i}/${attempts})" | tee -a "$LOG_FILE"
      return 0
    fi

    if (( i == 1 || i % 5 == 0 )); then
      echo "[readiness] still waiting: ${service_name} (attempt ${i}/${attempts})" | tee -a "$LOG_FILE"
    fi

    sleep "$sleep_seconds"
  done

  echo "Service readiness check failed: ${service_name} (${status_url})" | tee -a "$LOG_FILE"
  echo "Hint: if Docker showed permission denied, run:" | tee -a "$LOG_FILE"
  echo "  sudo docker compose up -d --build" | tee -a "$LOG_FILE"
  echo "Then re-run this smoke script." | tee -a "$LOG_FILE"
  overall_exit=1
  return 1
}

build_service_token() {
  local audience="$1"
  local issuer="$2"
  node "$TOKEN_DIR/generate_service_token.js" "$audience" "$issuer"
}

build_user_token() {
  local user_id="$1"
  local role="$2"
  node "$TOKEN_DIR/generate_user_token.js" "$user_id" "$role"
}

assert_status() {
  local name="$1"
  local expected_pattern="$2"
  shift 2

  local raw_output
  local body
  local status
  raw_output="$("$@" -w $'\n%{http_code}')"
  body="${raw_output%$'\n'*}"
  status="${raw_output##*$'\n'}"

  echo "=== $name ===" | tee -a "$LOG_FILE"
  echo "status=$status expected=$expected_pattern" | tee -a "$LOG_FILE"
  echo "$body" | tee -a "$LOG_FILE"
  echo | tee -a "$LOG_FILE"

  if [[ ! "$status" =~ ^(${expected_pattern})$ ]]; then
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

today="$(date +%F)"
gateway_user_token="$(build_user_token u-100 user)"
user_service_token="$(build_service_token user-service api-gateway-service)"
ride_service_token="$(build_service_token ride-service api-gateway-service)"
inventory_service_token="$(build_service_token bike-inventory-service api-gateway-service)"
payment_service_token="$(build_service_token payment-service ride-service)"
partner_analytics_token="$(build_service_token partner-analytics-service api-gateway-service)"
db_service_token="$(build_service_token database-cluster-service database-cluster-service)"

assert_status \
  "gateway health" \
  "200" \
  curl -k -sS "https://localhost:3000/status"

assert_status \
  "gateway login" \
  "200" \
  curl -k -sS -X POST "https://localhost:3000/api/v1/auth/login" \
    -H "content-type: application/json" \
    -d '{"email":"alice@citybike.example","password":"alice123"}'

assert_status \
  "gateway profile read" \
  "200" \
  curl -k -sS "https://localhost:3000/api/v1/users/u-100/profile" \
    -H "authorization: Bearer $gateway_user_token"

assert_status \
  "gateway partner report" \
  "200" \
  curl -k -sS "https://localhost:3000/api/v1/partner/reports/daily-usage?date=${today}" \
    -H "x-api-key: partner-a-demo-key"

assert_status \
  "user-service profile" \
  "200" \
  curl -sS "http://localhost:3001/internal/users/u-100/profile" \
    -H "authorization: Bearer $user_service_token" \
    -H "x-internal-mtls: true"

assert_status \
  "ride-service user rides" \
  "200" \
  curl -sS "http://localhost:3002/internal/users/u-100/rides?limit=1" \
    -H "authorization: Bearer $ride_service_token" \
    -H "x-internal-mtls: true"

assert_status \
  "inventory-service bike state" \
  "200" \
  curl -sS "http://localhost:3003/internal/bikes/bike-001" \
    -H "authorization: Bearer $inventory_service_token" \
    -H "x-internal-mtls: true"

assert_status \
  "payment-service billing summary" \
  "200" \
  curl -sS "http://localhost:3004/internal/users/u-100/billing-summary" \
    -H "authorization: Bearer $payment_service_token" \
    -H "x-internal-mtls: true"

assert_status \
  "partner-analytics internal report" \
  "200" \
  curl -sS "http://localhost:3005/internal/reports/daily-usage?date=${today}" \
    -H "authorization: Bearer $partner_analytics_token" \
    -H "x-internal-mtls: true"

assert_status \
  "database refresh analytics" \
  "200" \
  curl -sS -X POST "http://localhost:3006/internal/db/analytics/refresh" \
    -H "authorization: Bearer $db_service_token" \
    -H "x-internal-mtls: true" \
    -H "x-db-credential: db-analytics-secret" \
    -H "content-type: application/json" \
    -d "{\"date\":\"${today}\"}"

assert_status \
  "database read analytics" \
  "200" \
  curl -sS "http://localhost:3006/internal/db/analytics/daily-usage?date=${today}" \
    -H "authorization: Bearer $db_service_token" \
    -H "x-internal-mtls: true" \
    -H "x-db-credential: db-analytics-secret"

echo "Smoke log written to: $LOG_FILE" | tee -a "$LOG_FILE"
exit "$overall_exit"
