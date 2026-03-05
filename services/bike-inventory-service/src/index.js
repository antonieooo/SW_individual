const crypto = require("crypto");
const express = require("express");

const app = express();
app.use(express.json());

const SERVICE_NAME = "bike-inventory-service";
const TOKEN_SECRET = process.env.SERVICE_TOKEN_SECRET || "citybike-shared-secret";

const serviceUrls = {
  database: process.env.DATABASE_CLUSTER_URL || "http://database-cluster-service:3000"
};

const dbCredential = process.env.DB_CRED_INVENTORY || "db-inventory-secret";
const allowedDeviceCerts = new Set(
  (process.env.DEVICE_CERT_ALLOWLIST || "device-cert-taskd-001")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
);

function encodePart(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signToken(payload) {
  const encodedPayload = encodePart(payload);
  const signature = crypto
    .createHmac("sha256", TOKEN_SECRET)
    .update(encodedPayload)
    .digest("base64url");
  return `${encodedPayload}.${signature}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) {
    return null;
  }

  const [encodedPayload, signature] = token.split(".");
  const expectedSignature = crypto
    .createHmac("sha256", TOKEN_SECRET)
    .update(encodedPayload)
    .digest("base64url");

  if (signature !== expectedSignature) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    if (payload.exp && Date.now() > payload.exp * 1000) {
      return null;
    }
    return payload;
  } catch (_err) {
    return null;
  }
}

function errorResponse(res, status, code, message, details = null) {
  return res.status(status).json({
    error: {
      code,
      message,
      details
    }
  });
}

function getBearerToken(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return null;
  }
  return header.slice("Bearer ".length).trim();
}

function buildServiceToken(aud, actor, scopes = []) {
  return signToken({
    type: "service",
    iss: SERVICE_NAME,
    aud,
    actor: actor || null,
    scopes,
    exp: Math.floor(Date.now() / 1000) + 300
  });
}

async function callInternalService({ url, method, body, audience, actor, scopes = [], headers = {} }) {
  const requestHeaders = {
    authorization: `Bearer ${buildServiceToken(audience, actor, scopes)}`,
    "x-internal-mtls": "true",
    ...headers
  };

  const options = { method, headers: requestHeaders };
  if (body !== undefined) {
    requestHeaders["content-type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const raw = await response.text();
  let payload = null;

  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch (_err) {
      payload = { raw };
    }
  }

  return { status: response.status, payload };
}

async function dbGet(collection, id) {
  const result = await callInternalService({
    url: `${serviceUrls.database}/internal/db/inventory/${collection}/get`,
    method: "POST",
    body: { id },
    audience: "database-cluster-service",
    scopes: ["db:inventory:read"],
    headers: {
      "x-db-credential": dbCredential
    }
  });

  return result.status === 200 ? result.payload.item : null;
}

async function dbUpsert(collection, id, document) {
  const result = await callInternalService({
    url: `${serviceUrls.database}/internal/db/inventory/${collection}/upsert`,
    method: "POST",
    body: { id, document },
    audience: "database-cluster-service",
    scopes: ["db:inventory:write"],
    headers: {
      "x-db-credential": dbCredential
    }
  });

  return result.status === 201 ? result.payload.item : null;
}

function requireInternalAuth(req, res, next) {
  if (req.headers["x-internal-mtls"] !== "true") {
    return errorResponse(res, 401, "MTLS_REQUIRED", "x-internal-mtls=true is required");
  }

  const token = getBearerToken(req);
  const claims = verifyToken(token);

  if (!claims || claims.type !== "service") {
    return errorResponse(res, 401, "INVALID_SERVICE_TOKEN", "Valid internal token is required");
  }

  if (claims.aud && claims.aud !== SERVICE_NAME) {
    return errorResponse(res, 403, "INVALID_AUDIENCE", `Token audience must be ${SERVICE_NAME}`);
  }

  req.auth = claims;
  return next();
}

function sanitizeBike(bike) {
  return {
    bikeId: bike.bikeId,
    availability: bike.availability,
    lockState: bike.lockState,
    dockId: bike.dockId || null,
    lastUpdated: bike.lastUpdated
  };
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidBikeId(value) {
  return typeof value === "string" && /^bike-[A-Za-z0-9._:-]+$/.test(value);
}

function isValidDockId(value) {
  return typeof value === "string" && /^dock-[A-Za-z0-9._:-]+$/.test(value);
}

function isValidNonce(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{6,128}$/.test(value);
}

function isAllowedDeviceCert(value) {
  return isNonEmptyString(value) && allowedDeviceCerts.has(value);
}

function isValidDateTimeString(value) {
  if (typeof value !== "string") {
    return false;
  }
  const dateTimePattern =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  return dateTimePattern.test(value) && !Number.isNaN(Date.parse(value));
}

function getQueryKeys(req) {
  const parsedKeys = Object.keys(req.query || {});
  const originalUrl = typeof req.originalUrl === "string" ? req.originalUrl : "";
  const queryIndex = originalUrl.indexOf("?");
  if (queryIndex === -1) {
    return parsedKeys;
  }
  const rawQuery = originalUrl.slice(queryIndex + 1);
  const rawKeys = Array.from(new URLSearchParams(rawQuery).keys());
  return Array.from(new Set([...parsedKeys, ...rawKeys]));
}

function hasUnexpectedQueryParams(req, allowedKeys) {
  const allowed = new Set(allowedKeys);
  return getQueryKeys(req).some((key) => !key || !allowed.has(key));
}

app.get("/status", (_req, res) => {
  res.json({
    status: "ok",
    service: SERVICE_NAME,
    timestamp: new Date().toISOString()
  });
});

app.get("/internal/bikes/:bikeId", requireInternalAuth, async (req, res) => {
  if (!isValidBikeId(req.params.bikeId)) {
    return errorResponse(res, 400, "INVALID_PATH", "bikeId must match expected bike ID format");
  }
  if (hasUnexpectedQueryParams(req, [])) {
    return errorResponse(res, 400, "INVALID_QUERY", "Query parameters are not supported for this endpoint");
  }

  try {
    const bike = await dbGet("bikes", req.params.bikeId);
    if (!bike) {
      return errorResponse(res, 404, "BIKE_NOT_FOUND", `Bike ${req.params.bikeId} not found`);
    }

    return res.json(sanitizeBike(bike));
  } catch (err) {
    return errorResponse(res, 502, "BIKE_QUERY_FAILED", "Cannot query bike state", err.message);
  }
});

app.post("/internal/bikes/:bikeId/reserve", requireInternalAuth, async (req, res) => {
  const { bikeId } = req.params;
  if (!isValidBikeId(bikeId)) {
    return errorResponse(res, 400, "INVALID_PATH", "bikeId must match expected bike ID format");
  }
  if (hasUnexpectedQueryParams(req, [])) {
    return errorResponse(res, 400, "INVALID_QUERY", "Query parameters are not supported for this endpoint");
  }
  const payload = req.body;
  if (payload !== undefined && (payload === null || typeof payload !== "object" || Array.isArray(payload))) {
    return errorResponse(res, 400, "INVALID_PAYLOAD", "Reserve payload must be an object when provided");
  }
  if (payload && Object.keys(payload).length > 0) {
    return errorResponse(res, 400, "INVALID_PAYLOAD", "Reserve payload does not accept fields");
  }

  try {
    const bike = await dbGet("bikes", bikeId);
    if (!bike) {
      return errorResponse(res, 404, "BIKE_NOT_FOUND", `Bike ${bikeId} not found`);
    }

    if (bike.availability !== "available") {
      return errorResponse(res, 409, "BIKE_UNAVAILABLE", `Bike ${bikeId} is not available`);
    }

    const updated = {
      ...bike,
      availability: "reserved",
      lockState: "unlocked",
      lastUpdated: new Date().toISOString()
    };

    const persisted = await dbUpsert("bikes", bikeId, updated);
    if (!persisted) {
      return errorResponse(res, 502, "BIKE_UPDATE_FAILED", "Could not persist bike state");
    }

    return res.json(sanitizeBike(persisted));
  } catch (err) {
    return errorResponse(res, 502, "BIKE_RESERVE_FAILED", "Could not reserve bike", err.message);
  }
});

app.post("/internal/bikes/:bikeId/release", requireInternalAuth, async (req, res) => {
  const { bikeId } = req.params;
  if (!isValidBikeId(bikeId)) {
    return errorResponse(res, 400, "INVALID_PATH", "bikeId must match expected bike ID format");
  }
  if (hasUnexpectedQueryParams(req, [])) {
    return errorResponse(res, 400, "INVALID_QUERY", "Query parameters are not supported for this endpoint");
  }
  const payload = req.body;
  if (payload !== undefined && (payload === null || typeof payload !== "object" || Array.isArray(payload))) {
    return errorResponse(res, 400, "INVALID_PAYLOAD", "Release payload must be an object when provided");
  }

  const effectivePayload = payload || {};
  const allowedKeys = ["dockId"];
  const hasUnsupportedKey = Object.keys(effectivePayload).some((key) => !allowedKeys.includes(key));
  if (hasUnsupportedKey) {
    return errorResponse(res, 400, "INVALID_PAYLOAD", "Only dockId is allowed in release payload");
  }

  const hasDockId = Object.prototype.hasOwnProperty.call(effectivePayload, "dockId");
  const dockId = hasDockId ? effectivePayload.dockId : undefined;
  if (hasDockId && dockId !== null && !isValidDockId(dockId)) {
    return errorResponse(res, 400, "INVALID_PAYLOAD", "dockId must match expected dock ID format or be null");
  }

  try {
    const bike = await dbGet("bikes", bikeId);
    if (!bike) {
      return errorResponse(res, 404, "BIKE_NOT_FOUND", `Bike ${bikeId} not found`);
    }

    const updated = {
      ...bike,
      availability: "available",
      lockState: "locked",
      dockId: hasDockId ? dockId : bike.dockId || null,
      lastUpdated: new Date().toISOString()
    };

    const persisted = await dbUpsert("bikes", bikeId, updated);
    if (!persisted) {
      return errorResponse(res, 502, "BIKE_UPDATE_FAILED", "Could not persist bike state");
    }

    return res.json(sanitizeBike(persisted));
  } catch (err) {
    return errorResponse(res, 502, "BIKE_RELEASE_FAILED", "Could not release bike", err.message);
  }
});

app.post("/internal/device-events", requireInternalAuth, async (req, res) => {
  if (hasUnexpectedQueryParams(req, [])) {
    return errorResponse(res, 400, "INVALID_QUERY", "Query parameters are not supported for this endpoint");
  }
  const deviceCert = req.headers["x-device-cert"];
  if (!isAllowedDeviceCert(deviceCert)) {
    return errorResponse(res, 401, "DEVICE_CERT_REQUIRED", "A valid x-device-cert header is required");
  }

  const payload = req.body;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return errorResponse(res, 400, "INVALID_EVENT_PAYLOAD", "Device event payload must be an object");
  }
  const allowedKeys = ["bikeId", "eventType", "nonce", "timestamp", "dockId"];
  const hasUnsupportedKey = Object.keys(payload).some((key) => !allowedKeys.includes(key));
  if (hasUnsupportedKey) {
    return errorResponse(
      res,
      400,
      "INVALID_EVENT_PAYLOAD",
      "Only bikeId, eventType, nonce, timestamp and dockId are allowed"
    );
  }

  const { bikeId, eventType, nonce, timestamp, dockId } = payload;
  if (
    !isValidBikeId(bikeId) ||
    !isNonEmptyString(eventType) ||
    !isValidNonce(nonce) ||
    !isNonEmptyString(timestamp)
  ) {
    return errorResponse(
      res,
      400,
      "INVALID_EVENT_PAYLOAD",
      "bikeId, eventType, nonce and timestamp are required in valid formats"
    );
  }

  if (!["telemetry", "lock", "unlock"].includes(eventType)) {
    return errorResponse(res, 400, "INVALID_EVENT_TYPE", "Unsupported eventType");
  }

  if (!isValidDateTimeString(timestamp)) {
    return errorResponse(res, 400, "INVALID_EVENT_PAYLOAD", "timestamp must be an RFC3339 date-time string");
  }

  if (dockId !== undefined && dockId !== null && !isValidDockId(dockId)) {
    return errorResponse(res, 400, "INVALID_EVENT_PAYLOAD", "dockId must match expected dock ID format or be null");
  }

  try {
    const existingNonce = await dbGet("usedNonces", nonce);
    if (existingNonce) {
      return errorResponse(res, 409, "NONCE_REPLAYED", "Duplicate nonce detected");
    }

    await dbUpsert("usedNonces", nonce, {
      nonce,
      timestamp,
      deviceCertHash: crypto.createHash("sha256").update(deviceCert).digest("hex")
    });

    const currentBike =
      (await dbGet("bikes", bikeId)) || {
        bikeId,
        availability: "available",
        lockState: "locked",
        dockId: null,
        lastUpdated: new Date().toISOString()
      };

    const hasDockId = Object.prototype.hasOwnProperty.call(payload, "dockId");

    const updatedBike = {
      ...currentBike,
      lockState:
        eventType === "lock" ? "locked" : eventType === "unlock" ? "unlocked" : currentBike.lockState,
      availability:
        eventType === "unlock"
          ? "reserved"
          : eventType === "lock"
          ? "available"
          : currentBike.availability,
      dockId: hasDockId ? dockId : currentBike.dockId || null,
      lastUpdated: new Date().toISOString()
    };

    await dbUpsert("bikes", bikeId, updatedBike);

    return res.status(202).json({ accepted: true });
  } catch (err) {
    return errorResponse(res, 502, "DEVICE_EVENT_FAILED", "Could not process device event", err.message);
  }
});

app.post("/internal/admin/bikes/:bikeId/override-lock", requireInternalAuth, async (req, res) => {
  if (!isValidBikeId(req.params.bikeId)) {
    return errorResponse(res, 400, "INVALID_PATH", "bikeId must match expected bike ID format");
  }
  if (hasUnexpectedQueryParams(req, [])) {
    return errorResponse(res, 400, "INVALID_QUERY", "Query parameters are not supported for this endpoint");
  }

  const actor = req.auth.actor;
  if (!actor || actor.role !== "maintainer") {
    return errorResponse(res, 403, "MAINTAINER_REQUIRED", "Maintainer role required for override");
  }

  const { lockState } = req.body || {};
  if (!["locked", "unlocked"].includes(lockState)) {
    return errorResponse(res, 400, "INVALID_LOCK_STATE", "lockState must be locked or unlocked");
  }

  try {
    const bike = await dbGet("bikes", req.params.bikeId);
    if (!bike) {
      return errorResponse(res, 404, "BIKE_NOT_FOUND", `Bike ${req.params.bikeId} not found`);
    }

    const updated = {
      ...bike,
      lockState,
      availability: lockState === "locked" ? "available" : bike.availability,
      lastUpdated: new Date().toISOString()
    };

    const persisted = await dbUpsert("bikes", req.params.bikeId, updated);
    if (!persisted) {
      return errorResponse(res, 502, "BIKE_UPDATE_FAILED", "Could not persist lock override");
    }

    return res.json(sanitizeBike(persisted));
  } catch (err) {
    return errorResponse(res, 502, "OVERRIDE_FAILED", "Could not override lock state", err.message);
  }
});

app.use((err, _req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && Object.prototype.hasOwnProperty.call(err, "body")) {
    return errorResponse(res, 400, "INVALID_JSON", "Malformed JSON request body");
  }
  return next(err);
});

app.use((err, _req, res, _next) => {
  return errorResponse(res, 500, "INTERNAL_ERROR", "Unhandled server error", err.message);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`${SERVICE_NAME} listening on ${PORT}`);
});
