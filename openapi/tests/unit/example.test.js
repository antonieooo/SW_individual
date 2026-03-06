const test = require("node:test");
const assert = require("node:assert/strict");

const {
  calculateRideAmount,
  isValidIdempotencyKey,
  isValidRideId,
  isValidDateTimeString
} = require("../../../services/ride-service/src/validation.js");

test("ride amount keeps base fare for short trips", () => {
  const amount = calculateRideAmount("2026-03-06T10:00:00Z", "2026-03-06T10:04:30Z");
  assert.equal(amount, 1);
});

test("ride amount increases after free window", () => {
  const amount = calculateRideAmount("2026-03-06T10:00:00Z", "2026-03-06T10:06:00Z");
  assert.equal(amount, 1.2);
});

test("ride ID validation accepts only expected format", () => {
  assert.equal(isValidRideId("ride-abc-123"), true);
  assert.equal(isValidRideId("ride"), false);
  assert.equal(isValidRideId("bad-ride-123"), false);
});

test("idempotency key validation enforces minimum safe format", () => {
  assert.equal(isValidIdempotencyKey("taskd-ride-001"), true);
  assert.equal(isValidIdempotencyKey("short"), false);
  assert.equal(isValidIdempotencyKey("bad key with spaces"), false);
});

test("date-time validation accepts RFC3339 and rejects invalid values", () => {
  assert.equal(isValidDateTimeString("2026-03-06T10:00:00Z"), true);
  assert.equal(isValidDateTimeString("2026-03-06"), false);
  assert.equal(isValidDateTimeString("invalid"), false);
});
