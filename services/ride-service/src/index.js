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
  const { userId, bikeId, idempotencyKey, startedAt } = req.body || {};

  if (!userId || !bikeId || !idempotencyKey) {
    return errorResponse(res, 400, "INVALID_PAYLOAD", "userId, bikeId and idempotencyKey are required");
  }

  if (!ensureActorCanAccessUser(req, userId)) {
    return errorResponse(res, 403, "ACCESS_DENIED", "Cannot start ride for another user");
  }

  try {
    const idemRecord = await dbGet("idempotency", idempotencyKey);
    if (idemRecord && idemRecord.rideId) {
      const existingRide = await dbGet("rides", idemRecord.rideId);
      if (existingRide) {
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
      return errorResponse(
        res,
        400,
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
      body: {
        userId,
        rideId,
        amount: 1,
        currency: "GBP",
        paymentBindingId: bindingResult.payload.paymentBindingId,
        idempotencyKey: `preauth-${idempotencyKey}`
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
  const { idempotencyKey, endedAt, dockId, userId } = req.body || {};

  if (!idempotencyKey) {
    return errorResponse(res, 400, "INVALID_PAYLOAD", "idempotencyKey is required");
  }

  try {
    const ride = await dbGet("rides", rideId);
    if (!ride) {
      return errorResponse(res, 404, "RIDE_NOT_FOUND", `Ride ${rideId} not found`);
    }

    const effectiveUserId = userId || ride.userId;
    if (!ensureActorCanAccessUser(req, effectiveUserId)) {
      return errorResponse(res, 403, "ACCESS_DENIED", "Cannot end ride for another user");
    }

    const endIdemKey = `end-${idempotencyKey}`;
    const idemRecord = await dbGet("idempotency", endIdemKey);
    if (idemRecord && idemRecord.rideId === rideId) {
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
        dockId: dockId || null
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
      body: {
        userId: ride.userId,
        rideId: ride.rideId,
        amount,
        currency: "GBP",
        paymentBindingId: bindingResult.payload.paymentBindingId,
        idempotencyKey: `final-${idempotencyKey}`
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

  try {
    const ride = await dbGet("rides", rideId);
    if (!ride) {
      return errorResponse(res, 404, "RIDE_NOT_FOUND", `Ride ${rideId} not found`);
    }

    if (!ensureActorCanAccessUser(req, ride.userId)) {
      return errorResponse(res, 403, "ACCESS_DENIED", "Cannot access this ride");
    }

    return res.json(sanitizeRide(ride));
  } catch (err) {
    return errorResponse(res, 502, "RIDE_QUERY_FAILED", "Could not read ride", err.message);
  }
});

app.get("/internal/users/:userId/rides", requireInternalAuth, async (req, res) => {
  const { userId } = req.params;
  if (!ensureActorCanAccessUser(req, userId)) {
    return errorResponse(res, 403, "ACCESS_DENIED", "Cannot access rides for this user");
  }

  const limit = Math.max(1, Math.min(20, Number(req.query.limit || 5)));

  try {
    const rides = await dbList("rides", "userId", userId, 200);

    const items = rides
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
      .slice(0, limit)
      .map(sanitizeRide);

    return res.json({ items });
  } catch (err) {
    return errorResponse(res, 502, "RIDE_QUERY_FAILED", "Could not list rides", err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`${SERVICE_NAME} listening on ${PORT}`);
});
