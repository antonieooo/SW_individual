const crypto = require("crypto");
const express = require("express");

const app = express();
app.use(express.json());

const SERVICE_NAME = "ride-service";
const TOKEN_SECRET = process.env.SERVICE_TOKEN_SECRET || "citybike-shared-secret";

const serviceUrls = {
  database: process.env.DATABASE_CLUSTER_URL || "http://database-cluster-service:3000",
  user: process.env.USER_SERVICE_URL || "http://user-service:3000",
  inventory: process.env.INVENTORY_SERVICE_URL || "http://bike-inventory-service:3000",
  payment: process.env.PAYMENT_SERVICE_URL || "http://payment-service:3000"
};

const dbCredential = process.env.DB_CRED_RIDE || "db-ride-secret";

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

function resolveIdempotencyKey(req) {
  const headerKey = req.headers["idempotency-key"];
  return typeof headerKey === "string" ? headerKey : null;
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
    url: `${serviceUrls.database}/internal/db/ride/${collection}/get`,
    method: "POST",
    body: { id },
    audience: "database-cluster-service",
    scopes: ["db:ride:read"],
    headers: {
      "x-db-credential": dbCredential
    }
  });

  return result.status === 200 ? result.payload.item : null;
}

async function dbList(collection, field, value, limit) {
  const result = await callInternalService({
    url: `${serviceUrls.database}/internal/db/ride/${collection}/list`,
    method: "POST",
    body: { field, value, limit },
    audience: "database-cluster-service",
    scopes: ["db:ride:read"],
    headers: {
      "x-db-credential": dbCredential
    }
  });

  return result.status === 200 ? result.payload.items || [] : [];
}

async function dbUpsert(collection, id, document) {
  const result = await callInternalService({
    url: `${serviceUrls.database}/internal/db/ride/${collection}/upsert`,
    method: "POST",
    body: { id, document },
    audience: "database-cluster-service",
    scopes: ["db:ride:write"],
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

function ensureActorCanAccessUser(req, userId) {
  const actor = req.auth.actor;
  if (!actor || !actor.userId) {
    return true;
  }

  if (actor.role === "maintainer") {
    return true;
  }

  return actor.userId === userId;
}

function sanitizeRide(ride) {
  return {
    rideId: ride.rideId,
    userId: ride.userId,
    bikeId: ride.bikeId,
    status: ride.status,
    startedAt: ride.startedAt,
    endedAt: ride.endedAt || null,
    amount: ride.amount,
    currency: ride.currency || "GBP"
  };
}

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

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function ensureNoQueryParams(req, res) {
  if (!hasUnexpectedQueryParams(req, [])) {
    return true;
  }
  errorResponse(res, 400, "INVALID_QUERY", "Query parameters are not supported for this endpoint");
  return false;
}

function ensureObjectPayload(res, payload, code, message) {
  if (isPlainObject(payload)) {
    return true;
  }
  errorResponse(res, 400, code, message);
  return false;
}

function ensurePayloadKeys(res, payload, allowedKeys, code, message) {
  const allowed = new Set(allowedKeys);
  if (Object.keys(payload).every((key) => allowed.has(key))) {
    return true;
  }
  errorResponse(res, 400, code, message);
  return false;
}

function calculateRideAmount(startedAtIso, endedAtIso) {
  const startedAt = new Date(startedAtIso).getTime();
  const endedAt = new Date(endedAtIso).getTime();
  const minutes = Math.max(1, Math.ceil((endedAt - startedAt) / 60000));
  const amount = 1 + Math.max(0, minutes - 5) * 0.2;
  return Number(amount.toFixed(2));
}

app.get("/status", (_req, res) => {
  res.json({
    status: "ok",
    service: SERVICE_NAME,
    timestamp: new Date().toISOString()
  });
});

app.post("/internal/rides/start", requireInternalAuth, async (req, res) => {
  if (!ensureNoQueryParams(req, res)) {
    return;
  }
  const payload = req.body;
  if (!ensureObjectPayload(res, payload, "INVALID_PAYLOAD", "Ride start payload must be an object")) {
    return;
  }
  if (
    !ensurePayloadKeys(
      res,
      payload,
      ["userId", "bikeId", "startedAt"],
      "INVALID_PAYLOAD",
      "Only userId, bikeId and startedAt are allowed in ride start payload"
    )
  ) {
    return;
  }

  const { userId, bikeId, startedAt } = payload;
  const idempotencyKey = resolveIdempotencyKey(req);

  if (!isValidUserId(userId) || !isValidBikeId(bikeId)) {
    return errorResponse(res, 400, "INVALID_PAYLOAD", "userId and bikeId must match expected ID formats");
  }

  if (!isValidIdempotencyKey(idempotencyKey)) {
    return errorResponse(
      res,
      400,
      "INVALID_PAYLOAD",
      "Idempotency-Key header is required and must be at least 8 safe characters"
    );
  }

  if (startedAt !== undefined && !isValidDateTimeString(startedAt)) {
    return errorResponse(res, 400, "INVALID_PAYLOAD", "startedAt must be an RFC3339 date-time string");
  }

  if (!ensureActorCanAccessUser(req, userId)) {
    return errorResponse(res, 403, "ACCESS_DENIED", "Cannot start ride for another user");
  }

  try {
    const idemRecord = await dbGet("idempotency", idempotencyKey);
    if (idemRecord && idemRecord.rideId) {
      const existingRide = await dbGet("rides", idemRecord.rideId);
      if (existingRide) {
        if (existingRide.userId !== userId || existingRide.bikeId !== bikeId) {
          return errorResponse(
            res,
            409,
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key already maps to a different ride request"
          );
        }
        return res.status(201).json(sanitizeRide(existingRide));
      }
    }

    const actor = req.auth.actor || null;

    const bindingResult = await callInternalService({
      url: `${serviceUrls.user}/internal/users/${userId}/payment-binding`,
      method: "GET",
      audience: "user-service",
      actor,
      scopes: ["billing:verify"]
    });

    if (bindingResult.status !== 200) {
      if (bindingResult.status === 404) {
        return errorResponse(res, 404, "USER_NOT_FOUND", `User ${userId} not found`, bindingResult.payload);
      }
      if (bindingResult.status === 403) {
        return errorResponse(res, 403, "ACCESS_DENIED", "Cannot verify payment binding for this user");
      }
      if (bindingResult.status === 401) {
        return errorResponse(res, 401, "INVALID_SERVICE_TOKEN", "Internal authentication failed");
      }
      return errorResponse(
        res,
        502,
        "PAYMENT_BINDING_INVALID",
        "Cannot verify payment binding for user",
        bindingResult.payload
      );
    }

    const reserveResult = await callInternalService({
      url: `${serviceUrls.inventory}/internal/bikes/${bikeId}/reserve`,
      method: "POST",
      audience: "bike-inventory-service",
      actor,
      scopes: ["inventory:reserve"]
    });

    if (reserveResult.status !== 200) {
      return errorResponse(res, reserveResult.status, "BIKE_UNAVAILABLE", "Bike cannot be reserved", reserveResult.payload);
    }

    const rideId = `ride-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const startedAtValue = startedAt || new Date().toISOString();

    const chargeResult = await callInternalService({
      url: `${serviceUrls.payment}/internal/payments/charge`,
      method: "POST",
      audience: "payment-service",
      actor,
      scopes: ["billing:charge"],
      headers: {
        "Idempotency-Key": `preauth-${idempotencyKey}`
      },
      body: {
        userId,
        rideId,
        amount: 1,
        currency: "GBP",
        paymentBindingId: bindingResult.payload.paymentBindingId
      }
    });

    if (![200, 201].includes(chargeResult.status)) {
      return errorResponse(
        res,
        502,
        "CHARGE_FAILED",
        "Pre-authorisation failed",
        chargeResult.payload
      );
    }

    const ride = {
      rideId,
      userId,
      bikeId,
      status: "active",
      startedAt: startedAtValue,
      endedAt: null,
      amount: 1,
      currency: "GBP"
    };

    const persistedRide = await dbUpsert("rides", rideId, ride);
    if (!persistedRide) {
      return errorResponse(res, 502, "RIDE_PERSISTENCE_FAILED", "Could not persist ride");
    }

    await dbUpsert("idempotency", idempotencyKey, {
      idempotencyKey,
      phase: "start",
      rideId,
      createdAt: new Date().toISOString()
    });

    return res.status(201).json(sanitizeRide(persistedRide));
  } catch (err) {
    return errorResponse(res, 502, "RIDE_START_FAILED", "Could not start ride", err.message);
  }
});

app.post("/internal/rides/:rideId/end", requireInternalAuth, async (req, res) => {
  const { rideId } = req.params;
  if (!isValidRideId(rideId)) {
    return errorResponse(res, 400, "INVALID_PATH", "rideId must match expected ID format");
  }
  if (!ensureNoQueryParams(req, res)) {
    return;
  }
  const payload = req.body;
  if (!ensureObjectPayload(res, payload, "INVALID_PAYLOAD", "Ride end payload must be a JSON object")) {
    return;
  }

  const effectivePayload = payload;
  if (
    !ensurePayloadKeys(
      res,
      effectivePayload,
      ["endedAt", "dockId"],
      "INVALID_PAYLOAD",
      "Only endedAt and dockId are allowed in ride end payload"
    )
  ) {
    return;
  }

  const { endedAt, dockId } = effectivePayload;
  const idempotencyKey = resolveIdempotencyKey(req);

  if (!isValidIdempotencyKey(idempotencyKey)) {
    return errorResponse(
      res,
      400,
      "INVALID_PAYLOAD",
      "Idempotency-Key header is required and must be at least 8 safe characters"
    );
  }

  if (endedAt !== undefined && !isValidDateTimeString(endedAt)) {
    return errorResponse(res, 400, "INVALID_PAYLOAD", "endedAt must be an RFC3339 date-time string");
  }

  if (dockId !== undefined && dockId !== null && !isValidDockId(dockId)) {
    return errorResponse(res, 400, "INVALID_PAYLOAD", "dockId must match expected dock ID format when provided");
  }

  try {
    const ride = await dbGet("rides", rideId);
    if (!ride) {
      return errorResponse(res, 404, "RIDE_NOT_FOUND", `Ride ${rideId} not found`);
    }

    if (!ensureActorCanAccessUser(req, ride.userId)) {
      return errorResponse(res, 403, "ACCESS_DENIED", "Cannot end ride for another user");
    }

    const endIdemKey = `end-${idempotencyKey}`;
    const idemRecord = await dbGet("idempotency", endIdemKey);
    if (idemRecord) {
      if (idemRecord.rideId !== rideId) {
        return errorResponse(
          res,
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency key already maps to a different ride termination request"
        );
      }
      return res.json(sanitizeRide(ride));
    }

    if (ride.status === "completed") {
      return errorResponse(res, 409, "RIDE_ALREADY_ENDED", "Ride is already completed");
    }

    const actor = req.auth.actor || null;

    const releaseResult = await callInternalService({
      url: `${serviceUrls.inventory}/internal/bikes/${ride.bikeId}/release`,
      method: "POST",
      audience: "bike-inventory-service",
      actor,
      scopes: ["inventory:release"],
      body: {
        dockId: dockId === undefined ? null : dockId
      }
    });

    if (releaseResult.status !== 200) {
      return errorResponse(res, 502, "BIKE_RELEASE_FAILED", "Failed to release bike", releaseResult.payload);
    }

    const endedAtValue = endedAt || new Date().toISOString();
    const amount = calculateRideAmount(ride.startedAt, endedAtValue);

    const bindingResult = await callInternalService({
      url: `${serviceUrls.user}/internal/users/${ride.userId}/payment-binding`,
      method: "GET",
      audience: "user-service",
      actor,
      scopes: ["billing:verify"]
    });

    if (bindingResult.status !== 200) {
      return errorResponse(
        res,
        502,
        "PAYMENT_BINDING_INVALID",
        "Could not verify payment binding",
        bindingResult.payload
      );
    }

    const chargeResult = await callInternalService({
      url: `${serviceUrls.payment}/internal/payments/charge`,
      method: "POST",
      audience: "payment-service",
      actor,
      scopes: ["billing:charge"],
      headers: {
        "Idempotency-Key": `final-${idempotencyKey}`
      },
      body: {
        userId: ride.userId,
        rideId: ride.rideId,
        amount,
        currency: "GBP",
        paymentBindingId: bindingResult.payload.paymentBindingId
      }
    });

    if (![200, 201].includes(chargeResult.status)) {
      return errorResponse(res, 502, "FINAL_CHARGE_FAILED", "Could not create final charge", chargeResult.payload);
    }

    const updatedRide = {
      ...ride,
      status: "completed",
      endedAt: endedAtValue,
      amount
    };

    const persistedRide = await dbUpsert("rides", rideId, updatedRide);
    if (!persistedRide) {
      return errorResponse(res, 502, "RIDE_PERSISTENCE_FAILED", "Could not persist ended ride");
    }

    await dbUpsert("idempotency", endIdemKey, {
      idempotencyKey: endIdemKey,
      phase: "end",
      rideId,
      createdAt: new Date().toISOString()
    });

    return res.json(sanitizeRide(persistedRide));
  } catch (err) {
    return errorResponse(res, 502, "RIDE_END_FAILED", "Could not end ride", err.message);
  }
});

app.get("/internal/rides/:rideId", requireInternalAuth, async (req, res) => {
  const { rideId } = req.params;
  if (!isValidRideId(rideId)) {
    return errorResponse(res, 400, "INVALID_PATH", "rideId must match expected ID format");
  }
  if (!ensureNoQueryParams(req, res)) {
    return;
  }

  try {
    const ride = await dbGet("rides", rideId);
    if (!ride) {
      return errorResponse(res, 404, "RIDE_NOT_FOUND", `Ride ${rideId} not found`);
    }

    if (!ensureActorCanAccessUser(req, ride.userId)) {
      return errorResponse(res, 403, "ACCESS_DENIED", "Cannot access this ride");
    }

    if (
      !isValidRideId(ride.rideId) ||
      !isValidUserId(ride.userId) ||
      !isValidBikeId(ride.bikeId) ||
      !["active", "completed"].includes(ride.status)
    ) {
      return errorResponse(res, 409, "RIDE_STATE_CONFLICT", "Ride has an invalid state");
    }

    return res.json(sanitizeRide(ride));
  } catch (err) {
    return errorResponse(res, 502, "RIDE_QUERY_FAILED", "Could not read ride", err.message);
  }
});

app.get("/internal/users/:userId/rides", requireInternalAuth, async (req, res) => {
  const { userId } = req.params;
  if (!isValidUserId(userId)) {
    return errorResponse(res, 400, "INVALID_PATH", "userId must match expected ID format");
  }
  if (!ensureActorCanAccessUser(req, userId)) {
    return errorResponse(res, 403, "ACCESS_DENIED", "Cannot access rides for this user");
  }

  if (hasUnexpectedQueryParams(req, ["limit"])) {
    return errorResponse(res, 400, "INVALID_QUERY", "Only limit query parameter is supported");
  }

  let limit = 5;
  if (req.query.limit !== undefined) {
    const parsedLimit = Number(req.query.limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 20) {
      return errorResponse(res, 400, "INVALID_QUERY", "limit must be an integer between 1 and 20");
    }
    limit = parsedLimit;
  }

  try {
    const rides = await dbList("rides", "userId", userId, 200);

    const hasInvalidRideRecord = rides.some((ride) => {
      return (
        !ride ||
        !isValidRideId(ride.rideId) ||
        !isValidUserId(ride.userId) ||
        !isValidBikeId(ride.bikeId) ||
        !ride.startedAt ||
        !["active", "completed"].includes(ride.status)
      );
    });
    if (hasInvalidRideRecord) {
      return errorResponse(res, 409, "RIDE_HISTORY_CONFLICT", "Ride history contains invalid records");
    }

    const items = rides
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
      .slice(0, limit)
      .map(sanitizeRide);

    return res.json({ items });
  } catch (err) {
    return errorResponse(res, 502, "RIDE_QUERY_FAILED", "Could not list rides", err.message);
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
