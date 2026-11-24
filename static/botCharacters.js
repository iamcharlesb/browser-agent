/* Shared role avatars: SVG artwork only; this module never starts agent work. */
(function(root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./botCharacterArtwork.js"));
  else root.PiloCharacters = factory(root.PiloCharacterArtwork);
})(typeof window !== "undefined" ? window : globalThis, function(artwork) {
  "use strict";
  var sequence = 0;
  var fallback = ["frog", "heart", "yellow", "blob", "bot", "star", "cloud", "cat", "nova", "sage"];
  var modes = ["idle", "thinking", "writing", "sad", "happy"];

  function select(agent) {
    agent = agent || {};
    // Keep deliberately chosen silhouettes, uploaded avatars and real headshots.
    var image = agent.avatarImage || agent.avatar || "";
    if (image && !/^(?:\.\/)?(?:avatars\/pilo-\d{2}-[a-z-]+\.png|pilo-(?:icon|mascot)\.png|avatars\/blog-writer\.svg)(?:\?|$)/i.test(image)) return null;
    var picked = String(agent.shape || "").replace(/^character-/, "");
    if (String(agent.shape || "").indexOf("character-") === 0 && Object.prototype.hasOwnProperty.call(artwork.characters, picked)) return picked;
    if (agent.shapeCustomized) return null;
    var role = ((agent.name || "") + " " + (agent.profileId || "")).toLowerCase().replace(/[-_]/g, " ");
    if (/primary bot|^pilo\b|^new (?:bot|agent)\b/.test(role) || !role.trim()) return "pilo";
    if (/founder operator|founder ops/.test(role)) return "pilo";
    // Match platform and specialist roles before broad marketing/growth labels.
    if (/reddit|community/.test(role)) return "blob";
    if (/instagram/.test(role)) return "heart";
    if (/linkedin/.test(role)) return "sage";
    if (/\bseo\b|search optimization/.test(role)) return "yellow";
    if (/influencer/.test(role)) return "cat";
    if (/\bads\b|paid media|performance marketing/.test(role)) return "bot";
    if (/funnel/.test(role)) return "yellow";
    if (/product marketing/.test(role)) return "star";
    if (/blog|writer|copywriter|content|storytell|resume|notes/.test(role)) return "blogger";
    if (/design|\bux\b|\bui\b|animator|\bgif\b/.test(role)) return "designer";
    if (/marketing|\bcmo\b|\bads\b|paid media|funnel|\bseo\b|growth|influencer|revenue|sales/.test(role)) return "marketing";
    if (/coding|code|developer|engineer|devops|terminal|fullstack|supercomputer|bot creator/.test(role)) return "byte";
    if (/grok|trend researcher|critica/.test(role)) return "nova";
    if (/chatgpt|assistant|support|supervisor/.test(role)) return "sage";
    if (/research|competitor/.test(role)) return "frog";
    if (/analyst|finance|wall street|goldman/.test(role)) return "yellow";
    var hash = 0;
    for (var i = 0; i < role.length; i++) hash = (Math.imul(hash, 31) + role.charCodeAt(i)) >>> 0;
    return fallback[hash % fallback.length];
  }

  function migrateSavedIcon(agent) {
    if (!agent || agent.characterIconRevision === 2) return false;
    var name = String(agent.name || "").trim().toLowerCase();
    var updates = {
      "reddit community growth": { icon: "blob", previous: ["character-marketing", "character-heart"] },
      "seo specialist": { icon: "yellow", previous: ["character-marketing", "character-heart"] },
      "instagram follower growth": { icon: "heart", previous: ["character-marketing", "character-heart"] },
      "founder operator": { icon: "pilo", previous: ["character-cloud", "cloud", "circle", undefined] }
    };
    if (!Object.prototype.hasOwnProperty.call(updates, name)) return false;
    var update = updates[name];
    if (!update || update.previous.indexOf(agent.shape) < 0) return false;
    agent.shape = "character-" + update.icon;
    agent.characterIconRevision = 2;
    return true;
  }

  function expression(value) {
    if (modes.indexOf(value) >= 0) return value;
    if (/^(attentive|curious|confused|suspicious)$/.test(value)) return "thinking";
    if (/^(happy|proud|excited|laughing|shy)$/.test(value)) return "happy";
    if (/^(sad|angry|scared)$/.test(value)) return "sad";
    return "idle";
  }

  function forStep(event) {
    if (event && event.ok === false) return "sad";
    var tool = String(event && event.toolName || "");
    var message = String(event && event.message || "");
    if (/^(create_document|generate_image|type|fill|press_key)$/.test(tool)) return "writing";
    if (/^(workspace_file|code_project)$/.test(tool) && /^(Patched|Wrote|Updated|Appended|Created)\b/i.test(message)) return "writing";
    return "thinking";
  }

  function render(name, state) {
    var key = Object.prototype.hasOwnProperty.call(artwork.characters, name) ? name : "pilo";
    var character = artwork.characters[key];
    var prefix = "pilo-char-" + (++sequence) + "-";
    var markup = artwork.defs + character.body;
    // SVG IDs are document-wide. Namespace each avatar's gradient references.
    markup = markup.replace(/\bid="([^"]+)"/g, function(_, id) { return 'id="' + prefix + id + '"'; })
      .replace(/url\(#([^)]+)\)/g, function(_, id) { return "url(#" + prefix + id + ")"; });
    return '<svg class="pilo-character" data-character="' + key + '" viewBox="' + character.viewBox + '" data-expression="' + expression(state) + '" aria-hidden="true" focusable="false">' + markup + '</svg>';
  }
  return { migrateSavedIcon: migrateSavedIcon, select: select, render: render, expression: expression, forStep: forStep, names: Object.keys(artwork.characters) };
});
