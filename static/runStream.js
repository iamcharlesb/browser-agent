(function(root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.OpenBotsRunStreams = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
  "use strict";
  function create(options) {
    var records = new Map();
    var later = options.setTimeout || setTimeout;
    function changed(record) { if (options.onChange) options.onChange(record); }
    function receive(record, event) {
      if (event.runId && event.runId !== record.runId) return;
      if (record.status !== "running") return;
      record.lastEvent = event;
      if (event.type === "privileged_approval_required" || event.type === "human_verification") record.pendingEvent = event;
      if (event.type === "privileged_approval_resolved" || event.type === "human_verification_resolved") record.pendingEvent = null;
      if (event.type === "terminal") {
        record.pendingEvent = null;
        record.discussionId = event.discussionId;
        record.status = event.discussionId && !event.discussionFinal && event.terminationReason !== "stopped" ? "following" : "completed";
        record.source.close();
      }
      options.onEvent(record, Object.assign({}, event, { trackedRun: true }));
      changed(record);
      if (record.status === "following") follow(record);
    }
    function fail(record, message) {
      if (record.status === "following") record.status = "running";
      receive(record, { type: "terminal", runId: record.runId, success: false, summary: message, terminationReason: "connection_lost" });
    }
    function follow(record) {
      var version = record.followVersion = (record.followVersion || 0) + 1;
      function poll() {
        if (record.status !== "following" || record.followVersion !== version) return;
        options.fetchJson("/api/discussions/" + encodeURIComponent(record.discussionId)).then(function(state) {
          if (record.status !== "following" || record.followVersion !== version) return;
          if (state.runId && state.runId !== record.runId) {
            record.status = "completed";
            subscribe({ runId: state.runId, botName: state.botName, ownerId: record.ownerId });
            changed(record);
          } else if (["completed", "failed", "cancelled"].indexOf(state.phase) >= 0) {
            record.status = "completed";
            changed(record);
          } else later(poll, 250);
        }).catch(function(error) {
          if (record.status !== "following" || record.followVersion !== version) return;
          if (error.status === 404) fail(record, "This discussion was interrupted by a server restart or has expired. Start a new request.");
          else { record.connectionError = true; changed(record); later(poll, 800); }
        });
      }
      poll();
    }
    function subscribe(input) {
      if (records.has(input.runId)) return records.get(input.runId);
      var record = Object.assign({ status: "running", pendingEvent: null, cursor: "0" }, input);
      records.set(record.runId, record);
      var source = record.source = new options.EventSource("/api/events?runId=" + encodeURIComponent(record.runId) + "&after=0");
      source.onmessage = function(message) {
        if (message.lastEventId) record.cursor = message.lastEventId;
        try { receive(record, JSON.parse(message.data)); } catch (error) { if (options.onError) options.onError(error); }
      };
      source.onerror = function() {
        if (record.status !== "running" || record.reconciling) return;
        record.reconciling = true;
        record.connectionError = true;
        changed(record);
        options.fetchJson("/api/runs/" + encodeURIComponent(record.runId)).then(function(state) {
          if (record.status !== "running") return;
          record.connectionError = false;
          if (state.terminal) receive(record, state.terminal);
          else if (!state.isRunning) fail(record, "This run ended without a recoverable result. Review its work before retrying.");
          changed(record);
        }).catch(function(error) {
          if (record.status === "running" && error.status === 404) fail(record, "This run is unavailable after a server restart or has expired. Review its work before retrying.");
        }).finally(function() { record.reconciling = false; });
      };
      changed(record);
      return record;
    }
    return {
      subscribe: subscribe,
      activeFor: function(ownerId) { return Array.from(records.values()).reverse().find(function(record) { return record.ownerId === ownerId && ["running", "following"].indexOf(record.status) >= 0; }); },
      list: function() { return Array.from(records.values()); },
      forgetOwner: function(ownerId) { records.forEach(function(record, id) { if (record.ownerId === ownerId) { record.followVersion = (record.followVersion || 0) + 1; record.status = "completed"; if (record.source) record.source.close(); records.delete(id); } }); },
      cancelFollowing: function(ownerId) { records.forEach(function(record) { if (record.ownerId === ownerId && record.status === "following") { record.followVersion++; record.status = "completed"; changed(record); } }); }
    };
  }
  return { create: create };
});
