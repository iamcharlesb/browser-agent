# Demo Director and screen recording

Pilo includes a real screen recorder. Type **/record 10** in the composer or click **Record screen** beside the microphone. This opens the recorder without a model request.

1. Choose the capture source. In Pilo Desktop, choose Pilo interface (the app UI without the embedded browser) or Entire Pilo window (includes the embedded browser and needs OS permission). In a browser, use the system picker.
2. Review the live preview. Remove private information and credentials from the source window. Optionally enable microphone narration.
3. Choose the length and click **Start recording**. A three-second countdown gives you time to prepare.
4. Perform the real workflow. Capture stops after the chosen duration, or use **Stop** to finish early.
5. Play the actual take in the recorder and download the **WebM video**. Recordings are saved locally as video artifacts and can be reopened in Pilo.

The output is a 1920×1080 presentation frame containing the actual selected source at its original aspect ratio. Lower resolution sources are scaled; this does not add source detail. Automatic zoom, trimming, caption generation and MP4 conversion are not included.

## Demo Director bot

Choose Demo Director from the catalog or tag **@Demo Director**. Ask “Record a 10-second screen demo of Pilo.” The record_screen tool opens a pending capture request; the user still previews the source and starts capture. In restricted consultations the bot points to **/record 10** or the Record screen button. Scripts and storyboards are produced only when requested.

## Permissions and storage

macOS may require Pilo to be enabled under System Settings → Privacy & Security → Screen & System Audio Recording, followed by restarting the app. Microphone narration needs its own permission. A denied request produces no video. Closing the recorder before capture cancels it. Starting capture is not permission to publish or run a paid model workflow.

BROWSER_AGENT_RECORDING_MAX_SECONDS, BROWSER_AGENT_RECORDING_MAX_BYTES, BROWSER_AGENT_RECORDING_BITRATE, BROWSER_AGENT_RECORDING_FPS and BROWSER_AGENT_RECORDING_POLL_MS configure limits and the zero-model pending-request check. Defaults are 120 seconds, 100 MB, 8 Mbps, 30 fps and 2000 ms. Video stays in local artifacts; the feature does not publish it externally.
