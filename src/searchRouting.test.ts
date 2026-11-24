import assert from "node:assert/strict";
import { test } from "node:test";
import {
  browserSearchBlockedMessage,
  isBareSearchQuery,
  isLikelyProductPageUrl,
  isSearchEngineResultsUrl,
  isSearchEngineSiteUrl,
  shouldBlockBrowserNavigation,
  taskPrefersWebSearchFirst,
  searchQueryFromNavigateTarget
} from "./searchRouting";

test("bare shopping queries are not treated as page URLs", () => {
  assert.equal(isBareSearchQuery("hibiscus 4ft shipped to 95119"), true);
  assert.equal(isBareSearchQuery("Trees.com 4-5 ft Pink Dogwood shipping California 95119"), true);
  assert.equal(isBareSearchQuery("https://trees.com/products/pink-dogwood"), false);
  assert.equal(isBareSearchQuery("trees.com/products/pink-dogwood"), false);
  assert.equal(isBareSearchQuery("about:blank"), false);
});

test("search-engine result URLs are detected", () => {
  assert.equal(isSearchEngineResultsUrl("https://www.google.com/search?q=hibiscus+95119"), true);
  assert.equal(isSearchEngineResultsUrl("https://www.bing.com/search?q=dogwood"), true);
  assert.equal(isSearchEngineResultsUrl("https://html.duckduckgo.com/html/?q=plants"), true);
  assert.equal(isSearchEngineResultsUrl("https://trees.com/products/pink-dogwood"), false);
  assert.equal(isSearchEngineResultsUrl("https://search.google.com/search-console"), false);
});

test("blocked-search guidance points at web_search with the query", () => {
  assert.match(browserSearchBlockedMessage("flower shrubs 4 to 5ft 95119"), /web_search/);
  assert.match(browserSearchBlockedMessage("flower shrubs 4 to 5ft 95119"), /95119/);
  assert.equal(searchQueryFromNavigateTarget("https://www.google.com/search?q=pink+dogwood+95119"), "pink dogwood 95119");
  assert.equal(searchQueryFromNavigateTarget("4-5 ft flowering shrubs ship to 95119"), "4-5 ft flowering shrubs ship to 95119");
});

test("search engine homepages and non-product navigations are blocked for plant asks", () => {
  const task = "Continue the conversation. User request: find flower shrubs 4 to 5ft shipped to 95119";
  assert.equal(isSearchEngineSiteUrl("https://www.google.com/"), true);
  assert.equal(isSearchEngineResultsUrl("https://www.google.com/search?q=shrubs"), true);
  assert.equal(taskPrefersWebSearchFirst(task), true);
  assert.equal(isLikelyProductPageUrl("https://plantologyusa.com/products/hibiscus-standard-1"), true);
  assert.match(shouldBlockBrowserNavigation(task, "https://www.google.com/search?q=shrubs") || "", /web_search/);
  assert.match(shouldBlockBrowserNavigation(task, "https://www.trees.com/") || "", /web_search/);
  assert.equal(shouldBlockBrowserNavigation(task, "https://plantologyusa.com/products/hibiscus-standard-1"), null);
});
