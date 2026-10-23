/* Shared web/desktop interaction scheduling, independent of the workspace UI. */
(function(root) {
  "use strict";
  function createInputQueue(send, onError) {
    var queue = [];
    var busy = false;
    var scheduled = false;
    async function drain() {
      if (busy) return;
      busy = true;
      try {
        while (queue.length) {
          var item = queue.shift();
          try { await send(item); }
          catch (error) { onError(error, item); }
        }
      } finally { busy = false; }
    }
    return function enqueue(payload) {
      var last = queue[queue.length - 1];
      // Merge only adjacent inputs: a click/key/navigation always stays a barrier.
      if (last && last.type === "scroll" && payload.type === "scroll") {
        last.x = payload.x;
        last.y = payload.y;
        last.deltaX += payload.deltaX;
        last.deltaY += payload.deltaY;
      } else if (last && last.type === "type" && payload.type === "type") {
        last.text += payload.text;
      } else {
        queue.push(Object.assign({}, payload));
      }
      if (!scheduled && !busy) {
        scheduled = true;
        setTimeout(function() { scheduled = false; void drain(); }, 0);
      }
    };
  }

  function createFramePresenter(present, schedule, cancel) {
    var latest = null;
    var ticket = null;
    return {
      push: function(frame) {
        latest = frame;
        if (ticket !== null) return;
        ticket = schedule(function() {
          ticket = null;
          var frame = latest;
          latest = null;
          if (frame !== null) present(frame);
        });
      },
      clear: function() {
        if (ticket !== null) cancel(ticket);
        ticket = null;
        latest = null;
      }
    };
  }
  var api = { createInputQueue: createInputQueue, createFramePresenter: createFramePresenter };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.OpenBotsBrowserRuntime = api;
})(typeof window !== "undefined" ? window : globalThis);
