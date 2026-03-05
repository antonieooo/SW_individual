# Task E - CI Pipeline (GitHub Actions)

## Pipeline purpose

The CI pipeline enforces correctness and trust-boundary security throughout the service lifecycle: from code/spec change, to build, to staging deployment, to post-deployment contract assurance.

Workflow file:
- [`.github/workflows/ci.yml`](/home/holden/porject/UoB/Sec_SW/individual/citybike/citybike/.github/workflows/ci.yml)

The design targets the architecture actually implemented in this project (five core services plus API Gateway and Database Cluster), so boundary assumptions are validated end-to-end rather than per-file only.

## Pipeline structure and rationale

The workflow has two jobs:

1. `validate-contracts` (fast pre-gate)
- Validates all OpenAPI specifications with `swagger-cli`.
- Runs `node --check` on all service entrypoints.

Rationale: fail early on broken contracts/syntax before spending time on integration resources.

2. `staging-contract-tests` (integration + security gate)
- Creates Python virtual environment and installs Schemathesis.
- Builds and starts all services via Docker Compose.
- Runs `/status` smoke checks for all services.
- Runs negative authentication checks (`run_auth_negative.sh`).
- Runs full contract suite (`run_task_d.sh`).
- Uploads Schemathesis and Docker logs as artifacts.
- Always tears down staging environment.

Rationale: this stage proves the system is buildable, runnable, and testable in a deployment-like container environment, while preserving evidence for audit/marking.

## How checks support trust boundaries

The pipeline verifies boundary-specific assumptions:

1. User boundary (public to gateway)
- User JWT-protected endpoints are exercised through gateway contracts and fuzzed inputs.

2. Partner boundary
- Partner API key-protected analytics paths are included in gateway and partner service contract tests.

3. Device boundary
- Device certificate header checks are validated in bike inventory and gateway flows.

4. Internal service boundary
- Service JWT + internal mTLS simulation (`x-internal-mtls`) is required and tested on internal endpoints.
- Negative auth tests confirm missing internal auth returns expected failures.

5. Database boundary
- DB-facing contracts and credential gating are validated via database-cluster service tests.

By combining schema validation and runtime contract testing in staging, the pipeline detects both contract drift and boundary-enforcement regressions.

## Why this pipeline is coherent and maintainable

- Technically implementable on GitHub-hosted runners (Node, Python, Docker Compose).
- Uses deterministic scripts already in the repository, reducing CI drift from local runs.
- Separates quick static checks from deeper integration checks for better feedback speed.
- Archives logs so failures and security assertions are reproducible and reviewable.

This structure directly satisfies Task E requirements: containers build, services start, documented endpoints are reachable, automated testing executes in staging, and post-deployment assurance is available via artifacts and logs.
