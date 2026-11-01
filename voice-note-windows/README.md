# VoiceNote for Windows

Windows counterpart to the macOS VoiceNote app: on-device speech-to-text for
sessions up to 60 minutes, without sending audio to a cloud service by default.

## Approach

Use the Windows Speech platform that matches the installed OS:

- **Windows 10/11**: `Windows.Media.SpeechRecognition` (UWP/WinRT) for
  continuous dictation with local recognition when the language pack supports it.
- **Fallback**: `System.Speech.Recognition` for older desktop targets.

Segment recognition every ~50 seconds (same pattern as macOS VoiceNote) so a
single long session does not hit engine timeouts. Cap the UI timer at
**60 minutes**. Export plain text; keep drafts in memory until export.

## Status

Scaffold only. The Electron/desktop Pilo UI already supports continuous browser
dictation up to 60 minutes, and optional Deepgram / ElevenLabs transcription
when the operator opts in with an API key in Settings.

A native WinUI / WPF VoiceNote app can reuse this README as the product brief.
Do not claim offline 60-minute reliability until a packaged app is tested on
target Windows builds with airplane-mode checks.

## Optional cloud path

If the operator is comfortable with cloud transcription, configure Deepgram or
ElevenLabs in Pilo Settings. Those keys stay on the local machine and are never
required for the on-device Windows Speech path.
