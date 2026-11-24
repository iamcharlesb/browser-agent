# VoiceNote for macOS

VoiceNote is a small native macOS dictation app. It captures microphone audio, uses Apple Speech with `requiresOnDeviceRecognition` enabled, edits the transcript, and exports plain text. The app has no backend and does not send audio to an external transcription service. Recognition is segmented every 50 seconds to support longer sessions; device, language, or Speech framework limits can still interrupt a session, so 60 minutes is a ceiling, not a guarantee. Text is kept in memory until exported.

Pilo’s desktop UI also supports continuous browser dictation up to 60 minutes, with optional Deepgram / ElevenLabs keys in Settings when operators opt into cloud transcription. See `../voice-note-windows/` for the Windows native brief.

## Build and run locally

Requires macOS 14 or later and the macOS Command Line Tools. From this directory:

```sh
./Scripts/package-app.sh
open .build/VoiceNote.app
```

The package script builds a universal arm64/x86_64 app bundle with `clang` and ad-hoc signs it for local testing. This avoids the SwiftPM manifest failure and Swift SDK/compiler version mismatch in the current machine's Command Line Tools. The shipped entry point is `Sources/VoiceNoteMacApp/main.m`; the earlier SwiftUI prototype is not used by this package script.

First use requires microphone and speech-recognition access. If local recognition is unavailable for the selected language or Mac, the app reports an error rather than falling back to network transcription. Test airplane-mode behavior on each supported macOS/language combination before making an offline reliability claim.

## Known limits and release requirements

The 60-minute timer limits session length; it does not guarantee uninterrupted recognition. Automatic recovery from interruptions, draft persistence, and background recording are not implemented. Export regularly. The app needs microphone and speech-recognition usage strings in `Info.plist`.

The bundle is not Developer ID signed or notarized. Distribution requires a matching Xcode toolchain or validated release setup, a Developer ID identity, hardened-runtime/entitlement review, notarization, and a release test on supported Macs. Do not distribute this local ad-hoc build.
