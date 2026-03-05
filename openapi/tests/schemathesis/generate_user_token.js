#!/usr/bin/env node
const crypto = require("crypto");

const userId = process.argv[2] || "u-100";
const role = process.argv[3] || "user";
const tokenSecret = process.env.SERVICE_TOKEN_SECRET || "citybike-shared-secret";

const payload = {
  type: "user",
  sub: userId,
  role,
  exp: Math.floor(Date.now() / 1000) + 300
};

const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
const signature = crypto
  .createHmac("sha256", tokenSecret)
  .update(encodedPayload)
  .digest("base64url");

process.stdout.write(`${encodedPayload}.${signature}`);
