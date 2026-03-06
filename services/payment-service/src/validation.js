function isValidUserId(value) {
  return typeof value === "string" && /^[um]-[A-Za-z0-9._:-]+$/.test(value);
}

function isValidRideId(value) {
  return typeof value === "string" && /^ride-[A-Za-z0-9._:-]+$/.test(value);
}

function isValidPaymentBindingId(value) {
  return typeof value === "string" && /^paybind-[A-Za-z0-9._:-]+$/.test(value);
}

function isValidPaymentId(value) {
  return typeof value === "string" && /^pay-[A-Za-z0-9._:-]+$/.test(value);
}

function isValidIdempotencyKey(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{8,}$/.test(value);
}

function isIsoCurrency(value) {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value);
}

module.exports = {
  isValidUserId,
  isValidRideId,
  isValidPaymentBindingId,
  isValidPaymentId,
  isValidIdempotencyKey,
  isIsoCurrency
};
