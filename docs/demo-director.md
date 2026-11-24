# Demo Director and screen recording

Pilo includes a real screen recorder. Type **/record 10** in the composer or click **Record screen** beside the microphone. This opens the recorder without a model request.

1. Click **Preview Pilo** in the desktop app, or **Choose tab or window** in a browser. In Pilo Desktop, use **More options → Capture source** to choose Pilo app (without the embedded browser) or Entire window (includes the embedded browser and needs OS permission). In a browser, use the system picker.
2. Review the live preview. Remove private information and credentials from the source window. Optionally enable microphone narration.
3. Choose the length and click **Start recording**. A three-second countdown gives you time to prepare.
4. Leave **Run guided Pilo walkthrough** checked to click through the real bot catalog, select/add Demo Director, open workspace tools, and read Help. The pointer and captions explain each action. Existing conversation text and draft text are hidden during the tour. Keyboard or mouse input immediately stops automation; recording continues for manual operation. Uncheck it to perform your own workflow. Capture stops after the chosen duration, or use **Stop** to finish early.

The guided tour uses local UI controls and never submits a prompt or calls a model. Choose the Pilo interface/window as the source; an unrelated selected window will not show the actions. Existing drafts are preserved and the original bot is restored after an uninterrupted tour.
5. Play the actual take in the recorder and download the **WebM video**. Recordings are saved locally as video artifacts and can be reopened in Pilo.

The captured video track is encoded directly at its source resolution and aspect ratio, with no canvas resizing, borders or artificial upscaling. The preview shows the actual source dimensions and warns if they are small. Capture requests up to 4K detail from the source by default, and the encoder defaults to 24 Mbps with VP9 preferred. Actual source/device capabilities and environment settings determine the result; enlarge the app window for legible UI text. Automatic zoom, trimming, caption generation and MP4 conversion are not included.

## Demo Director bot

Choose Demo Director from the catalog or tag **@Demo Director**. Ask “Record a 10-second screen demo of Pilo.” The record_screen tool opens a pending capture request; the user still previews the source and starts capture. In restricted consultations the bot points to **/record 10** or the Record screen button. Scripts and storyboards are produced only when requested.

## Permissions and storage

macOS may require Pilo to be enabled under System Settings → Privacy & Security → Screen & System Audio Recording, followed by restarting the app. Microphone narration needs its own permission. A denied request produces no video. Closing the recorder before capture cancels it. Starting capture is not permission to publish or run a paid model workflow.

BROWSER_AGENT_RECORDING_MAX_SECONDS, BROWSER_AGENT_RECORDING_MAX_BYTES, BROWSER_AGENT_RECORDING_BITRATE, BROWSER_AGENT_RECORDING_FPS, BROWSER_AGENT_RECORDING_CAPTURE_WIDTH, BROWSER_AGENT_RECORDING_CAPTURE_HEIGHT and BROWSER_AGENT_RECORDING_POLL_MS configure limits and the zero-model pending-request check. Defaults are 120 seconds, 100 MB, 24 Mbps, 30 fps, 3840×2160 preferred capture and 2000 ms. Video stays in local artifacts; the feature does not publish it externally.

## Browser playback and spoken guide

Open **http://127.0.0.1:8766/demo** in your browser while Pilo is running. Click **More options → Try walkthrough without recording** to run the real local UI demo without screen-sharing permissions or creating a recording. This is the Pilo interface served by your local app, not a publicly hosted demo. Clicking or typing stops the guided actions; Stop ends playback.

Enable **Voiceover** for scene narration. It is synthesized locally on the Pilo host using macOS speech, or eSpeak on Linux, and played through the browser. The control selects a 20-second take to leave room for natural speech. The length automatically increases when the selected local voice needs more time. If that exceeds the configured recording limit, disable narration or increase the limit. On unsupported hosts, disable speech to run silently. No cloud voice API or API key is used.

When recording, speech is mixed directly into the WebM audio track, alongside an optional microphone. No system-audio sharing is needed. BROWSER_AGENT_DEMO_VOICE selects an installed local voice, BROWSER_AGENT_DEMO_SPEECH_RATE sets words per minute (default 180), and BROWSER_AGENT_DEMO_SPEECH_TIMEOUT_MS bounds each synthesis (default 15000). Only the four built-in scene lines can be synthesized through this endpoint. A narrator failure is shown before playback/capture starts.
