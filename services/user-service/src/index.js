const crypto = require("crypto");
const express = require("express");

const app = express();
app.use(express.json());

const SERVICE_NAME = "user-service";
const TOKEN_SECRET = process.env.SERVICE_TOKEN_SECRET || "citybike-shared-secret";

const serviceUrls = {
  database: process.env.DATABASE_CLUSTER_URL || "http://database-cluster-service:3000",
  ride: process.env.RIDE_SERVICE_URL || "http://ride-service:3000",
  payment: process.env.PAYMENT_SERVICE_URL || "http://payment-service:3000"
};

const dbCredential = process.env.DB_CRED_USER || "db-user-secret";

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

async function dbGetUserById(userId) {
  const result = await callInternalService({
    url: `${serviceUrls.database}/internal/db/user/users/get`,
    method: "POST",
    body: { id: userId },
    audience: "database-cluster-service",
    scopes: ["db:user:read"],
    headers: {
      "x-db-credential": dbCredential
    }
  });

  if (result.status !== 200) {
    return null;
  }
  return result.payload.item;
}

async function dbFindUserByEmail(email) {
  const result = await callInternalService({
    url: `${serviceUrls.database}/internal/db/user/users/list`,
    method: "POST",
    body: { field: "email", value: email, limit: 1 },
    audience: "database-cluster-service",
    scopes: ["db:user:read"],
    headers: {
      "x-db-credential": dbCredential
    }
  });

  if (result.status !== 200 || !result.payload || !Array.isArray(result.payload.items)) {
    return null;
  }

  return result.payload.items[0] || null;
}

async function dbUpsertUser(user) {
  const result = await callInternalService({
    url: `${serviceUrls.database}/internal/db/user/users/upsert`,
    method: "POST",
    body: { id: user.id, document: user },
    audience: "database-cluster-service",
    scopes: ["db:user:write"],
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

function canAccessUser(req, targetUserId) {
  const actor = req.auth.actor;
  if (!actor) {
    return true;
  }

  if (actor.role === "maintainer") {
    return true;
  }

  return actor.userId === targetUserId;
}

function isValidUserId(value) {
  return typeof value === "string" && /^[um]-[A-Za-z0-9._:-]+$/.test(value);
}

function isValidProfileName(value) {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9 .'-]{1,63}$/.test(value.trim());
}

function isValidPhone(value) {
  return typeof value === "string" && /^[+]?[0-9\- ]{7,20}$/.test(value);
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

function rejectUnexpectedQueryParams(req, res, next) {
  if (!hasUnexpectedQueryParams(req, [])) {
    return next();
  }
  return errorResponse(res, 400, "INVALID_QUERY", "Query parameters are not supported for this endpoint");
}

function sanitizeUser(user) {
  return {
    id: user.id,
    role: user.role,
    email: user.email,
    name: user.name,
    phone: user.phone
  };
}

app.get("/status", (_req, res) => {
  res.json({
    status: "ok",
    service: SERVICE_NAME,
    timestamp: new Date().toISOString()
  });
});

app.use("/internal", requireInternalAuth, rejectUnexpectedQueryParams);

app.post("/internal/auth/login", async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return errorResponse(res, 400, "INVALID_CREDENTIALS", "email and password are required");
  }

  try {
    const user = await dbFindUserByEmail(email);
    if (!user || user.password !== password) {
      return errorResponse(res, 401, "AUTH_FAILED", "Invalid email or password");
    }

    return res.json({
      user: sanitizeUser(user)
    });
  } catch (err) {
    return errorResponse(res, 502, "DB_UNAVAILABLE", "Cannot query user store", err.message);
  }
});

app.get("/internal/users/:userId/profile", async (req, res) => {
  const { userId } = req.params;
  if (!isValidUserId(userId)) {
    return errorResponse(res, 400, "INVALID_PATH", "userId must match expected ID format");
  }
  if (!canAccessUser(req, userId)) {
    return errorResponse(res, 403, "ACCESS_DENIED", "Access to this profile is forbidden");
  }

  try {
    const user = await dbGetUserById(userId);
    if (!user) {
      return errorResponse(res, 404, "USER_NOT_FOUND", `User ${userId} not found`);
    }

    return res.json(sanitizeUser(user));
  } catch (err) {
    return errorResponse(res, 502, "DB_UNAVAILABLE", "Cannot query user store", err.message);
  }
});

app.patch("/internal/users/:userId/profile", async (req, res) => {
  const { userId } = req.params;
  if (!isValidUserId(userId)) {
    return errorResponse(res, 400, "INVALID_PATH", "userId must match expected ID format");
  }
  if (!canAccessUser(req, userId)) {
    return errorResponse(res, 403, "ACCESS_DENIED", "Profile update forbidden");
  }

  const payload = req.body;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return errorResponse(res, 400, "INVALID_PATCH", "Profile patch payload must be an object");
  }

  const allowedKeys = ["name", "phone"];
  const hasUnsupportedKey = Object.keys(payload).some((key) => !allowedKeys.includes(key));
  if (hasUnsupportedKey) {
    return errorResponse(res, 400, "INVALID_PATCH", "Only name and phone can be updated");
  }

  const hasName = Object.prototype.hasOwnProperty.call(payload, "name");
  const hasPhone = Object.prototype.hasOwnProperty.call(payload, "phone");

  if (!hasName && !hasPhone) {
    return errorResponse(res, 400, "INVALID_PATCH", "At least one mutable field is required");
  }

  if (hasName && !isValidProfileName(payload.name)) {
    return errorResponse(res, 400, "INVALID_PATCH", "name must be a non-empty string with at least 2 characters");
  }

  if (hasPhone && !isValidPhone(payload.phone)) {
    return errorResponse(
      res,
      400,
      "INVALID_PATCH",
      "phone must match +?[0-9- ] and be between 7 and 20 characters"
    );
  }

  try {
    const user = await dbGetUserById(userId);
    if (!user) {
      return errorResponse(res, 404, "USER_NOT_FOUND", `User ${userId} not found`);
    }

    const updated = {
      ...user,
      name: hasName ? payload.name : user.name,
      phone: hasPhone ? payload.phone : user.phone
    };

    const persisted = await dbUpsertUser(updated);
    if (!persisted) {
      return errorResponse(res, 502, "DB_WRITE_FAILED", "Could not persist user profile");
    }

    return res.json(sanitizeUser(persisted));
  } catch (err) {
    return errorResponse(res, 502, "DB_UNAVAILABLE", "Cannot update user store", err.message);
  }
});

app.get("/internal/users/:userId/payment-binding", async (req, res) => {
  const { userId } = req.params;
  if (!isValidUserId(userId)) {
    return errorResponse(res, 400, "INVALID_PATH", "userId must match expected ID format");
  }

  try {
    const user = await dbGetUserById(userId);
    if (!user) {
      return errorResponse(res, 404, "USER_NOT_FOUND", `User ${userId} not found`);
    }

    return res.json({
      userId,
      paymentBindingId: user.paymentBindingId,
      status: "valid"
    });
  } catch (err) {
    return errorResponse(res, 502, "DB_UNAVAILABLE", "Cannot query user store", err.message);
  }
});

app.get("/internal/users/:userId/dashboard", async (req, res) => {
  const { userId } = req.params;
  if (!isValidUserId(userId)) {
    return errorResponse(res, 400, "INVALID_PATH", "userId must match expected ID format");
  }
  if (!canAccessUser(req, userId)) {
    return errorResponse(res, 403, "ACCESS_DENIED", "Access to dashboard is forbidden");
  }

  try {
    const user = await dbGetUserById(userId);
    if (!user) {
      return errorResponse(res, 404, "USER_NOT_FOUND", `User ${userId} not found`);
    }

    const actor = req.auth.actor || null;

    const rideResult = await callInternalService({
      url: `${serviceUrls.ride}/internal/users/${userId}/rides?limit=5`,
      method: "GET",
      audience: "ride-service",
      actor,
      scopes: ["rides:read"]
    });

    const billingResult = await callInternalService({
      url: `${serviceUrls.payment}/internal/users/${userId}/billing-summary`,
      method: "GET",
      audience: "payment-service",
      actor,
      scopes: ["billing:read"]
    });

    if (rideResult.status !== 200) {
      return errorResponse(res, 502, "RIDE_QUERY_FAILED", "Could not fetch ride summary", rideResult.payload);
    }

    if (billingResult.status !== 200) {
      return errorResponse(
        res,
        502,
        "BILLING_QUERY_FAILED",
        "Could not fetch billing summary",
        billingResult.payload
      );
    }

    return res.json({
      profile: sanitizeUser(user),
      recentRides: rideResult.payload.items || [],
      billingSummary: billingResult.payload
    });
  } catch (err) {
    return errorResponse(res, 502, "DASHBOARD_FAILED", "Could not assemble dashboard", err.message);
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
