#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
LOG_DIR="$ROOT_DIR/openapi/tests/schemathesis/logs/$TIMESTAMP"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/auth-negative.log"

request() {
  local label="$1"
  local command="$2"
  {
    echo "=== $label ==="
    eval "$command"
    echo
  } | tee -a "$LOG_FILE"
}

request "user-service missing auth" \
  "curl -s -o /tmp/taskd-user-auth.out -w 'status=%{http_code}\n' -X POST http://localhost:3001/internal/auth/login -H 'content-type: application/json' -d '{\"email\":\"alice@citybike.example\",\"password\":\"alice123\"}' && cat /tmp/taskd-user-auth.out"

request "ride-service missing auth" \
  "curl -s -o /tmp/taskd-ride-auth.out -w 'status=%{http_code}\n' -X POST http://localhost:3002/internal/rides/start -H 'content-type: application/json' -d '{\"userId\":\"u-100\",\"bikeId\":\"bike-001\"}' && cat /tmp/taskd-ride-auth.out"

request "inventory-service missing auth" \
  "curl -s -o /tmp/taskd-inv-auth.out -w 'status=%{http_code}\n' http://localhost:3003/internal/bikes/bike-001 && cat /tmp/taskd-inv-auth.out"

request "payment-service missing auth" \
  "curl -s -o /tmp/taskd-pay-auth.out -w 'status=%{http_code}\n' -X POST http://localhost:3004/internal/payments/charge -H 'content-type: application/json' -d '{\"userId\":\"u-100\",\"rideId\":\"ride-taskd\",\"amount\":1,\"currency\":\"GBP\",\"paymentBindingId\":\"paybind-u-100\"}' && cat /tmp/taskd-pay-auth.out"

request "partner-analytics-service missing auth" \
  "curl -s -o /tmp/taskd-analytics-auth.out -w 'status=%{http_code}\n' http://localhost:3005/internal/reports/daily-usage && cat /tmp/taskd-analytics-auth.out"

echo "Negative auth log written to: $LOG_FILE"
