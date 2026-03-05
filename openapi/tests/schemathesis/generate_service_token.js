#!/usr/bin/env node
const crypto = require("crypto");

const aud = process.argv[2];
const iss = process.argv[3] || "api-gateway-service";
const ttlSeconds = Number(process.argv[4] || 300);
const secret = process.env.SERVICE_TOKEN_SECRET || "citybike-shared-secret";

if (!aud) {
  console.error("Usage: node generate_service_token.js <aud> [iss] [ttlSeconds]");
  process.exit(1);
}

const payload = {
  type: "service",
  iss,
  aud,
  exp: Math.floor(Date.now() / 1000) + ttlSeconds
};

const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
const signature = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");

process.stdout.write(`${encoded}.${signature}`);
