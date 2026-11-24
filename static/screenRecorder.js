(function(root) {
  "use strict";
  var stream, microphone, recorder, timer, chunks = [], request, config, previewUrl;
  var busy = false, seenRequest, ready = false, countdownToken = 0, tour, narration, narrationAbort, demoPreview = false;
  var dialog = document.createElement("dialog");
  dialog.id = "screen-recording-dialog";
  dialog.setAttribute("aria-labelledby", "screen-recording-title");
  dialog.innerHTML = '<header><div><span class="recording-eyebrow">SCREEN RECORDING</span><h2 id="screen-recording-title">Record your screen</h2><p>Preview your source, record your take, then download it.</p></div><button type="button" id="recording-close" aria-label="Close recorder">×</button></header>' +
    '<ol class="recording-steps" aria-label="Recording progress"><li data-step="1">1 · Preview source</li><li data-step="2">2 · Record</li><li data-step="3">3 · Download</li></ol>' +
    '<div class="recording-preview-wrap"><video id="recording-preview" muted playsinline></video><div id="recording-empty"><span class="recording-preview-icon" aria-hidden="true">▣</span><strong>First, preview what you’ll record</strong><span id="recording-empty-hint"></span></div><span id="recording-quality" hidden></span></div>' +
    '<p id="recording-status" role="status"></p>' +
    '<div class="recording-options"><label class="recording-duration">Length <span><input id="recording-seconds" type="number" min="1" value="10"> seconds</span></label>' +
    '<label class="recording-toggle"><input id="recording-guided" type="checkbox" checked><span><strong>Guided walkthrough</strong><small>Pilo clicks through the demo for you</small></span></label>' +
    '<label class="recording-toggle"><input id="recording-narration" type="checkbox"><span><strong>Voiceover</strong><small>Local narration, included in the video</small></span></label></div>' +
    '<details class="recording-advanced"><summary>More options</summary><div class="recording-advanced-body"><label id="recording-source-choice" hidden>Capture source<select id="recording-source-mode"><option value="interface">Pilo app · recommended</option><option value="window">Entire window · includes embedded browser</option></select><small id="recording-source-help"></small></label><label class="recording-toggle"><input id="recording-mic" type="checkbox"><span><strong>Add my microphone</strong><small>Record your own voice alongside the demo</small></span></label><button type="button" id="demo-play">Try walkthrough without recording</button></div></details>' +
    '<footer><span id="recording-next"></span><div class="recording-actions"><button type="button" id="recording-source"></button><button type="button" id="recording-start" class="recording-primary" hidden disabled>Start recording</button><a id="recording-download" class="recording-primary" hidden download>Download video</a></div></footer>';
  document.body.appendChild(dialog);
  var style = document.createElement("style");
  style.textContent = `
    #screen-recording-dialog{box-sizing:border-box;width:min(760px,calc(100vw - 32px));max-height:calc(100dvh - 32px);overflow:auto;border:1px solid #dce3ed;border-radius:20px;padding:26px;color:#172033;background:#fff;box-shadow:0 24px 90px #0003;font:14px/1.5 system-ui}
    #screen-recording-dialog *{box-sizing:border-box}#screen-recording-dialog [hidden]{display:none!important}
    #screen-recording-dialog::backdrop{background:#0c152965;backdrop-filter:blur(3px)}
    #screen-recording-dialog header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
    .recording-eyebrow{font-size:10px;letter-spacing:.15em;font-weight:700;color:#64748b}#screen-recording-dialog h2{font-size:23px;line-height:1.3;margin:5px 0 6px;letter-spacing:-.5px}#screen-recording-dialog header p{color:#64748b;margin:0}
    #screen-recording-dialog button,#screen-recording-dialog a{font:600 13px/1.3 system-ui;cursor:pointer;border:1px solid #d7dfeb;border-radius:9px;padding:11px 15px;background:white;color:#334155;text-decoration:none;white-space:normal}
    #screen-recording-dialog button:hover{background:#f1f5f9}#screen-recording-dialog #recording-close{padding:3px 9px;border:0;font-size:24px;font-weight:400;color:#64748b}
    #screen-recording-dialog .recording-primary{background:#155eef;color:white;border-color:#155eef;box-shadow:0 2px 4px #155eef20}#screen-recording-dialog .recording-primary:hover{background:#124ed0}
    #screen-recording-dialog button:disabled{opacity:.5;cursor:wait}#screen-recording-dialog :focus-visible{outline:3px solid #93c5fd;outline-offset:3px}
    .recording-steps{list-style:none;display:flex;padding:0;gap:8px;margin:22px 0 14px;font-size:12px;color:#94a3b8}.recording-steps li{flex:1;padding-bottom:9px;border-bottom:2px solid #e8edf4}.recording-steps .current{color:#155eef;border-color:#155eef;font-weight:700}.recording-steps .complete{color:#15803d;border-color:#86d4a0}
    .recording-preview-wrap{position:relative;height:clamp(170px,30vh,300px);background:#f3f6fb;border:1px solid #e1e7f0;border-radius:12px;overflow:hidden}
    #recording-preview{display:block;width:100%;height:100%;object-fit:contain;background:#101827}
    #recording-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;padding:18px;text-align:center;background:linear-gradient(135deg,#f8fafc,#edf3ff);color:#334155;pointer-events:none}
    .recording-preview-icon{font-size:36px;line-height:1.2;color:#155eef}#recording-empty strong{font-size:17px}#recording-empty-hint{font-size:13px;color:#64748b;max-width:380px}
    #recording-quality{position:absolute;bottom:9px;left:9px;border-radius:6px;background:#101827df;color:#fff;padding:4px 8px;font-size:11px}
    #recording-status{font-size:13px;color:#475569;min-height:20px;margin:12px 0 18px}#screen-recording-dialog[data-stage=ready] #recording-status{color:#15803d}
    #screen-recording-dialog.recording-low-resolution[data-stage=ready] #recording-status{color:#975a0c}
    .recording-options{display:grid;grid-template-columns:110px 1fr 1fr;align-items:center;gap:16px;margin:0 0 18px}.recording-duration{font-weight:600;color:#475569}.recording-duration>span{display:flex;gap:6px;align-items:center;font-size:12px;font-weight:400;margin-top:4px}.recording-duration input{width:60px;min-width:0;padding:7px;border:1px solid #d7dfeb;border-radius:7px;font:inherit}
    .recording-toggle{display:flex;align-items:flex-start;gap:9px;cursor:pointer}.recording-toggle input{width:16px;height:16px;margin:3px 0;accent-color:#155eef;flex-shrink:0}.recording-toggle strong{display:block;font-size:13px;font-weight:600}.recording-toggle small,#recording-source-help{display:block;font-size:11px;color:#64748b;line-height:1.5;margin-top:3px}
    .recording-advanced{border-top:1px solid #e8edf4;padding-top:12px}.recording-advanced summary{cursor:pointer;color:#64748b;font-size:12px}.recording-advanced-body{display:grid;gap:16px;padding:14px 0 4px}.recording-advanced-body select{display:block;width:100%;max-width:100%;padding:9px;margin-top:5px;border:1px solid #d7dfeb;border-radius:7px;background:#fff;color:#172033;font:inherit}.recording-advanced-body button{justify-self:start}
    #screen-recording-dialog footer{display:flex;align-items:center;justify-content:space-between;gap:14px;margin:18px -26px -26px;padding:18px 26px;background:#f8fafc;border-top:1px solid #e8edf4;position:sticky;bottom:-26px}#recording-next{font-size:12px;color:#64748b;max-width:230px}.recording-actions{display:flex;gap:8px;align-items:center;justify-content:flex-end}
    #recording-indicator{position:fixed;bottom:22px;right:22px;z-index:10000;background:#fff;border:1px solid #fecaca;box-shadow:0 4px 20px #0002;border-radius:999px;padding:10px 16px;display:flex;align-items:center;gap:12px;color:#b91c1c;font:600 13px system-ui}#recording-indicator[hidden]{display:none}#recording-indicator button{border:0;background:#b91c1c;color:white;border-radius:6px;padding:5px 9px;cursor:pointer}
    @media(max-width:560px){#screen-recording-dialog{padding:18px}#screen-recording-dialog h2{font-size:20px}.recording-options{grid-template-columns:1fr 1fr;gap:14px}.recording-duration{grid-column:1/-1;display:flex;gap:12px;align-items:center}.recording-duration>span{margin:0}#screen-recording-dialog footer{margin:16px -18px -18px;padding:14px 18px;bottom:-18px;align-items:stretch;flex-direction:column}.recording-actions{flex-wrap:wrap}.recording-actions button,.recording-actions a{flex:1;text-align:center}#recording-next{max-width:none}.recording-steps{font-size:10px;gap:5px}}
  `;
  document.head.appendChild(style);
  var indicator = document.createElement("div"); indicator.id = "recording-indicator"; indicator.hidden = true;
  indicator.innerHTML = '<span role="status">● Recording</span><button type="button">Stop</button>';
  document.body.appendChild(indicator);
  var video = dialog.querySelector("video"), status = dialog.querySelector("#recording-status");
  var sourceButton = dialog.querySelector("#recording-source"), startButton = dialog.querySelector("#recording-start");
  var download = dialog.querySelector("#recording-download"), seconds = dialog.querySelector("#recording-seconds");
  var previewButton = dialog.querySelector("#demo-play"), spoken = dialog.querySelector("#recording-narration");
  var guided = dialog.querySelector("#recording-guided");
  spoken.onchange = function() { if (spoken.checked) { guided.checked = true; seconds.value = Math.max(20, Number(seconds.value)); } };
  function controls(disabled) { previewButton.disabled = spoken.disabled = guided.disabled = seconds.disabled = mic.disabled = sourceMode.disabled = disabled; }
  function tourOptions() { return { cue: function(scene) { if (narration) narration.cue(scene); }, onStop: function() { if (narration) narration.silence(); } }; }
  async function loadNarration(duration, token) {
    if (!spoken.checked) return duration;
    message("Preparing local voice narration…");
    narrationAbort = new AbortController();
    var audio = await root.PiloDemoAudio.create(narrationAbort.signal);
    if (token !== countdownToken) { audio.stop(); throw new Error("Demo canceled."); }
    narration = audio;
    if (audio.minimumSeconds > config.maxSeconds) throw new Error("This voice needs more time than the configured recording limit. Disable spoken guide or increase that limit.");
    duration = Math.max(duration, audio.minimumSeconds); seconds.value = duration;
    return duration;
  }
  var mic = dialog.querySelector("#recording-mic");
  var desktop = root.openBotsDesktop && root.openBotsDesktop.prepareScreenCapture;
  dialog.querySelector("#recording-source-choice").hidden = !desktop;
  var sourceMode = dialog.querySelector("#recording-source-mode");
  function stage(name) {
    dialog.dataset.stage = name;
    startButton.hidden = name !== "ready";
    download.hidden = name !== "saved";
    sourceButton.classList.toggle("recording-primary", name === "source");
    sourceButton.textContent = name === "ready" ? (desktop ? "Refresh preview" : "Change source") : name === "saved" ? "Record another take" : desktop ? "Preview Pilo" : "Choose tab or window";
    dialog.querySelector("#recording-next").textContent = name === "ready" ? "Ready. Recording starts after a 3-second countdown." : name === "saved" ? "Play your take above, or save the original video." : desktop ? "Step 1 · Click Preview Pilo to begin." : "Step 1 · Choose a tab or window in the browser picker.";
    var current = name === "ready" ? 2 : name === "saved" ? 3 : 1;
    dialog.querySelectorAll("[data-step]").forEach(function(item) {
      item.classList.toggle("current", Number(item.dataset.step) === current);
      item.classList.toggle("complete", Number(item.dataset.step) < current);
      if (Number(item.dataset.step) === current) item.setAttribute("aria-current", "step"); else item.removeAttribute("aria-current");
    });
    dialog.querySelector("#recording-empty-hint").textContent = desktop ? "Click Preview Pilo below. The app is selected automatically." : "Click Choose tab or window below, then choose your source in the browser picker.";
    dialog.querySelector("#recording-source-help").textContent = sourceMode.value === "interface" ? "Captures Pilo directly, without the embedded browser. No system picker is needed." : "Includes the embedded browser. macOS screen-recording permission is required.";
    if (name === "source") { dialog.querySelector("#recording-quality").hidden = true; dialog.classList.remove("recording-low-resolution"); }
  }
  sourceMode.onchange = function() { countdownToken++; release(); stage("source"); message("Source changed. Preview it before recording."); };
  stage("source");
  message(desktop ? "Click Preview Pilo to see exactly what will be recorded." : "Choose this Pilo tab to record its guided walkthrough.");
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
    if (narrationAbort) { narrationAbort.abort(); narrationAbort = null; }
    if (narration) { narration.stop(); narration = null; }
    clearTimeout(timer); stage("source");
    [stream, microphone].forEach(function(media) { if (media) media.getTracks().forEach(function(track) { track.stop(); }); });
    stream = microphone = null; ready = false;
    dialog.querySelector("#recording-empty").hidden = !!previewUrl; startButton.disabled = true;
  }
  async function fail(error) {
    countdownToken++; demoPreview = false; busy = false; controls(false); indicator.hidden = true; release();
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
      if (busy) return;
      release(); var selectionToken = ++countdownToken; sourceButton.disabled = true; message("Opening your source preview…");
      if (!config) await settings();
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia || !root.MediaRecorder) throw new Error("Screen capture is unavailable in this browser. Open the Pilo desktop app.");
      if (desktop) await root.openBotsDesktop.prepareScreenCapture(dialog.querySelector("#recording-source-mode").value);
      var selected = await navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: config.captureWidth }, height: { ideal: config.captureHeight }, resizeMode: "none", frameRate: config.fps }, audio: false });
      if (selectionToken !== countdownToken) { selected.getTracks().forEach(function(track) { track.stop(); }); return; }
      stream = selected;
      stream.getVideoTracks()[0].contentHint = "detail";
      if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
      video.removeAttribute("src"); video.controls = false; video.muted = true; video.srcObject = stream; await video.play();
      if (selectionToken !== countdownToken) return;
      if (desktop) {
        // Freeze a clean preview before reopening this self-captured dialog.
        // Encoding uses the source track directly, independent of this player.
        dialog.close();
        await new Promise(function(resolve) { setTimeout(resolve, 200); });
        video.pause();
        if (selectionToken !== countdownToken) return;
        if (!dialog.open) dialog.showModal();
      }
      download.hidden = true; dialog.querySelector("#recording-empty").hidden = true; ready = true; startButton.disabled = false;
      stream.getVideoTracks()[0].addEventListener("ended", function() {
        if (recorder && recorder.state !== "inactive") recorder.stop();
        else if (!demoPreview && (ready || busy)) fail(new Error("Screen sharing ended before the take started."));
      });
      stage("ready");
      var quality = dialog.querySelector("#recording-quality");
      quality.hidden = false; quality.textContent = video.videoWidth + " × " + video.videoHeight + " · Original source";
      var lowResolution = video.videoWidth < 1280 || video.videoHeight < 720;
      dialog.classList.toggle("recording-low-resolution", lowResolution);
      message(lowResolution ? "Preview ready. This source is small—enlarge the window or choose a higher-resolution source for sharper text." : "Preview ready. Confirm the source above, then click Start recording. Original resolution is preserved.");
    } catch (error) { if (selectionToken !== countdownToken) return; await fail(error); }
    finally { if (!busy) sourceButton.disabled = false; }
  };
  startButton.onclick = async function() {
    if (!ready || busy) return;
    try {
      var duration = Number(seconds.value);
      if (!Number.isInteger(duration) || duration < 1 || duration > config.maxSeconds) throw new Error("Choose a valid recording length.");
      if (dialog.querySelector("#recording-guided").checked && duration < 6) throw new Error("Choose at least 6 seconds for guided actions, or uncheck the guided walkthrough.");
      if (spoken.checked && !guided.checked) throw new Error("Enable the guided walkthrough to use spoken narration.");
      busy = true; controls(true); sourceButton.disabled = startButton.disabled = true;
      var preparationToken = ++countdownToken;
      duration = await loadNarration(duration, preparationToken);
      if (mic.checked) microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
      request = await api("", { durationSeconds: duration }); seenRequest = request.id;
      if (request.durationSeconds !== duration) { message("An existing request is active. Recording its requested " + request.durationSeconds + " seconds."); duration = request.durationSeconds; }
      if (narration && duration < narration.minimumSeconds) throw new Error("The active request is too short for this voice. Close it and start a longer take.");
      request = await api("/" + request.id + "/start");
      busy = true; startButton.disabled = true; sourceButton.disabled = true; seconds.disabled = mic.disabled = true;
      // Remove the source preview before the countdown so self-capture cannot
      // record a hall-of-mirrors frame from its own preview dialog.
      dialog.close(); indicator.hidden = false;
      if (dialog.querySelector("#recording-guided").checked && root.PiloGuidedDemo) tour = root.PiloGuidedDemo.prepare(tourOptions());
      var token = ++countdownToken;
      for (var n = 3; n > 0; n--) { indicator.querySelector("span").textContent = "Starting in " + n + "…"; await new Promise(function(resolve) { setTimeout(resolve, 1000); }); if (token !== countdownToken) return; }
      // Encode the captured video track directly. A fixed-size canvas would
      // resample text, discard Retina detail and add unnecessary borders.
      var captured = stream;
      var output = new MediaStream(captured.getVideoTracks());
      if (narration) {
        if (microphone) narration.addMicrophone(microphone);
        narration.stream.getAudioTracks().forEach(function(track) { output.addTrack(track); });
      } else if (microphone) microphone.getAudioTracks().forEach(function(track) { output.addTrack(track); });
      var mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find(function(type) { return MediaRecorder.isTypeSupported(type); });
      if (!mime) throw new Error("This browser cannot encode WebM video.");
      recorder = new MediaRecorder(output, { mimeType: mime, videoBitsPerSecond: config.bitrate }); chunks = []; var bytes = 0;
      recorder.ondataavailable = function(event) { if (event.data.size) { bytes += event.data.size; chunks.push(event.data); if (bytes > config.maxBytes && recorder.state !== "inactive") recorder.stop(); } };
      recorder.onerror = function(event) { fail(event.error || new Error("Video encoder failed.")); };
      var startedAt;
      recorder.onstop = async function() {
        clearTimeout(timer); indicator.hidden = true;
        var guidedResult = tour ? tour.report() : null;
        if (tour) { tour.stop(false); tour = null; }
        var blob = new Blob(chunks, { type: "video/webm" });
        if (root.PiloWebM) blob = new Blob([root.PiloWebM.setDuration(new Uint8Array(await blob.arrayBuffer()), performance.now() - startedAt)], { type: "video/webm" });
        output.getTracks().forEach(function(track) { track.stop(); });
        // Keep the source video until the encoder has delivered its final chunk.
        release(); video.srcObject = null; busy = false; controls(false); sourceButton.disabled = false; seconds.disabled = mic.disabled = false;
        previewUrl = URL.createObjectURL(blob); video.src = previewUrl; dialog.querySelector("#recording-empty").hidden = true; video.controls = true; video.muted = false;
        download.href = previewUrl; download.download = "pilo-screen-recording.webm"; download.hidden = false; stage("saved");
        dialog.querySelector("#recording-quality").hidden = false;
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
    } catch (error) { if (typeof preparationToken === "number" && preparationToken !== countdownToken && !busy) return; await fail(error); }
  };
  function finishPreview() {
    if (!demoPreview) return;
    demoPreview = false; countdownToken++; clearTimeout(timer);
    var report = tour && tour.report(); release(); busy = false; controls(false);
    sourceButton.disabled = false; seconds.disabled = mic.disabled = false;
    indicator.hidden = true;
    if (!dialog.open) dialog.showModal();
    message(report && report.failure ? report.failure : "Browser walkthrough finished. No screen was captured or model request sent.");
  }
  previewButton.onclick = async function() {
    if (busy) return;
    try {
      var duration = Number(seconds.value);
      if (!Number.isInteger(duration) || duration < 6 || duration > config.maxSeconds) throw new Error("Choose at least 6 seconds, within the configured recording limit.");
      busy = demoPreview = true; controls(true); startButton.disabled = sourceButton.disabled = true;
      var token = ++countdownToken; duration = await loadNarration(duration, token);
      if (token !== countdownToken) return;
      releaseSourceForPreview();
      dialog.close(); indicator.hidden = false;
      indicator.querySelector("span").textContent = "▶ Browser walkthrough";
      tour = root.PiloGuidedDemo.prepare(tourOptions()); tour.start(duration);
      timer = setTimeout(finishPreview, duration * 1000);
    } catch (error) { if (typeof token === "number" && token !== countdownToken && !busy) return; await fail(error); }
  };
  function releaseSourceForPreview() {
    ready = false;
    if (stream) stream.getTracks().forEach(function(track) { track.stop(); });
    stream = null; video.srcObject = null; dialog.querySelector("#recording-empty").hidden = !!previewUrl;
  }
  function stop() {
    if (demoPreview) { finishPreview(); return; }
    if (recorder && recorder.state !== "inactive") recorder.stop();
    else if (busy) fail(new Error("Recording canceled during countdown."));
  }
  indicator.querySelector("button").onclick = stop;
  dialog.querySelector("#recording-close").onclick = async function() {
    countdownToken++;
    busy = demoPreview = false;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    release(); dialog.close(); controls(false); sourceButton.disabled = false; seconds.disabled = mic.disabled = false;
    if (request && ["pending", "recording"].includes(request.state)) await api("/" + request.id + "/fail").catch(function() {});
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
  if (location.pathname === "/demo") { dialog.querySelector(".recording-advanced").open = true; open(); }
  poll();
})(window);
