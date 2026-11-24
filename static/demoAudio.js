(function(root) {
  "use strict";
  root.PiloDemoAudio = { create: async function(signal) {
    var context = new AudioContext(), destination = context.createMediaStreamDestination();
    var clips = [], source, closed = false;
    function stop() {
      if (closed) return;
      closed = true;
      if (source) source.stop();
      destination.stream.getTracks().forEach(function(track) { track.stop(); });
      context.close();
    }
    try {
      if (signal && signal.aborted) throw new Error("Demo canceled.");
      if (signal) signal.addEventListener("abort", stop, { once: true });
      await context.resume();
      // Sequential requests bound local speech work; no cloud provider is used.
      for (var scene = 0; scene < 4; scene++) {
        var response = await fetch("/api/recordings/narration", { method: "POST", signal: signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scene: scene }) });
        if (!response.ok) { var error = await response.json(); throw new Error(error.detail || "Narration unavailable."); }
        clips.push(await context.decodeAudioData(await response.arrayBuffer()));
      }
      return {
        stream: destination.stream,
        silence: function() { if (source) { source.stop(); source = null; } },
        minimumSeconds: Math.ceil(Math.max(clips[0].duration / .12, clips[1].duration / .36, clips[2].duration / .24, clips[3].duration / .28) + 2),
        cue: function(index) {
          if (closed) return;
          if (source) source.stop();
          source = context.createBufferSource(); source.buffer = clips[index];
          source.connect(destination); source.connect(context.destination); source.start();
        },
        addMicrophone: function(media) { context.createMediaStreamSource(media).connect(destination); },
        stop: stop
      };
    } catch (error) { stop(); throw error; }
  } };
})(window);
