// Test-only preload: redirect synthetic Resend requests to an explicit loopback fixture.
// Require this only through the email-flows-browser harness; no application bypass.
const Module = require("node:module");
const loopback = url => url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
const origin = new URL(process.env.NEXTAUTH_URL || "https://invalid.invalid");
const provider = new URL(process.env.ACCOUNT_EMAIL_FIXTURE_PROVIDER || "https://invalid.invalid");
const key = process.env.ACCOUNT_EMAIL_FIXTURE_KEY || "";
if (!loopback(origin) || !loopback(provider) || !/^resend-fixture-[0-9a-f-]{36}$/.test(key) || process.env.RESEND_API_KEY !== key || process.env.NODE_ENV !== "development") {
  throw new Error("Email provider hook requires a synthetic key and explicit development loopback origins");
}

// Next would otherwise read .env files even when most variables are overridden.
// This fixture uses only the environment explicitly supplied by its harness.
const originalLoad = Module._load;
const initialEnv = { ...process.env };
const explicitEnv = {
  initialEnv,
  updateInitialEnv: values => Object.assign(initialEnv, values),
  resetEnv: () => {},
  processEnv: () => [process.env, {}],
  loadEnvConfig: () => ({ combinedEnv: process.env, parsedEnv: {}, loadedEnvFiles: [] }),
};
Module._load = function (request, parent, isMain) {
  if (request === "@next/env" || request === "next/dist/compiled/@next/env") return explicitEnv;
  return originalLoad.call(this, request, parent, isMain);
};

const nativeFetch = globalThis.fetch;
globalThis.fetch = async function (input, options) {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.hostname !== "api.resend.com") return nativeFetch(input, options);
  if (url.href !== "https://api.resend.com/emails" || options?.method !== "POST") throw new Error("Unexpected provider operation in email fixture");
  const headers = new Headers(options.headers);
  if (headers.get("authorization") !== "Bearer " + key) throw new Error("Unexpected provider key in email fixture");
  const body = JSON.parse(options.body);
  if (!Array.isArray(body.to) || !body.to.length || body.to.some(address => !/^[^\s@]+@[^\s@]+\.invalid$/i.test(address)) ||
      !/@[^\s<>]+\.invalid>?$/.test(body.from) || (body.reply_to !== undefined && !/^[^\s@]+@[^\s@]+\.invalid$/i.test(body.reply_to))) throw new Error("Email fixture refuses real addresses");
  return nativeFetch(new URL("/emails", provider), options);
};
