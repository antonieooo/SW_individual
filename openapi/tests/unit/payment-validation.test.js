const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isValidUserId,
  isValidRideId,
  isValidPaymentBindingId,
  isValidPaymentId,
  isValidIdempotencyKey,
  isIsoCurrency
} = require("../../../services/payment-service/src/validation.js");

test("payment validators accept expected identifier formats", () => {
  assert.equal(isValidUserId("u-100"), true);
  assert.equal(isValidRideId("ride-100"), true);
  assert.equal(isValidPaymentBindingId("paybind-u-100"), true);
  assert.equal(isValidPaymentId("pay-100"), true);
});

test("payment validators reject malformed identifiers", () => {
  assert.equal(isValidUserId("user-100"), false);
  assert.equal(isValidRideId("ride"), false);
  assert.equal(isValidPaymentBindingId("paybind"), false);
  assert.equal(isValidPaymentId("payment-100"), false);
});

test("currency and idempotency validators enforce strict formats", () => {
  assert.equal(isIsoCurrency("GBP"), true);
  assert.equal(isIsoCurrency("gbp"), false);
  assert.equal(isValidIdempotencyKey("taskd-payment-001"), true);
  assert.equal(isValidIdempotencyKey("short"), false);
});
