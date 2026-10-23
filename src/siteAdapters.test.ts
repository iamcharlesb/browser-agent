import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { googlePropertyGuide } from "./siteAdapters";
import {
  accessDeniedRecoveryHint,
  chromeCdpLaunchCommand,
  sitePrefersConnectedChrome
} from "./browserController";

describe("site adapters and trust helpers", () => {
  it("marks Reddit and Google as Connected-Chrome preferred", () => {
    assert.equal(sitePrefersConnectedChrome("https://www.reddit.com/r/programming"), true);
    assert.equal(sitePrefersConnectedChrome("https://accounts.google.com/"), true);
    assert.equal(sitePrefersConnectedChrome("https://example.com/"), false);
  });

  it("hints CDP switch when not already connected", () => {
    const hint = accessDeniedRecoveryHint("persistent", "https://www.reddit.com/");
    assert.match(hint, /Connected Chrome/);
    assert.match(hint, /reddit_search/);
  });

  it("hints Connected Chrome when the in-app browser is blocked", () => {
    const hint = accessDeniedRecoveryHint("embedded", "https://accounts.google.com/");
    assert.match(hint, /in-app browser/i);
    assert.match(hint, /Connect my Chrome/);
  });

  it("builds a chrome CDP launch command", () => {
    const launch = chromeCdpLaunchCommand("http://127.0.0.1:9222", "/tmp/buddy-bot-chrome-cdp");
    assert.equal(launch.port, 9222);
    assert.match(launch.command, /remote-debugging-port=9222/);
    assert.match(launch.command, /buddy-bot-chrome-cdp/);
  });

  it("returns google property deep links", () => {
    const guide = googlePropertyGuide("search_console");
    assert.match(guide, /Search Console/);
    assert.match(guide, /search\.google\.com\/search-console/);
    assert.match(guide, /Connect my Chrome/);
  });
});
