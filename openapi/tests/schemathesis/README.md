# Task D - Schemathesis Contract Testing

This folder contains scripts to run Schemathesis against all implemented services and collect logs for Task D.

## Prerequisites

1. Start services:
```bash
cd /home/holden/porject/UoB/Sec_SW/individual/citybike/citybike
sudo docker compose up -d --build
```

2. Install Schemathesis (one-time):
```bash
python3 -m venv .venv-schemathesis
.venv-schemathesis/bin/pip install schemathesis
```

## Run authenticated contract tests

```bash
cd /home/holden/porject/UoB/Sec_SW/individual/citybike/citybike
. .venv-schemathesis/bin/activate
bash openapi/tests/schemathesis/run_task_d.sh
```

This script:
- validates API Gateway, User, Ride, Bike Inventory, Payment, Partner Analytics, and Database Cluster services
- generates user/service tokens aligned with current auth design
- applies required headers such as `x-internal-mtls`, `Idempotency-Key`, `x-device-cert`, and `x-db-credential`
- excludes Schemathesis `unsupported_method` and `negative_data_rejection` checks
  (`unsupported_method`: Express defaults unsupported verbs to `404` rather than `405`;
  `negative_data_rejection`: known false-positive in this setup where Schemathesis can report
  a mutated-negative case while replaying an unchanged valid request)
- writes one log file per service under `openapi/tests/schemathesis/logs/<timestamp>/`
- continues executing all services even if one service fails, then returns a non-zero exit code at the end if any failures occurred

Optional: pass extra Schemathesis CLI options via `SCHEMATHESIS_EXTRA_ARGS`.

Example:
```bash
SCHEMATHESIS_EXTRA_ARGS="--max-examples 20" bash openapi/tests/schemathesis/run_task_d.sh
```

## Run negative auth checks

```bash
bash openapi/tests/schemathesis/run_auth_negative.sh
```

This generates a log showing expected authentication failures (missing internal auth headers).

## Output for submission

Use the generated logs in `openapi/tests/schemathesis/logs/` as Task D evidence:
- authenticated Schemathesis execution logs
- negative authentication behavior log
