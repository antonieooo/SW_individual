const crypto = require("crypto");
const express = require("express");

const app = express();
app.use(express.json());

const SERVICE_NAME = "payment-service";
const TOKEN_SECRET = process.env.SERVICE_TOKEN_SECRET || "citybike-shared-secret";

const serviceUrls = {
  database: process.env.DATABASE_CLUSTER_URL || "http://database-cluster-service:3000"
};

const dbCredential = process.env.DB_CRED_PAYMENT || "db-payment-secret";

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
    url: `${serviceUrls.database}/internal/db/payment/${collection}/get`,
    method: "POST",
    body: { id },
    audience: "database-cluster-service",
    scopes: ["db:payment:read"],
    headers: {
      "x-db-credential": dbCredential
    }
  });

  return result.status === 200 ? result.payload.item : null;
}

async function dbList(collection, field, value, limit) {
  const result = await callInternalService({
    url: `${serviceUrls.database}/internal/db/payment/${collection}/list`,
    method: "POST",
    body: { field, value, limit },
    audience: "database-cluster-service",
    scopes: ["db:payment:read"],
    headers: {
      "x-db-credential": dbCredential
    }
  });

  return result.status === 200 ? result.payload.items || [] : [];
}

async function dbUpsert(collection, id, document) {
  const result = await callInternalService({
    url: `${serviceUrls.database}/internal/db/payment/${collection}/upsert`,
    method: "POST",
    body: { id, document },
    audience: "database-cluster-service",
    scopes: ["db:payment:write"],
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

function sanitizePayment(payment) {
  return {
    paymentId: payment.paymentId,
    userId: payment.userId,
    rideId: payment.rideId,
    amount: payment.amount,
    currency: payment.currency,
    status: payment.status,
    createdAt: payment.createdAt
  };
}

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

app.get("/status", (_req, res) => {
  res.json({
    status: "ok",
    service: SERVICE_NAME,
    timestamp: new Date().toISOString()
  });
});

app.post("/internal/payments/charge", requireInternalAuth, async (req, res) => {
  if (!ensureNoQueryParams(req, res)) {
    return;
  }
  const payload = req.body;
  if (!ensureObjectPayload(res, payload, "INVALID_CHARGE_PAYLOAD", "Charge payload must be an object")) {
    return;
  }
  if (
    !ensurePayloadKeys(
      res,
      payload,
      ["userId", "rideId", "amount", "currency", "paymentBindingId"],
      "INVALID_CHARGE_PAYLOAD",
      "Only userId, rideId, amount, currency and paymentBindingId are allowed"
    )
  ) {
    return;
  }

  const { userId, rideId, amount, currency, paymentBindingId } = payload;
  const idempotencyKey = resolveIdempotencyKey(req);

  if (!["ride-service", "payment-service"].includes(req.auth.iss)) {
    return errorResponse(res, 403, "ACCESS_DENIED", "Caller cannot create charges");
  }

  if (
    !isValidUserId(userId) ||
    !isValidRideId(rideId) ||
    amount === undefined ||
    !isIsoCurrency(currency) ||
    !isValidPaymentBindingId(paymentBindingId) ||
    !isValidIdempotencyKey(idempotencyKey)
  ) {
    return errorResponse(
      res,
      400,
      "INVALID_CHARGE_PAYLOAD",
      "userId, rideId, amount, currency, paymentBindingId, and Idempotency-Key header are required in valid formats"
    );
  }

  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
    return errorResponse(res, 400, "INVALID_AMOUNT", "amount must be a non-negative number");
  }
  const numericAmount = amount;

  try {
    const existingIdempotency = await dbGet("idempotency", idempotencyKey);
    if (existingIdempotency && existingIdempotency.paymentId) {
      const existingPayment = await dbGet("payments", existingIdempotency.paymentId);
      if (existingPayment) {
        const isSameRequest =
          existingPayment.userId === userId &&
          existingPayment.rideId === rideId &&
          Number(existingPayment.amount) === Number(numericAmount.toFixed(2)) &&
          existingPayment.currency === currency;
        if (!isSameRequest) {
          return errorResponse(
            res,
            409,
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key already maps to a different payment request"
          );
        }
        return res.status(200).json(sanitizePayment(existingPayment));
      }
    }

    const payment = {
      paymentId: `pay-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      userId,
      rideId,
      amount: Number(numericAmount.toFixed(2)),
      currency,
      status: "charged",
      paymentBindingId,
      createdAt: new Date().toISOString()
    };

    const persistedPayment = await dbUpsert("payments", payment.paymentId, payment);
    if (!persistedPayment) {
      return errorResponse(res, 502, "PAYMENT_PERSISTENCE_FAILED", "Could not persist payment");
    }

    await dbUpsert("idempotency", idempotencyKey, {
      idempotencyKey,
      paymentId: payment.paymentId,
      createdAt: payment.createdAt
    });

    return res.status(201).json(sanitizePayment(persistedPayment));
  } catch (err) {
    return errorResponse(res, 502, "PAYMENT_FAILED", "Could not create payment", err.message);
  }
});

app.get("/internal/payments/:paymentId", requireInternalAuth, async (req, res) => {
  if (!isValidPaymentId(req.params.paymentId)) {
    return errorResponse(res, 400, "INVALID_PATH", "paymentId must match expected ID format");
  }
  if (!ensureNoQueryParams(req, res)) {
    return;
  }
  try {
    const payment = await dbGet("payments", req.params.paymentId);
    if (!payment) {
      return errorResponse(res, 404, "PAYMENT_NOT_FOUND", `Payment ${req.params.paymentId} not found`);
    }

    const actor = req.auth.actor;
    if (actor && actor.userId && actor.role !== "maintainer" && actor.userId !== payment.userId) {
      return errorResponse(res, 403, "ACCESS_DENIED", "Cannot access this payment");
    }

    if (!["charged", "refunded"].includes(payment.status)) {
      return errorResponse(res, 409, "PAYMENT_STATE_CONFLICT", "Payment has an invalid state");
    }

    return res.json(sanitizePayment(payment));
  } catch (err) {
    return errorResponse(res, 502, "PAYMENT_QUERY_FAILED", "Could not query payment", err.message);
  }
});

app.get("/internal/users/:userId/billing-summary", requireInternalAuth, async (req, res) => {
  const { userId } = req.params;
  if (!isValidUserId(userId)) {
    return errorResponse(res, 400, "INVALID_PATH", "userId must match expected ID format");
  }
  if (!ensureNoQueryParams(req, res)) {
    return;
  }
  const actor = req.auth.actor;

  if (actor && actor.userId && actor.role !== "maintainer" && actor.userId !== userId) {
    return errorResponse(res, 403, "ACCESS_DENIED", "Cannot access billing summary for this user");
  }

  try {
    const payments = await dbList("payments", "userId", userId, 500);

    const hasInvalidPaymentRecord = payments.some((payment) => {
      return (
        !payment ||
        Number.isNaN(Number(payment.amount)) ||
        !["charged", "refunded"].includes(payment.status)
      );
    });
    if (hasInvalidPaymentRecord) {
      return errorResponse(res, 409, "BILLING_CONFLICT", "Billing records contain invalid entries");
    }

    const charged = payments.filter((payment) => payment.status === "charged");
    const totalCharged = charged.reduce((sum, payment) => sum + Number(payment.amount), 0);

    return res.json({
      userId,
      currency: "GBP",
      totalCharged: Number(totalCharged.toFixed(2)),
      paymentCount: charged.length
    });
  } catch (err) {
    return errorResponse(res, 502, "BILLING_QUERY_FAILED", "Could not read billing summary", err.message);
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

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`${SERVICE_NAME} listening on ${PORT}`);
  });
}

module.exports = {
  app,
  isValidUserId,
  isValidRideId,
  isValidPaymentBindingId,
  isValidPaymentId,
  isValidIdempotencyKey,
  isIsoCurrency
};
