#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if command -v schemathesis >/dev/null 2>&1; then
  ST_CMD=(schemathesis)
elif [[ -x "$ROOT_DIR/.venv-schemathesis/bin/schemathesis" ]]; then
  ST_CMD=("$ROOT_DIR/.venv-schemathesis/bin/schemathesis")
elif [[ -x "$ROOT_DIR/.venv-schemathesis/bin/st" ]]; then
  ST_CMD=("$ROOT_DIR/.venv-schemathesis/bin/st")
elif [[ -x "$ROOT_DIR/.venv-schemathesis/bin/python3" ]] && \
  "$ROOT_DIR/.venv-schemathesis/bin/python3" -c "import schemathesis.cli" >/dev/null 2>&1; then
  ST_CMD=("$ROOT_DIR/.venv-schemathesis/bin/python3" -m schemathesis.cli)
elif python3 -c "import schemathesis" >/dev/null 2>&1; then
  ST_CMD=(python3 -m schemathesis.cli)
else
  echo "Schemathesis is not installed. Install with:"
  echo "  python3 -m venv .venv-schemathesis"
  echo "  .venv-schemathesis/bin/pip install schemathesis"
  exit 1
fi

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
LOG_DIR="$ROOT_DIR/openapi/tests/schemathesis/logs/$TIMESTAMP"
mkdir -p "$LOG_DIR"
overall_exit=0

ensure_service_up() {
  local base_url="$1"
  local service_name="$2"
  local attempts="${3:-60}"
  local sleep_seconds="${4:-1}"
  local i

  for ((i = 1; i <= attempts; i++)); do
    if curl -fsS "$base_url/status" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$sleep_seconds"
  done

  echo "Service readiness check failed: $service_name ($base_url/status)"
  echo "Tip: run 'sudo docker compose logs $service_name --tail=80' to inspect startup errors."
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

run_case() {
  local name="$1"
  local spec_path="$2"
  local base_url="$3"
  local token="$4"
  shift 4

  local log_file="$LOG_DIR/${name}.log"
  local -a cmd=(
    "${ST_CMD[@]}"
    run
    "$spec_path"
    --url
    "$base_url"
    --exclude-checks
    "unsupported_method,negative_data_rejection"
    --header
    "Authorization: Bearer $token"
    --header
    "x-internal-mtls: true"
  )

  while (($#)); do
    cmd+=(--header "$1")
    shift
  done

  if [[ -n "${SCHEMATHESIS_EXTRA_ARGS:-}" ]]; then
    # shellcheck disable=SC2206
    extra_args=(${SCHEMATHESIS_EXTRA_ARGS})
    cmd+=("${extra_args[@]}")
  fi

  echo "=== $name ===" | tee "$log_file"
  echo "Command: ${cmd[*]}" | tee -a "$log_file"
  if ! "${cmd[@]}" 2>&1 | tee -a "$log_file"; then
    overall_exit=1
  fi
}

echo "Checking service readiness..."
ensure_service_up "http://localhost:3000" "api-gateway-service"
ensure_service_up "http://localhost:3001" "user-service"
ensure_service_up "http://localhost:3002" "ride-service"
ensure_service_up "http://localhost:3003" "bike-inventory-service"
ensure_service_up "http://localhost:3004" "payment-service"
ensure_service_up "http://localhost:3005" "partner-analytics-service"
ensure_service_up "http://localhost:3006" "database-cluster-service"

run_case \
  "api-gateway-service" \
  "$ROOT_DIR/openapi/api-gateway-service.yaml" \
  "http://localhost:3000" \
  "$(build_user_token u-100 user)" \
  "x-api-key: partner-a-demo-key" \
  "x-device-cert: device-cert-taskd-001" \
  "x-idempotency-key: taskd-gateway-001"

run_case \
  "user-service" \
  "$ROOT_DIR/openapi/user-service.yaml" \
  "http://localhost:3001" \
  "$(build_token user-service api-gateway-service)"

run_case \
  "ride-service" \
  "$ROOT_DIR/openapi/ride-service.yaml" \
  "http://localhost:3002" \
  "$(build_token ride-service api-gateway-service)" \
  "Idempotency-Key: taskd-ride-001"

run_case \
  "bike-inventory-service" \
  "$ROOT_DIR/openapi/bike-inventory-service.yaml" \
  "http://localhost:3003" \
  "$(build_token bike-inventory-service api-gateway-service)" \
  "x-device-cert: device-cert-taskd-001"

run_case \
  "payment-service" \
  "$ROOT_DIR/openapi/payment-service.yaml" \
  "http://localhost:3004" \
  "$(build_token payment-service ride-service)" \
  "Idempotency-Key: taskd-payment-001"

run_case \
  "partner-analytics-service" \
  "$ROOT_DIR/openapi/partner-analytics-service.yaml" \
  "http://localhost:3005" \
  "$(build_token partner-analytics-service api-gateway-service)"

run_case \
  "database-cluster-service" \
  "$ROOT_DIR/openapi/database-cluster-service.yaml" \
  "http://localhost:3006" \
  "$(build_token database-cluster-service database-cluster-service)" \
  "x-db-credential: db-analytics-secret"

echo "Schemathesis logs written to: $LOG_DIR"
exit "$overall_exit"
