import assert from "node:assert/strict";
import { test } from "node:test";
import { extractProductUrls, looksLikeShoppingSummary, fetchOpenGraphImage } from "./shoppingReply";

test("shopping summary detection and product URL extraction", () => {
  assert.equal(looksLikeShoppingSummary("Hibiscus Large 4–5 ft, $194.95, ships to 95119"), true);
  assert.equal(looksLikeShoppingSummary("Oracle Q1 earnings revenue grew 12% with a $210 stock price target."), false);
  const text =
    "Best match: [Hibiscus Standard](https://plantologyusa.com/products/hibiscus-standard-1) in stock.";
  assert.deepEqual(extractProductUrls(text), ["https://plantologyusa.com/products/hibiscus-standard-1"]);
  assert.equal(extractProductUrls("See https://www.google.com/search?q=plants").length, 0);
  assert.equal(
    extractProductUrls("Source: https://investor.oracle.com/investor-news/news-details/2026/Oracle-Announces-Q1/default.aspx").length,
    0
  );
});

test("thumbnail enrichment cannot fetch local services or mapped private IPv6", async () => {
  assert.equal(await fetchOpenGraphImage("http://127.0.0.1:8766/api/settings"), null);
  assert.equal(await fetchOpenGraphImage("http://[::ffff:7f00:1]/"), null);
});
