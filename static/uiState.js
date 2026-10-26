(function(root) {
  "use strict";
  // Observable view state only. Run execution, approvals and persistence remain server-owned.
  function createStore(initial) {
    var snapshot = Object.freeze(Object.assign({}, initial));
    var listeners = new Set();
    function getState() { return snapshot; }
    function setState(patch) {
      var next = Object.assign({}, snapshot, typeof patch === "function" ? patch(snapshot) : patch);
      if (Object.keys(next).every(function(key) { return Object.is(next[key], snapshot[key]); })) return snapshot;
      snapshot = Object.freeze(next);
      listeners.forEach(function(fn) { fn(snapshot); });
      return snapshot;
    }
    function subscribe(fn) {
      if (typeof fn !== "function") throw new TypeError("Subscriber must be a function");
      listeners.add(fn);
      return function() { listeners.delete(fn); };
    }
    return Object.freeze({ getState: getState, setState: setState, subscribe: subscribe });
  }
  root.OpenBuddyUI = Object.freeze({ createStore: createStore });
})(typeof window !== "undefined" ? window : globalThis);
