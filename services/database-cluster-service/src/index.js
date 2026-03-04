const crypto = require("crypto");
const express = require("express");

const app = express();
app.use(express.json());

const SERVICE_NAME = "database-cluster-service";
const TOKEN_SECRET = process.env.SERVICE_TOKEN_SECRET || "citybike-shared-secret";

const schemaCredentials = {
  user: process.env.DB_CRED_USER || "db-user-secret",
  ride: process.env.DB_CRED_RIDE || "db-ride-secret",
  inventory: process.env.DB_CRED_INVENTORY || "db-inventory-secret",
  payment: process.env.DB_CRED_PAYMENT || "db-payment-secret",
  analytics: process.env.DB_CRED_ANALYTICS || "db-analytics-secret"
};

const allowedSchemas = {
  "user-service": ["user"],
  "ride-service": ["ride"],
  "bike-inventory-service": ["inventory"],
  "payment-service": ["payment"],
  "partner-analytics-service": ["analytics"],
  [SERVICE_NAME]: ["user", "ride", "inventory", "payment", "analytics"]
};

const schemas = {
  user: {
    users: new Map([
      [
        "u-100",
        {
          id: "u-100",
          email: "alice@citybike.example",
          password: "alice123",
          role: "user",
          name: "Alice Rider",
          phone: "+44-000-100",
          paymentBindingId: "paybind-u-100"
        }
      ],
      [
        "u-101",
        {
          id: "u-101",
          email: "bob@citybike.example",
          password: "bob12345",
          role: "user",
          name: "Bob Commuter",
          phone: "+44-000-101",
          paymentBindingId: "paybind-u-101"
        }
      ],
      [
        "m-001",
        {
          id: "m-001",
          email: "maint@citybike.example",
          password: "maint123",
          role: "maintainer",
          name: "Mina Maintainer",
          phone: "+44-000-001",
          paymentBindingId: "paybind-m-001"
        }
      ]
    ])
  },
  ride: {
    rides: new Map(),
    idempotency: new Map()
  },
  inventory: {
    bikes: new Map([
      [
        "bike-001",
        {
          bikeId: "bike-001",
          availability: "available",
          lockState: "locked",
          dockId: "dock-a1",
          lastUpdated: new Date().toISOString()
        }
      ],
      [
        "bike-002",
        {
          bikeId: "bike-002",
          availability: "available",
          lockState: "locked",
          dockId: "dock-a2",
          lastUpdated: new Date().toISOString()
        }
      ],
      [
        "bike-003",
        {
          bikeId: "bike-003",
          availability: "available",
          lockState: "locked",
          dockId: "dock-b1",
          lastUpdated: new Date().toISOString()
        }
      ]
    ]),
    usedNonces: new Map()
  },
  payment: {
    payments: new Map(),
    idempotency: new Map()
  },
  analytics: {
    dailyReports: new Map()
  }
};

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
  } catch (err) {
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

function requireInternalAuth(req, res, next) {
  if (req.headers["x-internal-mtls"] !== "true") {
    return errorResponse(res, 401, "MTLS_REQUIRED", "x-internal-mtls=true is required");
  }

  const token = getBearerToken(req);
  const claims = verifyToken(token);
  if (!claims || claims.type !== "service" || !claims.iss) {
    return errorResponse(res, 401, "INVALID_SERVICE_TOKEN", "Valid internal service token is required");
  }

  req.auth = claims;
  return next();
}

function ensureSchemaAccess(req, res, next) {
  const { schema } = req.params;
  const caller = req.auth.iss;
  const allowed = allowedSchemas[caller] || [];
  if (!allowed.includes(schema)) {
    return errorResponse(res, 403, "SCHEMA_ACCESS_DENIED", `Service ${caller} cannot access ${schema} schema`);
  }

  const expectedCredential = schemaCredentials[schema];
  const receivedCredential = req.headers["x-db-credential"];
  if (receivedCredential !== expectedCredential) {
    return errorResponse(res, 403, "DB_CREDENTIAL_INVALID", `Invalid DB credential for schema ${schema}`);
  }

  return next();
}

function getCollection(schema, collection) {
  const schemaStore = schemas[schema];
  if (!schemaStore) {
    return null;
  }

  if (!schemaStore[collection]) {
    schemaStore[collection] = new Map();
  }

  return schemaStore[collection];
}

function asDateOnly(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function refreshDailyAnalytics(date) {
  const targetDate = date || new Date().toISOString().slice(0, 10);
  const rides = Array.from(schemas.ride.rides.values()).filter((ride) => {
    return ride.startedAt && asDateOnly(ride.startedAt) === targetDate;
  });

  const uniqueUsers = new Set(rides.map((ride) => ride.userId)).size;
  const activeBikes = Array.from(schemas.inventory.bikes.values()).filter((bike) => {
    return bike.availability !== "unavailable";
  }).length;

  const minimumAggregationThreshold = 10;
  const suppressed = rides.length < minimumAggregationThreshold;

  const report = {
    date: targetDate,
    totalRides: suppressed ? 0 : rides.length,
    uniqueUsers: suppressed ? 0 : uniqueUsers,
    activeBikes: suppressed ? 0 : activeBikes,
    minimumAggregationThreshold,
    suppressed,
    generatedAt: new Date().toISOString()
  };

  schemas.analytics.dailyReports.set(targetDate, report);
  return report;
}

app.get("/status", (_req, res) => {
  res.json({
    status: "ok",
    service: SERVICE_NAME,
    timestamp: new Date().toISOString()
  });
});

app.post("/internal/db/:schema/:collection/get", requireInternalAuth, ensureSchemaAccess, (req, res) => {
  const { schema, collection } = req.params;
  const { id } = req.body || {};

  if (!id) {
    return errorResponse(res, 400, "ID_REQUIRED", "id is required");
  }

  const store = getCollection(schema, collection);
  if (!store) {
    return errorResponse(res, 404, "COLLECTION_NOT_FOUND", `Collection ${collection} does not exist`);
  }

  const item = store.get(id);
  if (!item) {
    return errorResponse(res, 404, "ITEM_NOT_FOUND", `No record found for id ${id}`);
  }

  return res.json({ item });
});

app.post("/internal/db/:schema/:collection/list", requireInternalAuth, ensureSchemaAccess, (req, res) => {
  const { schema, collection } = req.params;
  const { field, value, limit = 100 } = req.body || {};

  const store = getCollection(schema, collection);
  if (!store) {
    return errorResponse(res, 404, "COLLECTION_NOT_FOUND", `Collection ${collection} does not exist`);
  }

  let items = Array.from(store.values());
  if (field) {
    items = items.filter((entry) => entry[field] === value);
  }

  return res.json({ items: items.slice(0, Number(limit) || 100) });
});

app.post("/internal/db/:schema/:collection/upsert", requireInternalAuth, ensureSchemaAccess, (req, res) => {
  const { schema, collection } = req.params;
  const { id, document } = req.body || {};

  if (!id || !document || typeof document !== "object") {
    return errorResponse(res, 400, "INVALID_UPSERT", "id and document are required");
  }

  const store = getCollection(schema, collection);
  if (!store) {
    return errorResponse(res, 404, "COLLECTION_NOT_FOUND", `Collection ${collection} does not exist`);
  }

  store.set(id, { ...document });
  return res.status(201).json({ item: store.get(id) });
});

app.post("/internal/db/analytics/refresh", requireInternalAuth, (req, res) => {
  const caller = req.auth.iss;
  if (!["partner-analytics-service", SERVICE_NAME].includes(caller)) {
    return errorResponse(res, 403, "ANALYTICS_REFRESH_FORBIDDEN", "Only analytics service can refresh reports");
  }

  if (req.headers["x-db-credential"] !== schemaCredentials.analytics) {
    return errorResponse(res, 403, "DB_CREDENTIAL_INVALID", "Invalid DB credential for schema analytics");
  }

  const date = req.body && req.body.date;
  const report = refreshDailyAnalytics(date);
  return res.json(report);
});

app.get("/internal/db/analytics/daily-usage", requireInternalAuth, (req, res) => {
  const caller = req.auth.iss;
  if (!["partner-analytics-service", SERVICE_NAME].includes(caller)) {
    return errorResponse(res, 403, "ANALYTICS_READ_FORBIDDEN", "Only analytics service can read reports");
  }

  if (req.headers["x-db-credential"] !== schemaCredentials.analytics) {
    return errorResponse(res, 403, "DB_CREDENTIAL_INVALID", "Invalid DB credential for schema analytics");
  }

  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const report = schemas.analytics.dailyReports.get(date);
  if (!report) {
    return errorResponse(res, 404, "REPORT_NOT_FOUND", `No report for date ${date}`);
  }

  return res.json(report);
});

function buildInternalToken() {
  return signToken({
    type: "service",
    iss: SERVICE_NAME,
    aud: SERVICE_NAME,
    exp: Math.floor(Date.now() / 1000) + 300
  });
}

async function selfRefresh() {
  try {
    const date = new Date().toISOString().slice(0, 10);
    const response = await fetch(`http://127.0.0.1:${PORT}/internal/db/analytics/refresh`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${buildInternalToken()}`,
        "x-internal-mtls": "true",
        "x-db-credential": schemaCredentials.analytics
      },
      body: JSON.stringify({ date })
    });

    if (!response.ok) {
      const payload = await response.text();
      console.error(`Analytics refresh failed: ${response.status} ${payload}`);
    }
  } catch (err) {
    console.error("Analytics refresh error", err.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`${SERVICE_NAME} listening on ${PORT}`);
  selfRefresh();
  setInterval(selfRefresh, 30000);
});
