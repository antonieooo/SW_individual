const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const https = require("https");

const app = express();
app.use(express.json());

const SERVICE_NAME = "api-gateway-service";
const TOKEN_SECRET = process.env.SERVICE_TOKEN_SECRET || "citybike-shared-secret";

const serviceUrls = {
  user: process.env.USER_SERVICE_URL || "http://user-service:3000",
  ride: process.env.RIDE_SERVICE_URL || "http://ride-service:3000",
  inventory: process.env.INVENTORY_SERVICE_URL || "http://bike-inventory-service:3000",
  payment: process.env.PAYMENT_SERVICE_URL || "http://payment-service:3000",
  partnerAnalytics:
    process.env.PARTNER_ANALYTICS_SERVICE_URL || "http://partner-analytics-service:3000"
};

const partnerApiKeys = new Set(
  (process.env.PARTNER_API_KEYS || "partner-a-demo-key")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
);
const allowedDeviceCerts = new Set(
  (process.env.DEVICE_CERT_ALLOWLIST || "device-cert-taskd-001")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
);

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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

function requireUserJwt(req, res, next) {
  const token = getBearerToken(req);
  const claims = verifyToken(token);

  if (!claims || claims.type !== "user") {
    return errorResponse(res, 401, "INVALID_USER_TOKEN", "A valid user JWT is required");
  }

  req.user = claims;
  return next();
}

function requirePartnerApiKey(req, res, next) {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || !partnerApiKeys.has(apiKey)) {
    return errorResponse(res, 401, "INVALID_PARTNER_KEY", "A valid partner API key is required");
  }

  req.partnerKey = apiKey;
  return next();
}

function buildServiceToken(aud, actor, scopes = []) {
  return signToken({
    type: "service",
    iss: SERVICE_NAME,
    aud,
    scopes,
    actor: actor || null,
    exp: Math.floor(Date.now() / 1000) + 300
  });
}

function canAccessUserResource(authenticatedUser, targetUserId) {
  if (authenticatedUser.role === "maintainer") {
    return true;
  }
  return authenticatedUser.sub === targetUserId;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidUserId(value) {
  return typeof value === "string" && /^[um]-[A-Za-z0-9._:-]+$/.test(value);
}

function isValidRideId(value) {
  return typeof value === "string" && /^ride-[A-Za-z0-9._:-]+$/.test(value);
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

function isValidDateString(value) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
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

function buildUserActor(user) {
  return { userId: user.sub, role: user.role };
}

function buildIdempotencyKey(req, prefix) {
  const headerKey = req.headers["x-idempotency-key"];
  if (typeof headerKey === "string" && headerKey) {
    return headerKey;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function parseServiceResponsePayload(rawPayload) {
  if (!rawPayload) {
    return null;
  }

  try {
    return JSON.parse(rawPayload);
  } catch (_err) {
    return { raw: rawPayload };
  }
}

async function callInternalService({
  url,
  method,
  body,
  audience,
  actor,
  scopes,
  extraHeaders = {}
}) {
  const headers = {
    authorization: `Bearer ${buildServiceToken(audience, actor, scopes)}`,
    "x-internal-mtls": "true",
    ...extraHeaders
  };

  const requestOptions = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    requestOptions.body = JSON.stringify(body);
  }

  const response = await fetch(url, requestOptions);
  const rawPayload = await response.text();

  return {
    status: response.status,
    payload: parseServiceResponsePayload(rawPayload)
  };
}

function relay(res, result) {
  if (result.payload === null) {
    return res.status(result.status).end();
  }
  return res.status(result.status).json(result.payload);
}

async function proxyServiceRequest(res, request, unavailableMessage) {
  try {
    const result = await callInternalService(request);
    return relay(res, result);
  } catch (err) {
    return errorResponse(res, 502, "UPSTREAM_FAILURE", unavailableMessage, err.message);
  }
}

app.get("/status", (_req, res) => {
  res.json({
    status: "ok",
    service: SERVICE_NAME,
    timestamp: new Date().toISOString()
  });
});

app.post("/api/v1/auth/login", async (req, res) => {
  const payload = req.body;
  if (!ensureObjectPayload(res, payload, "INVALID_LOGIN_PAYLOAD", "Login payload must be an object")) {
    return;
  }

  const { email, password } = payload;
  if (!isNonEmptyString(email) || !isNonEmptyString(password)) {
    return errorResponse(res, 400, "INVALID_LOGIN_PAYLOAD", "email and password are required");
  }

  try {
    const result = await callInternalService({
      url: `${serviceUrls.user}/internal/auth/login`,
      method: "POST",
      body: { email, password },
      audience: "user-service",
      scopes: ["auth:login"]
    });

    if (result.status !== 200) {
      return relay(res, result);
    }

    const user = result.payload.user;
    const accessToken = signToken({
      type: "user",
      sub: user.id,
      role: user.role,
      exp: Math.floor(Date.now() / 1000) + 3600
    });

    return res.json({
      accessToken,
      tokenType: "Bearer",
      expiresIn: 3600,
      user
    });
  } catch (err) {
    return errorResponse(res, 502, "UPSTREAM_FAILURE", "User service is unavailable", err.message);
  }
});

app.get("/api/v1/users/:userId/profile", requireUserJwt, async (req, res) => {
  const { userId } = req.params;
  if (!isValidUserId(userId)) {
    return errorResponse(res, 400, "INVALID_PATH", "userId must match expected ID format");
  }
  if (!ensureNoQueryParams(req, res)) {
    return;
  }
  if (!canAccessUserResource(req.user, userId)) {
    return errorResponse(res, 403, "ACCESS_DENIED", "You cannot access this user profile");
  }

  return proxyServiceRequest(
    res,
    {
      url: `${serviceUrls.user}/internal/users/${userId}/profile`,
      method: "GET",
      audience: "user-service",
      actor: buildUserActor(req.user),
      scopes: ["profile:read"]
    },
    "User service is unavailable"
  );
});

app.patch("/api/v1/users/:userId/profile", requireUserJwt, async (req, res) => {
  const { userId } = req.params;
  if (!isValidUserId(userId)) {
    return errorResponse(res, 400, "INVALID_PATH", "userId must match expected ID format");
  }
  if (!ensureNoQueryParams(req, res)) {
    return;
  }
  if (!canAccessUserResource(req.user, userId)) {
    return errorResponse(res, 403, "ACCESS_DENIED", "You cannot update this user profile");
  }

  const payload = req.body;
  if (!ensureObjectPayload(res, payload, "INVALID_PAYLOAD", "Profile patch payload must be an object")) {
    return;
  }

  return proxyServiceRequest(
    res,
    {
      url: `${serviceUrls.user}/internal/users/${userId}/profile`,
      method: "PATCH",
      body: payload,
      audience: "user-service",
      actor: buildUserActor(req.user),
      scopes: ["profile:write"]
    },
    "User service is unavailable"
  );
});

app.get("/api/v1/users/:userId/dashboard", requireUserJwt, async (req, res) => {
  const { userId } = req.params;
  if (!isValidUserId(userId)) {
    return errorResponse(res, 400, "INVALID_PATH", "userId must match expected ID format");
  }
  if (!ensureNoQueryParams(req, res)) {
    return;
  }
  if (!canAccessUserResource(req.user, userId)) {
    return errorResponse(res, 403, "ACCESS_DENIED", "You cannot access this dashboard");
  }

  return proxyServiceRequest(
    res,
    {
      url: `${serviceUrls.user}/internal/users/${userId}/dashboard`,
      method: "GET",
      audience: "user-service",
      actor: buildUserActor(req.user),
      scopes: ["dashboard:read"]
    },
    "User service is unavailable"
  );
});

app.get("/api/v1/users/:userId/rides", requireUserJwt, async (req, res) => {
  const { userId } = req.params;
  if (!isValidUserId(userId)) {
    return errorResponse(res, 400, "INVALID_PATH", "userId must match expected ID format");
  }
  if (!canAccessUserResource(req.user, userId)) {
    return errorResponse(res, 403, "ACCESS_DENIED", "You cannot access this user's rides");
  }

  if (hasUnexpectedQueryParams(req, ["limit"])) {
    return errorResponse(res, 400, "INVALID_QUERY", "Only limit query parameter is supported");
  }

  const search = new URLSearchParams();
  if (req.query.limit !== undefined) {
    const parsedLimit = Number(req.query.limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 20) {
      return errorResponse(res, 400, "INVALID_QUERY", "limit must be an integer between 1 and 20");
    }
    search.set("limit", String(parsedLimit));
  }

  return proxyServiceRequest(
    res,
    {
      url: `${serviceUrls.ride}/internal/users/${userId}/rides${search.size ? `?${search.toString()}` : ""}`,
      method: "GET",
      audience: "ride-service",
      actor: buildUserActor(req.user),
      scopes: ["rides:read"]
    },
    "Ride service is unavailable"
  );
});

app.post("/api/v1/rides/start", requireUserJwt, async (req, res) => {
  if (req.user.role !== "user") {
    return errorResponse(res, 403, "ROLE_FORBIDDEN", "Only rider accounts can start rides");
  }

  const payload = req.body;
  if (!ensureObjectPayload(res, payload, "INVALID_PAYLOAD", "Ride start payload must be an object")) {
    return;
  }
  if (!ensurePayloadKeys(res, payload, ["bikeId"], "INVALID_PAYLOAD", "Only bikeId is allowed in ride start payload")) {
    return;
  }

  const { bikeId } = payload;
  if (!isValidBikeId(bikeId)) {
    return errorResponse(res, 400, "INVALID_PAYLOAD", "bikeId must match expected bike ID format");
  }

  const idempotencyKey = buildIdempotencyKey(req, "start");

  return proxyServiceRequest(
    res,
    {
      url: `${serviceUrls.ride}/internal/rides/start`,
      method: "POST",
      body: {
        userId: req.user.sub,
        bikeId,
        startedAt: new Date().toISOString()
      },
      audience: "ride-service",
      actor: buildUserActor(req.user),
      scopes: ["ride:start"],
      extraHeaders: {
        "Idempotency-Key": idempotencyKey
      }
    },
    "Ride service is unavailable"
  );
});

app.post("/api/v1/rides/:rideId/end", requireUserJwt, async (req, res) => {
  if (req.user.role !== "user") {
    return errorResponse(res, 403, "ROLE_FORBIDDEN", "Only rider accounts can end rides");
  }
  if (!isValidRideId(req.params.rideId)) {
    return errorResponse(res, 400, "INVALID_PATH", "rideId must match expected ID format");
  }

  const idempotencyKey = buildIdempotencyKey(req, "end");

  const payload = req.body;
  if (!ensureObjectPayload(res, payload, "INVALID_PAYLOAD", "Ride end payload must be a JSON object")) {
    return;
  }

  const effectivePayload = payload;
  if (
    !ensurePayloadKeys(res, effectivePayload, ["dockId"], "INVALID_PAYLOAD", "Only dockId is allowed in ride end payload")
  ) {
    return;
  }
  if (
    Object.prototype.hasOwnProperty.call(effectivePayload, "dockId") &&
    effectivePayload.dockId !== null &&
    !isValidDockId(effectivePayload.dockId)
  ) {
    return errorResponse(res, 400, "INVALID_PAYLOAD", "dockId must match expected dock ID format or be null");
  }

  return proxyServiceRequest(
    res,
    {
      url: `${serviceUrls.ride}/internal/rides/${req.params.rideId}/end`,
      method: "POST",
      body: {
        endedAt: new Date().toISOString(),
        dockId: effectivePayload.dockId
      },
      audience: "ride-service",
      actor: buildUserActor(req.user),
      scopes: ["ride:end"],
      extraHeaders: {
        "Idempotency-Key": idempotencyKey
      }
    },
    "Ride service is unavailable"
  );
});

app.post("/api/v1/admin/bikes/:bikeId/override-lock", requireUserJwt, async (req, res) => {
  if (req.user.role !== "maintainer") {
    return errorResponse(res, 403, "ROLE_FORBIDDEN", "Maintainer role required");
  }
  if (!isValidBikeId(req.params.bikeId)) {
    return errorResponse(res, 400, "INVALID_PATH", "bikeId must match expected bike ID format");
  }

  const payload = req.body;
  if (!ensureObjectPayload(res, payload, "INVALID_PAYLOAD", "Override payload must be an object")) {
    return;
  }

  if (!["locked", "unlocked"].includes(payload.lockState)) {
    return errorResponse(res, 400, "INVALID_PAYLOAD", "lockState must be locked or unlocked");
  }

  return proxyServiceRequest(
    res,
    {
      url: `${serviceUrls.inventory}/internal/admin/bikes/${req.params.bikeId}/override-lock`,
      method: "POST",
      body: { lockState: payload.lockState },
      audience: "bike-inventory-service",
      actor: buildUserActor(req.user),
      scopes: ["fleet:admin"]
    },
    "Bike inventory service is unavailable"
  );
});

app.post("/api/v1/device/events", async (req, res) => {
  const deviceCert = req.headers["x-device-cert"];
  if (!isAllowedDeviceCert(deviceCert)) {
    return errorResponse(res, 401, "DEVICE_CERT_REQUIRED", "A valid x-device-cert header is required");
  }

  const payload = req.body;
  if (!ensureObjectPayload(res, payload, "INVALID_PAYLOAD", "Device event payload must be an object")) {
    return;
  }
  if (
    !ensurePayloadKeys(
      res,
      payload,
      ["bikeId", "eventType", "nonce", "timestamp", "dockId"],
      "INVALID_PAYLOAD",
      "Only bikeId, eventType, nonce, timestamp and dockId are allowed"
    )
  ) {
    return;
  }

  const { bikeId, eventType, nonce, timestamp, dockId } = payload;
  if (!isValidBikeId(bikeId) || !["telemetry", "lock", "unlock"].includes(eventType) || !isValidNonce(nonce)) {
    return errorResponse(
      res,
      400,
      "INVALID_PAYLOAD",
      "bikeId, eventType, and nonce are required in valid formats"
    );
  }
  if (!isValidDateTimeString(timestamp)) {
    return errorResponse(res, 400, "INVALID_PAYLOAD", "timestamp must be an RFC3339 date-time string");
  }
  if (dockId !== undefined && dockId !== null && !isValidDockId(dockId)) {
    return errorResponse(res, 400, "INVALID_PAYLOAD", "dockId must match expected dock ID format or be null");
  }

  return proxyServiceRequest(
    res,
    {
      url: `${serviceUrls.inventory}/internal/device-events`,
      method: "POST",
      body: payload,
      audience: "bike-inventory-service",
      actor: { deviceCert },
      scopes: ["device:telemetry"],
      extraHeaders: {
        "x-device-cert": deviceCert
      }
    },
    "Bike inventory service is unavailable"
  );
});

app.get("/api/v1/partner/reports/daily-usage", requirePartnerApiKey, async (req, res) => {
  if (hasUnexpectedQueryParams(req, ["date"])) {
    return errorResponse(res, 400, "INVALID_QUERY", "Only date query parameter is supported");
  }

  const search = new URLSearchParams();
  if (req.query.date !== undefined) {
    if (!isValidDateString(req.query.date)) {
      return errorResponse(res, 400, "INVALID_DATE", "date must be a valid YYYY-MM-DD value");
    }
    search.set("date", req.query.date);
  }

  return proxyServiceRequest(
    res,
    {
      url: `${serviceUrls.partnerAnalytics}/internal/reports/daily-usage${
        search.size ? `?${search.toString()}` : ""
      }`,
      method: "GET",
      audience: "partner-analytics-service",
      actor: { partnerKeyHash: crypto.createHash("sha256").update(req.partnerKey).digest("hex") },
      scopes: ["analytics:read"]
    },
    "Partner analytics service is unavailable"
  );
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
const keyPath = process.env.TLS_KEY_PATH || "/app/certs/key.pem";
const certPath = process.env.TLS_CERT_PATH || "/app/certs/cert.pem";

const server = https.createServer(
  {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath)
  },
  app
);

server.listen(PORT, () => {
  console.log(`${SERVICE_NAME} HTTPS listening on ${PORT}`);
});
