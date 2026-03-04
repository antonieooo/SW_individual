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

app.get("/status", (_req, res) => {
  res.json({
    status: "ok",
    service: SERVICE_NAME,
    timestamp: new Date().toISOString()
  });
});

app.post("/internal/payments/charge", requireInternalAuth, async (req, res) => {
  const { userId, rideId, amount, currency, paymentBindingId, idempotencyKey } = req.body || {};

  if (!userId || !rideId || amount === undefined || !currency || !paymentBindingId || !idempotencyKey) {
    return errorResponse(
      res,
      400,
      "INVALID_CHARGE_PAYLOAD",
      "userId, rideId, amount, currency, paymentBindingId, idempotencyKey are required"
    );
  }

  const numericAmount = Number(amount);
  if (Number.isNaN(numericAmount) || numericAmount < 0) {
    return errorResponse(res, 400, "INVALID_AMOUNT", "amount must be a positive number");
  }

  try {
    const existingIdempotency = await dbGet("idempotency", idempotencyKey);
    if (existingIdempotency && existingIdempotency.paymentId) {
      const existingPayment = await dbGet("payments", existingIdempotency.paymentId);
      if (existingPayment) {
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
  try {
    const payment = await dbGet("payments", req.params.paymentId);
    if (!payment) {
      return errorResponse(res, 404, "PAYMENT_NOT_FOUND", `Payment ${req.params.paymentId} not found`);
    }

    return res.json(sanitizePayment(payment));
  } catch (err) {
    return errorResponse(res, 502, "PAYMENT_QUERY_FAILED", "Could not query payment", err.message);
  }
});

app.get("/internal/users/:userId/billing-summary", requireInternalAuth, async (req, res) => {
  const { userId } = req.params;
  const actor = req.auth.actor;

  if (actor && actor.userId && actor.role !== "maintainer" && actor.userId !== userId) {
    return errorResponse(res, 403, "ACCESS_DENIED", "Cannot access billing summary for this user");
  }

  try {
    const payments = await dbList("payments", "userId", userId, 500);

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`${SERVICE_NAME} listening on ${PORT}`);
});
