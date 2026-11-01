#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
SDKROOT=$(xcrun --sdk macosx --show-sdk-path)
APP="$ROOT/.build/VoiceNote.app"
BINARY="$APP/Contents/MacOS/VoiceNoteMac"

mkdir -p "$APP/Contents/MacOS"
clang -fobjc-arc -fmodules \
  -arch arm64 -arch x86_64 -mmacosx-version-min=14.0 \
  -isysroot "$SDKROOT" \
  Sources/VoiceNoteMacApp/main.m \
  -framework AppKit -framework AVFoundation -framework Speech \
  -framework UniformTypeIdentifiers \
  -o "$BINARY"
cp Info.plist "$APP/Contents/Info.plist"
/usr/bin/codesign --force --sign - --timestamp=none "$APP"
printf 'Built local app bundle: %s\n' "$APP"
printf '%s\n' 'Ad-hoc signed for local testing only; not Developer ID signed or notarized.'
