import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureMarketplaceAddon,
  installMarketplaceAddon,
  isMarketplaceAddonEnabled,
  listMarketplaceAddons,
  toggleMarketplaceAddon,
  uninstallMarketplaceAddon
} from "./marketplace";
import { requiresPrivilegedApproval, toolNeededForRequest } from "./promptLoop";

test("marketplace catalog includes Microsoft Outlook and persists install, toggle, config, and uninstall without leaking secrets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pilo-marketplace-"));
  const stateFile = join(dir, ".browser-agent-marketplace.json");
  const envFile = join(dir, ".env");
  const env: NodeJS.ProcessEnv = {};

  try {
    const initial = listMarketplaceAddons({ stateFile, env });
    const outlook = initial.find((a) => a.id === "outlook");
    assert.ok(outlook, "outlook addon should be in catalog");
    assert.equal(outlook.installed, false);
    assert.equal(outlook.enabled, false);
    assert.equal(outlook.configured, false);
    assert.equal(isMarketplaceAddonEnabled("outlook", { stateFile }), false);

    const installed = installMarketplaceAddon("outlook", { stateFile, env });
    assert.equal(installed.installed, true);
    assert.equal(installed.enabled, true);
    assert.equal(isMarketplaceAddonEnabled("outlook", { stateFile }), true);

    const disabled = toggleMarketplaceAddon("outlook", false, { stateFile, env });
    assert.equal(disabled.installed, true);
    assert.equal(disabled.enabled, false);
    assert.equal(isMarketplaceAddonEnabled("outlook", { stateFile }), false);

    const reenabled = toggleMarketplaceAddon("outlook", true, { stateFile, env });
    assert.equal(reenabled.enabled, true);

    const fakeToken = "graph-demo-token-value-12345";
    const configured = await configureMarketplaceAddon(
      "outlook",
      { accessToken: fakeToken, tenantId: "consumers" },
      { stateFile, envFile, env }
    );
    assert.equal(configured.configured, true);
    assert.equal(configured.configuredFields.accessToken, true);
    assert.equal(configured.publicConfig.tenantId, "consumers");
    assert.equal(JSON.stringify(configured).includes(fakeToken), false, "secret token must never appear in status payload");
    const persistedEnv = readFileSync(envFile, "utf8");
    assert.match(persistedEnv, /OUTLOOK_ACCESS_TOKEN=/);
    assert.match(persistedEnv, /OUTLOOK_TENANT_ID="consumers"/);

    // Blank secret preserves existing token rather than erasing it.
    const preserved = await configureMarketplaceAddon(
      "outlook",
      { accessToken: "", tenantId: "common" },
      { stateFile, envFile, env }
    );
    assert.equal(preserved.configured, true);
    assert.equal(preserved.publicConfig.tenantId, "common");

    const uninstalled = uninstallMarketplaceAddon("outlook", { stateFile, env });
    assert.equal(uninstalled.installed, false);
    assert.equal(uninstalled.enabled, false);
    assert.equal(isMarketplaceAddonEnabled("outlook", { stateFile }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("outlook tool approval gates outward send/reply and topic pruning matches mail/calendar asks", () => {
  assert.equal(requiresPrivilegedApproval("outlook", { action: "send_email", to: "a@example.com" }), true);
  assert.equal(requiresPrivilegedApproval("outlook", { action: "reply_email", messageId: "m1" }), true);
  assert.equal(requiresPrivilegedApproval("outlook", { action: "list_messages" }), false);
  assert.equal(requiresPrivilegedApproval("outlook", { action: "search_messages", query: "invoice" }), false);
  assert.equal(requiresPrivilegedApproval("outlook", { action: "get_message", messageId: "m1" }), false);
  assert.equal(requiresPrivilegedApproval("outlook", { action: "create_draft", subject: "Hi" }), false);
  assert.equal(requiresPrivilegedApproval("outlook", { action: "list_events" }), false);
  assert.equal(requiresPrivilegedApproval("outlook", { action: "status" }), false);

  assert.equal(toolNeededForRequest("outlook", "Check my Outlook inbox for unread emails"), true);
  assert.equal(toolNeededForRequest("outlook", "What meetings are on my calendar tomorrow?"), true);
  assert.equal(toolNeededForRequest("outlook", "Write a sorting algorithm in Python"), false);
});
