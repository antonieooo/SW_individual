function isValidIdempotencyKey(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{8,}$/.test(value);
}

function isValidUserId(value) {
  return typeof value === "string" && /^[um]-[A-Za-z0-9._:-]+$/.test(value);
}

function isValidBikeId(value) {
  return typeof value === "string" && /^bike-[A-Za-z0-9._:-]+$/.test(value);
}

function isValidRideId(value) {
  return typeof value === "string" && /^ride-[A-Za-z0-9._:-]+$/.test(value);
}

function isValidDockId(value) {
  return typeof value === "string" && /^dock-[A-Za-z0-9._:-]+$/.test(value);
}

function isValidDateTimeString(value) {
  if (typeof value !== "string") {
    return false;
  }
  const dateTimePattern =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  return dateTimePattern.test(value) && !Number.isNaN(Date.parse(value));
}

function calculateRideAmount(startedAtIso, endedAtIso) {
  const startedAt = new Date(startedAtIso).getTime();
  const endedAt = new Date(endedAtIso).getTime();
  const minutes = Math.max(1, Math.ceil((endedAt - startedAt) / 60000));
  const amount = 1 + Math.max(0, minutes - 5) * 0.2;
  return Number(amount.toFixed(2));
}

module.exports = {
  calculateRideAmount,
  isValidIdempotencyKey,
  isValidUserId,
  isValidBikeId,
  isValidRideId,
  isValidDockId,
  isValidDateTimeString
};
