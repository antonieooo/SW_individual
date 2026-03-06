const crypto = require("crypto");
const express = require("express");

const app = express();
app.use(express.json());

const SERVICE_NAME = "partner-analytics-service";
const TOKEN_SECRET = process.env.SERVICE_TOKEN_SECRET || "citybike-shared-secret";

const serviceUrls = {
  database: process.env.DATABASE_CLUSTER_URL || "http://database-cluster-service:3000"
};

const dbCredential = process.env.DB_CRED_ANALYTICS || "db-analytics-secret";

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

const loadDailyReport = (date) =>
  callInternalService({
    url: `${serviceUrls.database}/internal/db/analytics/daily-usage?date=${date}`,
    method: "GET",
    audience: "database-cluster-service",
    scopes: ["db:analytics:read"],
    headers: { "x-db-credential": dbCredential }
  });

const refreshDailyReport = (date) =>
  callInternalService({
    url: `${serviceUrls.database}/internal/db/analytics/refresh`,
    method: "POST",
    body: { date },
    audience: "database-cluster-service",
    scopes: ["db:analytics:refresh"],
    headers: { "x-db-credential": dbCredential }
  });

function isValidDateString(value) {
  if (typeof value !== "string") {
    return false;
  }
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!datePattern.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

app.get("/status", (_req, res) => {
  res.json({
    status: "ok",
    service: SERVICE_NAME,
    timestamp: new Date().toISOString()
  });
});

app.get("/internal/reports/daily-usage", requireInternalAuth, async (req, res) => {
  const rawDate = req.query.date;
  const date = rawDate === undefined ? new Date().toISOString().slice(0, 10) : rawDate;

  if (!isValidDateString(date)) {
    return errorResponse(res, 400, "INVALID_DATE", "date must be a valid YYYY-MM-DD value");
  }

  try {
    let result = await loadDailyReport(date);
    if (result.status === 404) {
      const refreshResult = await refreshDailyReport(date);
      if (refreshResult.status !== 200) {
        return errorResponse(
          res,
          502,
          "ANALYTICS_REFRESH_FAILED",
          "Could not refresh analytics report",
          refreshResult.payload
        );
      }
      result = await loadDailyReport(date);
    }

    if (result.status !== 200) {
      return errorResponse(res, result.status, "REPORT_NOT_AVAILABLE", "Could not load report", result.payload);
    }

    return res.json(result.payload);
  } catch (err) {
    return errorResponse(res, 502, "ANALYTICS_QUERY_FAILED", "Could not fetch daily report", err.message);
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
