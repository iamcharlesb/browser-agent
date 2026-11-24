(function(root) {
  "use strict";
  var stream, microphone, recorder, frame, timer, chunks = [], request, config, previewUrl;
  var busy = false, seenRequest, ready = false, countdownToken = 0, tour;
  var dialog = document.createElement("dialog");
  dialog.id = "screen-recording-dialog";
  dialog.setAttribute("aria-labelledby", "screen-recording-title");
  dialog.innerHTML = '<header><div><strong id="screen-recording-title">Record a real screen demo</strong><p>Capture your app, preview the take, download the video.</p></div><button type="button" id="recording-close" aria-label="Close recorder">×</button></header>' +
    '<video id="recording-preview" muted playsinline></video><p id="recording-status" role="status">Select a clean window. Exclude credentials and private conversations before recording.</p>' +
    '<div class="recording-options"><label id="recording-source-choice" hidden>Source <select id="recording-source-mode"><option value="interface">Pilo interface (no embedded browser)</option><option value="window">Entire Pilo window (macOS permission)</option></select></label><label>Length <input id="recording-seconds" type="number" min="1" value="10"> seconds</label><label><input id="recording-mic" type="checkbox"> Microphone narration</label></div>' +
    '<p><label><input id="recording-guided" type="checkbox" checked> Run guided Pilo walkthrough</label><br><small>Clicks through the bot catalog, selects/adds Demo Director, and opens Help. No messages sent. Use Pilo as the capture source; uncheck to operate manually.</small></p>' +
    '<footer><button type="button" id="recording-source">Choose screen / window</button><button type="button" id="recording-start" disabled>Start recording</button><a id="recording-download" hidden download>Download video</a></footer>';
  document.body.appendChild(dialog);
  var style = document.createElement("style");
  style.textContent = '#screen-recording-dialog{width:min(720px,calc(100vw - 32px));border:1px solid #dce1e8;border-radius:18px;padding:22px;color:#172033;background:#fff;box-shadow:0 20px 80px #0003}#screen-recording-dialog::backdrop{background:#10203866}#screen-recording-dialog header,#screen-recording-dialog footer,.recording-options{display:flex;align-items:center;gap:12px;justify-content:space-between}#screen-recording-dialog header p{font-size:13px;color:#667085;margin:6px 0 18px}#screen-recording-dialog button,#screen-recording-dialog a{border:1px solid #dce1e8;border-radius:8px;background:#fff;padding:9px 13px;cursor:pointer;font:inherit;font-size:13px}#recording-start{background:#111827!important;color:white}#screen-recording-dialog button:disabled{opacity:.45;cursor:default}#recording-preview{display:block;width:100%;aspect-ratio:16/9;background:#111827;border-radius:10px;object-fit:contain}#recording-status{font-size:13px;line-height:1.6}.recording-options{justify-content:flex-start;flex-wrap:wrap;font-size:13px;margin:14px 0}.recording-options input[type=number]{width:64px;padding:6px;border:1px solid #dce1e8;border-radius:6px}#recording-indicator{position:fixed;bottom:22px;right:22px;z-index:10000;background:#fff;border:1px solid #fecaca;box-shadow:0 4px 20px #0002;border-radius:999px;padding:10px 16px;display:flex;align-items:center;gap:12px;color:#b91c1c;font:600 13px system-ui}#recording-indicator[hidden]{display:none}#recording-indicator button{border:0;background:#b91c1c;color:white;border-radius:6px;padding:5px 9px;cursor:pointer}';
  document.head.appendChild(style);
  var indicator = document.createElement("div"); indicator.id = "recording-indicator"; indicator.hidden = true;
  indicator.innerHTML = '<span role="status">● Recording</span><button type="button">Stop</button>';
  document.body.appendChild(indicator);
  var video = dialog.querySelector("video"), status = dialog.querySelector("#recording-status");
  var sourceButton = dialog.querySelector("#recording-source"), startButton = dialog.querySelector("#recording-start");
  var download = dialog.querySelector("#recording-download"), seconds = dialog.querySelector("#recording-seconds");
  var mic = dialog.querySelector("#recording-mic");
  var desktop = root.openBotsDesktop && root.openBotsDesktop.prepareScreenCapture;
  dialog.querySelector("#recording-source-choice").hidden = !desktop;
  if (desktop) sourceButton.textContent = "Preview selected source";
  function message(text) { status.textContent = text; }
  async function api(path, body) {
    var response = await fetch("/api/recordings" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    var result = await response.json(); if (!response.ok) throw new Error(result.detail || "Recording request failed."); return result.recording;
  }
  async function settings() {
    var response = await fetch("/api/recordings"); if (!response.ok) throw new Error("Restart Pilo to enable screen recording.");
    var result = await response.json(); config = result.config; seconds.max = config.maxSeconds; return result;
  }
  function release() {
    if (tour) { tour.stop(false); tour = null; }
    if (frame) cancelAnimationFrame(frame); clearTimeout(timer); frame = null;
    [stream, microphone].forEach(function(media) { if (media) media.getTracks().forEach(function(track) { track.stop(); }); });
    stream = microphone = null; ready = false; startButton.disabled = true;
  }
  async function fail(error) {
    countdownToken++; busy = false; indicator.hidden = true; release();
    if (request) await api("/" + request.id + "/fail").catch(function() {});
    sourceButton.disabled = false; seconds.disabled = mic.disabled = false;
    if (!dialog.open) dialog.showModal();
    var permissionError = error && ["NotAllowedError", "NotReadableError", "AbortError"].includes(error.name);
    message((error && error.message || String(error)) + (permissionError ? " For full-window capture on macOS, allow Pilo in System Settings → Privacy & Security → Screen & System Audio Recording, then retry or choose Pilo interface." : ""));
  }
  async function open(existing) {
    if (busy) return;
    try {
      await settings();
      if (existing) { request = existing; seenRequest = existing.id; seconds.value = existing.durationSeconds; }
      if (!dialog.open) dialog.showModal();
    } catch (error) { if (!dialog.open) dialog.showModal(); message(error.message); }
  }
  sourceButton.onclick = async function() {
    try {
      release(); await settings();
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia || !root.MediaRecorder) throw new Error("Screen capture is unavailable in this browser. Open the Pilo desktop app.");
      if (desktop) await root.openBotsDesktop.prepareScreenCapture(dialog.querySelector("#recording-source-mode").value);
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: config.fps }, audio: false });
      if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
      video.removeAttribute("src"); video.controls = false; video.muted = true; video.srcObject = stream; await video.play();
      download.hidden = true; ready = true; startButton.disabled = false;
      stream.getVideoTracks()[0].addEventListener("ended", function() {
        if (recorder && recorder.state !== "inactive") recorder.stop();
        else if (ready || busy) fail(new Error("Screen sharing ended before the take started."));
      });
      message("Live preview. Verify this is the right window, then start. Pilo records actual pixels with a 1080p presentation frame.");
    } catch (error) { await fail(error); }
  };
  startButton.onclick = async function() {
    if (!ready || busy) return;
    try {
      var duration = Number(seconds.value);
      if (!Number.isInteger(duration) || duration < 1 || duration > config.maxSeconds) throw new Error("Choose a valid recording length.");
      if (dialog.querySelector("#recording-guided").checked && duration < 6) throw new Error("Choose at least 6 seconds for guided actions, or uncheck the guided walkthrough.");
      if (mic.checked) microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
      request = await api("", { durationSeconds: duration }); seenRequest = request.id;
      if (request.durationSeconds !== duration) { message("An existing request is active. Recording its requested " + request.durationSeconds + " seconds."); duration = request.durationSeconds; }
      request = await api("/" + request.id + "/start");
      busy = true; startButton.disabled = true; sourceButton.disabled = true; seconds.disabled = mic.disabled = true;
      // Remove the source preview before the countdown so self-capture cannot
      // record a hall-of-mirrors frame from its own preview dialog.
      dialog.close(); indicator.hidden = false;
      if (dialog.querySelector("#recording-guided").checked && root.PiloGuidedDemo) tour = root.PiloGuidedDemo.prepare();
      var token = ++countdownToken;
      for (var n = 3; n > 0; n--) { indicator.querySelector("span").textContent = "Starting in " + n + "…"; await new Promise(function(resolve) { setTimeout(resolve, 1000); }); if (token !== countdownToken) return; }
      // Frame the actual selected source; no generated UI or simulated workflow.
      var canvas = document.createElement("canvas"); canvas.width = 1920; canvas.height = 1080;
      var ctx = canvas.getContext("2d"), captured = stream;
      function draw() {
        ctx.fillStyle = "#101827"; ctx.fillRect(0, 0, 1920, 1080);
        var scale = Math.min(1856 / video.videoWidth, 984 / video.videoHeight);
        var w = video.videoWidth * scale, h = video.videoHeight * scale;
        ctx.drawImage(video, (1920 - w) / 2, 32 + (984 - h) / 2, w, h);
        ctx.fillStyle = "#dce5f4"; ctx.font = "22px system-ui"; ctx.fillText("Pilo · Live screen recording", 36, 1052);
        frame = requestAnimationFrame(draw);
      }
      draw();
      var output = canvas.captureStream(config.fps);
      if (microphone) microphone.getAudioTracks().forEach(function(track) { output.addTrack(track); });
      var mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find(function(type) { return MediaRecorder.isTypeSupported(type); });
      if (!mime) throw new Error("This browser cannot encode WebM video.");
      recorder = new MediaRecorder(output, { mimeType: mime, videoBitsPerSecond: config.bitrate }); chunks = []; var bytes = 0;
      recorder.ondataavailable = function(event) { if (event.data.size) { bytes += event.data.size; chunks.push(event.data); if (bytes > config.maxBytes && recorder.state !== "inactive") recorder.stop(); } };
      recorder.onerror = function(event) { fail(event.error || new Error("Video encoder failed.")); };
      var startedAt;
      recorder.onstop = async function() {
        cancelAnimationFrame(frame); clearTimeout(timer); indicator.hidden = true;
        var guidedResult = tour ? tour.report() : null;
        if (tour) { tour.stop(false); tour = null; }
        var blob = new Blob(chunks, { type: "video/webm" });
        if (root.PiloWebM) blob = new Blob([root.PiloWebM.setDuration(new Uint8Array(await blob.arrayBuffer()), performance.now() - startedAt)], { type: "video/webm" });
        output.getTracks().forEach(function(track) { track.stop(); });
        // Keep the source video until the encoder has delivered its final chunk.
        release(); video.srcObject = null; busy = false; sourceButton.disabled = false; seconds.disabled = mic.disabled = false;
        previewUrl = URL.createObjectURL(blob); video.src = previewUrl; video.controls = true; video.muted = false;
        download.href = previewUrl; download.download = "pilo-screen-recording.webm"; download.hidden = false;
        if (!dialog.open) dialog.showModal(); message("Saving your recorded video…");
        try {
          if (bytes > config.maxBytes) throw new Error("Recording reached the configured size limit. Download the local take or record a shorter clip.");
          var response = await fetch("/api/recordings/" + request.id + "/video", { method: "POST", headers: { "Content-Type": "video/webm" }, body: blob });
          var result = await response.json(); if (!response.ok) throw new Error(result.detail || "Could not save recording.");
          if (!result.recording || result.recording.state !== "completed" || !result.recording.artifactUrl) throw new Error("Recording was canceled before it could be saved.");
          request = result.recording; download.href = request.artifactUrl + "?download=1";
          message("Recording saved. " + (guidedResult ? (guidedResult.failure ? "Walkthrough stopped: " + guidedResult.failure + " " : guidedResult.interrupted ? "You took over the walkthrough. " : "Guided walkthrough performed " + guidedResult.actions.length + " local actions. ") : "") + "Play the actual take below or download the WebM video. Nothing was published.");
        } catch (error) { await api("/" + request.id + "/fail").catch(function() {}); message(error.message + " Your local video is still available through Download video."); }
      };
      dialog.close(); indicator.hidden = false; startedAt = performance.now(); recorder.start(1000);
      if (tour) tour.start(duration);
      indicator.querySelector("span").textContent = "● Recording · " + duration + " seconds";
      timer = setTimeout(function() { if (recorder.state !== "inactive") recorder.stop(); }, duration * 1000);
      captured.getVideoTracks()[0].addEventListener("ended", stop, { once: true });
    } catch (error) { await fail(error); }
  };
  function stop() {
    if (recorder && recorder.state !== "inactive") recorder.stop();
    else if (busy) fail(new Error("Recording canceled during countdown."));
  }
  indicator.querySelector("button").onclick = stop;
  dialog.querySelector("#recording-close").onclick = async function() {
    if (busy) { countdownToken++; stop(); busy = false; }
    release(); if (request && ["pending", "recording"].includes(request.state)) await api("/" + request.id + "/fail").catch(function() {});
    dialog.close(); sourceButton.disabled = false; seconds.disabled = mic.disabled = false;
  };
  dialog.addEventListener("cancel", function(event) { event.preventDefault(); dialog.querySelector("#recording-close").click(); });
  var button = document.createElement("button"); button.type = "button"; button.id = "screen-record-button"; button.className = "composer-action";
  button.title = "Record a real screen demo"; button.setAttribute("aria-label", "Record screen");
  button.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="13" rx="2"/><circle cx="12" cy="10.5" r="3"/><path d="M8 21h8m-4-4v4"/></svg>';
  var toolbar = document.querySelector(".composer-toolbar"); if (toolbar) toolbar.insertBefore(button, document.getElementById("voice-button"));
  button.onclick = function() { open(); };
  root.addEventListener("pagehide", function() {
    if (request && ["pending", "recording"].includes(request.state) && navigator.sendBeacon) {
      navigator.sendBeacon("/api/recordings/" + request.id + "/fail", new Blob(["{}"], { type: "application/json" }));
    }
    release();
  });
  root.PiloScreenRecorder = { open: open };
  async function poll() {
    try { var state = await settings(); if (!busy && state.recording && state.recording.state === "pending" && state.recording.id !== seenRequest) await open(state.recording); } catch (_) {}
    setTimeout(poll, config ? config.pollMs : 5000);
  }
  poll();
})(window);
