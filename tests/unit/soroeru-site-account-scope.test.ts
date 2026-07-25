import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveSiteAccountOrigin,
  deriveLedgerAllowedOrigins,
  isSameSiteDomainScope,
  isUrlInLedgerScope,
  normalizeScopeDomain,
} from "../../src/domain/site-account-scope.js";

test("normalizeScopeDomain normalizes hostnames, stripping www and lowercase", () => {
  assert.equal(normalizeScopeDomain("example.com"), "example.com");
  assert.equal(normalizeScopeDomain("WWW.Example.COM"), "example.com");
  assert.equal(normalizeScopeDomain(" sub.domain.org "), "sub.domain.org");
  assert.equal(normalizeScopeDomain("invalid/path"), undefined);
  assert.equal(normalizeScopeDomain("invalid:8080"), undefined);
});

test("deriveSiteAccountOrigin derives HTTPS origin from site account url or domain", () => {
  assert.equal(deriveSiteAccountOrigin({ domain: "example.com" }), "https://example.com");
  assert.equal(deriveSiteAccountOrigin({ domain: "www.example.com" }), "https://example.com");
  assert.equal(
    deriveSiteAccountOrigin({ domain: "example.com", url: "https://sub.example.com/login" }),
    "https://sub.example.com",
  );
  assert.equal(deriveSiteAccountOrigin({ domain: "android://app.package" }), undefined);
});

test("deriveLedgerAllowedOrigins returns deduplicated and sorted HTTPS origins from site accounts", () => {
  const sites = [
    { domain: "b.example.com" },
    { domain: "a.example.com" },
    { domain: "www.b.example.com" },
    { domain: "android://invalid" },
  ];
  assert.deepEqual(deriveLedgerAllowedOrigins(sites), [
    "https://a.example.com",
    "https://b.example.com",
  ]);
});

test("isSameSiteDomainScope verifies target URL falls within site domain or subdomain scope", () => {
  assert.equal(isSameSiteDomainScope("https://example.com/login", "example.com"), true);
  assert.equal(isSameSiteDomainScope("https://account.example.com/dashboard", "example.com"), true);
  assert.equal(isSameSiteDomainScope("https://www.example.com/", "example.com"), true);
  assert.equal(isSameSiteDomainScope("https://other-site.com/", "example.com"), false);
  assert.equal(isSameSiteDomainScope("http://example.com/", "example.com"), false); // HTTP fail-closed
});

test("isUrlInLedgerScope checks if target URL is within any site account in the ledger", () => {
  const ledger = [
    { domain: "example.com" },
    { domain: "service.org", url: "https://auth.service.org/login" },
  ];
  assert.equal(isUrlInLedgerScope("https://example.com/settings", ledger), true);
  assert.equal(isUrlInLedgerScope("https://auth.service.org/login", ledger), true);
  assert.equal(isUrlInLedgerScope("https://unauthorized-domain.com", ledger), false);
});
