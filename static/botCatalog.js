(function(root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PiloBotCatalog = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
  "use strict";
  function nameKey(name) { return String(name || "").trim().toLowerCase(); }
  function merge(presets, saved) {
    var bots = (saved || []).filter(function(bot) { return !bot.deleted && bot.kind !== "huddle"; });
    var used = new Set();
    var entries = (presets || []).map(function(preset) {
      var existing = bots.find(function(bot) { return preset.profileId && bot.profileId === preset.profileId; }) || bots.find(function(bot) { return nameKey(bot.name) === nameKey(preset.name); });
      if (existing) used.add(existing.id);
      return Object.assign({}, preset, existing || {}, {
        catalogKey: preset.profileId ? "profile:" + preset.profileId : "preset:" + nameKey(preset.name),
        savedId: existing && existing.id,
        avatar: existing && existing.avatarImage || preset.avatar
      });
    });
    bots.forEach(function(bot) {
      if (!used.has(bot.id)) entries.push(Object.assign({}, bot, { catalogKey: "saved:" + bot.id, savedId: bot.id, avatar: bot.avatarImage }));
    });
    return entries;
  }
  return { merge: merge };
});
