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

app.get("/status", (_req, res) => {
  res.json({
    status: "ok",
    service: SERVICE_NAME,
    timestamp: new Date().toISOString()
  });
});

app.get("/internal/bikes/:bikeId", requireInternalAuth, async (req, res) => {
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
  const dockId = req.body && req.body.dockId;

  try {
    const bike = await dbGet("bikes", bikeId);
    if (!bike) {
      return errorResponse(res, 404, "BIKE_NOT_FOUND", `Bike ${bikeId} not found`);
    }

    const updated = {
      ...bike,
      availability: "available",
      lockState: "locked",
      dockId: dockId || bike.dockId || null,
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
  const deviceCert = req.headers["x-device-cert"];
  if (!deviceCert) {
    return errorResponse(res, 401, "DEVICE_CERT_REQUIRED", "x-device-cert header is required");
  }

  const { bikeId, eventType, nonce, timestamp, dockId } = req.body || {};
  if (!bikeId || !eventType || !nonce || !timestamp) {
    return errorResponse(
      res,
      400,
      "INVALID_EVENT_PAYLOAD",
      "bikeId, eventType, nonce and timestamp are required"
    );
  }

  if (!["telemetry", "lock", "unlock"].includes(eventType)) {
    return errorResponse(res, 400, "INVALID_EVENT_TYPE", "Unsupported eventType");
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
      dockId: dockId || currentBike.dockId || null,
      lastUpdated: new Date().toISOString()
    };

    await dbUpsert("bikes", bikeId, updatedBike);

    return res.status(202).json({ accepted: true });
  } catch (err) {
    return errorResponse(res, 502, "DEVICE_EVENT_FAILED", "Could not process device event", err.message);
  }
});

app.post("/internal/admin/bikes/:bikeId/override-lock", requireInternalAuth, async (req, res) => {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`${SERVICE_NAME} listening on ${PORT}`);
});
