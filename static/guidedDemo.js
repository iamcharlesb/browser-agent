(function(root) {
  "use strict";
  // Only these local navigation actions are allowed. Never submit a prompt.
  root.PiloGuidedDemo = { prepare: function(options) {
    options = options || {};
    var timers = [], stopped = false, interrupted = false, completed = [];
    var restore = root.__piloDemoSelection && root.__piloDemoSelection();
    var overlay = document.createElement("div"); overlay.id = "guided-demo-overlay";
    overlay.innerHTML = '<div class="demo-pointer">➤</div><div class="demo-caption" role="status">Explore Pilo’s specialist bots</div>';
    var style = document.createElement("style");
    style.textContent = '#guided-demo-overlay{pointer-events:none;position:fixed;inset:0;z-index:9998}.demo-pointer{position:absolute;color:#2563eb;font:38px system-ui;filter:drop-shadow(0 2px 3px white);transition:left .35s,top .35s}.demo-caption{position:absolute;bottom:95px;left:50%;transform:translateX(-50%);max-width:80vw;padding:12px 22px;background:#101827ed;color:white;border-radius:12px;font:600 18px system-ui;text-align:center}.demo-pointer.demo-click{color:#ef4444}body.pilo-guided-demo #messages{visibility:hidden}body.pilo-guided-demo #prompt{color:transparent!important;caret-color:transparent!important}';
    document.head.appendChild(style); document.body.appendChild(overlay); document.body.classList.add("pilo-guided-demo");
    var failure;
    function later(fn, delay) { timers.push(setTimeout(function() { if (!stopped) fn(); }, delay)); }
    function click(selector, caption) {
      var element = document.querySelector(selector);
      if (!element) throw new Error("Guided walkthrough control is unavailable: " + selector);
      element.scrollIntoView({ block: "center", behavior: "instant" });
      var box = element.getBoundingClientRect();
      if (!box.width || !box.height) throw new Error("Guided walkthrough control is hidden.");
      overlay.querySelector(".demo-caption").textContent = caption;
      var pointer = overlay.querySelector(".demo-pointer"); pointer.style.left = (box.left + box.width / 2) + "px"; pointer.style.top = (box.top + box.height / 2) + "px";
      later(function() { pointer.classList.add("demo-click"); element.click(); completed.push(selector); later(function() { pointer.classList.remove("demo-click"); }, 200); }, 400);
    }
    function stop(userInterrupted) {
      if (stopped) return;
      stopped = true; interrupted = !!userInterrupted; timers.forEach(clearTimeout);
      document.removeEventListener("pointerdown", takeover, true); document.removeEventListener("keydown", takeover, true);
      overlay.remove(); style.remove(); document.body.classList.remove("pilo-guided-demo");
      if (options.onStop) options.onStop();
      if (!interrupted && restore) restore();
    }
    function takeover(event) {
      if (event.isTrusted && !event.target.closest("#recording-indicator")) stop(true);
    }
    try {
      document.getElementById("brand-home-btn").click();
      var search = document.getElementById("catalog-search");
      if (search && search.value) { search.value = ""; search.dispatchEvent(new Event("input", { bubbles: true })); }
      document.querySelector('.catalog-filter-btn[data-category="all"]').click();
      document.addEventListener("pointerdown", takeover, true); document.addEventListener("keydown", takeover, true);
    } catch (error) { stop(false); throw error; }
    return {
      start: function(seconds) {
        var span = seconds * 1000;
        if (options.cue) options.cue(0);
        function step(fn) { try { fn(); } catch (error) { failure = error.message; stop(false); } }
        later(function() { step(function() { if (options.cue) options.cue(1); click('.template-card[data-catalog-key="profile:demo-director"]', "Choose Demo Director — a specialist for your demo"); }); }, span * .12);
        later(function() { step(function() {
          if (options.cue) options.cue(2);
          root.__piloOpenHelp("demos"); completed.push("help");
          overlay.querySelector(".demo-caption").textContent = "Explore recording tools and help — no model request sent";
          click("#pane-new-tab-btn", "Open workspace tools");
        }); }, span * .48);
        later(function() { step(function() { if (options.cue) options.cue(3); click('[data-launch="help"]', "Read Pilo’s built-in help"); }); }, span * .72);
      },
      stop: stop,
      report: function() { return { interrupted: interrupted, failure: failure, actions: completed.slice() }; }
    };
  } };
})(window);
