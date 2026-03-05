# Task E - CI Pipeline Design (GitHub Actions)

The pipeline is designed to enforce correctness and trust boundaries across CityBike's seven services (five core services plus API Gateway and Database Cluster). It is implemented in [`.github/workflows/ci.yml`](/home/holden/porject/UoB/Sec_SW/individual/citybike/citybike/.github/workflows/ci.yml) and has two jobs that reflect the service lifecycle from change validation to staged deployment assurance.

## 1) Purpose of the pipeline

The pipeline ensures that each code change preserves:
- contract correctness (OpenAPI consistency and validity),
- boundary enforcement assumptions (authentication and internal-only behavior),
- runtime deployability (container build + startup),
- testability in a realistic staged environment.

This directly supports secure SOA maintenance by preventing boundary-breaking regressions from being merged.

## 2) How the stages support the trust-boundary model

### Stage A: `validate-contracts`
This job performs pre-deployment gate checks:
- OpenAPI validation for all service specs (`swagger-cli validate`).
- JavaScript syntax checks for every service entrypoint.

These checks protect trust boundaries early by ensuring contracts and endpoint models remain coherent before container build or runtime testing.

### Stage B: `staging-contract-tests`
This job models a containerized staging deployment using Docker Compose:
- Builds all services into runnable containers.
- Starts all services and confirms each `/status` endpoint is reachable.
- Runs negative authentication checks (`run_auth_negative.sh`) to confirm internal endpoints reject missing internal auth.
- Runs full Schemathesis contract testing (`run_task_d.sh`) with service/user tokens and boundary-specific headers.

This stage verifies not only endpoint schema conformance but also boundary behavior: user JWT flow, partner API key access, internal service token + mTLS simulation, device certificate checks, and DB credential checks.

## 3) How the pipeline prevents security/correctness regressions

- Contract drift is blocked by OpenAPI validation and post-deploy Schemathesis execution.
- Authentication regressions are surfaced via explicit negative auth tests.
- Runtime integration regressions are detected by full-stack compose deployment and cross-service testing.
- Boundary assumptions are continuously re-checked in the same execution path used by services in deployment-like conditions.

Even when tests emit warnings (for example, strict auth-only operations), artifacts allow transparent inspection rather than silent failure.

## 4) Why this structure was selected

The two-job structure balances speed and assurance:
- fast fail on static contract/syntax issues,
- then deeper staged integration and security validation only when the baseline is valid.

This avoids expensive integration runs on obviously broken changes while still providing end-to-end assurance before merge.

The pipeline is technically coherent for GitHub Actions because it uses standard hosted-runner capabilities (Node, Python, Docker Compose), produces reproducible outputs, and uploads artifacts (Schemathesis logs and Docker logs) for auditability and marking evidence.

In short, the workflow is intentionally aligned to the architecture's trust boundaries and provides enforceable controls from code change to post-deployment verification.
