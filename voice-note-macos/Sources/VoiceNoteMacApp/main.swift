import AVFoundation
import Speech
import SwiftUI
import UniformTypeIdentifiers
import AppKit

@main
struct VoiceNoteMacApp: App {
    @StateObject private var model = DictationModel()

    var body: some Scene {
        WindowGroup {
            VoiceNoteView(model: model)
                .frame(minWidth: 680, minHeight: 580)
        }
        .windowResizability(.contentSize)
    }
}

@MainActor
final class DictationModel: ObservableObject {
    @Published var transcript = ""
    @Published var partialTranscript = ""
    @Published var status = "Ready. Start a session when you are ready to dictate."
    @Published var phase: Phase = .idle
    @Published var languageIdentifier = "en-US"
    @Published private(set) var elapsedSeconds = 0

    enum Phase: Equatable {
        case idle, requestingAccess, recording, paused, finished, failed
    }

    let sessionLimitSeconds = 60 * 60
    let languages: [(name: String, identifier: String)] = [
        ("English (US)", "en-US"),
        ("English (UK)", "en-GB"),
        ("Español", "es-ES"),
        ("Français", "fr-FR"),
        ("Deutsch", "de-DE"),
        ("हिन्दी", "hi-IN")
    ]

    private var engine: AVAudioEngine?
    private var speechRequest: SFSpeechAudioBufferRecognitionRequest?
    private var speechTask: SFSpeechRecognitionTask?
    private var recognizer: SFSpeechRecognizer?
    private var timer: Timer?
    private var tapInstalled = false

    var isRecording: Bool { phase == .recording }
    var isPaused: Bool { phase == .paused }

    var elapsedLabel: String {
        String(format: "%02d:%02d / 60:00", elapsedSeconds / 60, elapsedSeconds % 60)
    }

    func start() {
        guard phase != .recording && phase != .requestingAccess else { return }
        if elapsedSeconds >= sessionLimitSeconds {
            status = "The 60-minute session limit has been reached. Export your transcript."
            phase = .finished
            return
        }
        phase = .requestingAccess
        status = "Requesting microphone and speech recognition access…"
        Task {
            let speechAllowed = await requestSpeechAuthorization()
            guard speechAllowed else {
                phase = .failed
                status = "Speech recognition permission was not granted. Enable it in System Settings, then try again."
                return
            }
            let microphoneAllowed = await requestMicrophonePermission()
            guard microphoneAllowed else {
                phase = .failed
                status = "Microphone permission was not granted. Enable it in System Settings, then try again."
                return
            }
            beginAudioCapture()
        }
    }

    func pause() {
        guard phase == .recording else { return }
        stopAudioPipeline()
        timer?.invalidate()
        timer = nil
        phase = .paused
        status = "Paused. Resume to continue; export before quitting."
    }

    func resume() {
        guard phase == .paused else { return }
        beginAudioCapture()
    }

    func finish() {
        guard phase == .recording || phase == .paused || phase == .failed else { return }
        stopAudioPipeline()
        timer?.invalidate()
        timer = nil
        phase = .finished
        status = "Session finished. Export your transcript before closing."
    }

    func clearTranscript() {
        transcript = ""
        partialTranscript = ""
        status = "Transcript cleared."
    }

    func exportTranscript() {
        let content = [transcript, partialTranscript]
            .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .joined(separator: " ")
        guard !content.isEmpty else {
            status = "There is no transcript to export yet."
            return
        }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.plainText]
        panel.nameFieldStringValue = "VoiceNote-Transcript.txt"
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            try content.write(to: url, atomically: true, encoding: .utf8)
            status = "Transcript exported to \(url.lastPathComponent)."
        } catch {
            status = "Export failed: \(error.localizedDescription)"
        }
    }

    private func requestSpeechAuthorization() async -> Bool {
        let current = SFSpeechRecognizer.authorizationStatus()
        if current == .authorized { return true }
        guard current == .notDetermined else { return false }
        return await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status == .authorized)
            }
        }
    }

    private func requestMicrophonePermission() async -> Bool {
        if #available(macOS 14.0, *) {
            return await withCheckedContinuation { continuation in
                AVAudioApplication.requestRecordPermission { granted in
                    continuation.resume(returning: granted)
                }
            }
        }
        return false
    }

    private func beginAudioCapture() {
        guard let selectedRecognizer = SFSpeechRecognizer(locale: Locale(identifier: languageIdentifier)),
              selectedRecognizer.isAvailable else {
            phase = .failed
            status = "Speech recognition is unavailable for this language or network state."
            return
        }

        do {
            let audioEngine = AVAudioEngine()
            let input = audioEngine.inputNode
            let format = input.outputFormat(forBus: 0)
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            request.taskHint = .dictation

            recognizer = selectedRecognizer
            engine = audioEngine
            speechRequest = request
            speechTask = selectedRecognizer.recognitionTask(with: request) { [weak self] result, error in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    if let result {
                        if result.isFinal {
                            let finalText = result.bestTranscription.formattedString
                            if !finalText.isEmpty {
                                self.transcript = [self.transcript, finalText]
                                    .filter { !$0.isEmpty }
                                    .joined(separator: " ")
                            }
                            self.partialTranscript = ""
                        } else {
                            self.partialTranscript = result.bestTranscription.formattedString
                        }
                    }
                    if let error, self.phase == .recording {
                        self.stopAudioPipeline()
                        self.timer?.invalidate()
                        self.timer = nil
                        self.phase = .failed
                        self.status = "Speech recognition stopped: \(error.localizedDescription). Your completed transcript is still available."
                    }
                }
            }

            input.installTap(onBus: 0, bufferSize: 1_024, format: format) { buffer, _ in
                request.append(buffer)
            }
            tapInstalled = true
            audioEngine.prepare()
            try audioEngine.start()
            phase = .recording
            status = "Recording. Speech recognition may stop unexpectedly; export regularly."
            startTimer()
        } catch {
            stopAudioPipeline()
            phase = .failed
            status = "Could not start audio capture: \(error.localizedDescription)"
        }
    }

    private func startTimer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.phase == .recording else { return }
                self.elapsedSeconds += 1
                if self.elapsedSeconds >= self.sessionLimitSeconds {
                    self.finish()
                }
            }
        }
    }

    private func stopAudioPipeline() {
        timer?.invalidate()
        timer = nil
        if tapInstalled {
            engine?.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        engine?.stop()
        speechRequest?.endAudio()
        speechTask?.finish()
        speechRequest = nil
        speechTask = nil
        engine = nil
    }
}

struct VoiceNoteView: View {
    @ObservedObject var model: DictationModel
    @State private var showingClearConfirmation = false

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("VoiceNote")
                        .font(.system(size: 30, weight: .semibold, design: .rounded))
                    Text("Private, local-first dictation for up to 60 minutes")
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(model.elapsedLabel)
                    .font(.system(.title3, design: .monospaced).weight(.medium))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
                    .accessibilityLabel("Elapsed session time \(model.elapsedLabel)")
            }

            HStack(spacing: 10) {
                Button {
                    if model.isPaused { model.resume() } else { model.start() }
                } label: {
                    Label(model.isPaused ? "Resume" : "Start recording", systemImage: model.isPaused ? "play.fill" : "mic.fill")
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.isRecording || model.phase == .requestingAccess || model.phase == .finished)

                Button("Pause", systemImage: "pause.fill") { model.pause() }
                    .disabled(!model.isRecording)
                Button("Finish", systemImage: "stop.fill") { model.finish() }
                    .disabled(!(model.isRecording || model.isPaused || model.phase == .failed))

                Spacer()
                Picker("Recognition language", selection: $model.languageIdentifier) {
                    ForEach(model.languages, id: \.identifier) { language in
                        Text(language.name).tag(language.identifier)
                    }
                }
                .frame(width: 190)
                .disabled(model.isRecording)
            }

            Label(model.status, systemImage: model.isRecording ? "waveform" : "info.circle")
                .font(.callout)
                .foregroundStyle(model.phase == .failed ? Color.red : Color.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                .accessibilityLiveRegion(.polite)

            VStack(alignment: .leading, spacing: 8) {
                Text("TRANSCRIPT")
                    .font(.caption.weight(.semibold))
                    .tracking(1.2)
                    .foregroundStyle(.secondary)
                TextEditor(text: $model.transcript)
                    .font(.system(size: 15))
                    .scrollContentBackground(.hidden)
                    .padding(10)
                    .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(.quaternary, lineWidth: 1))
                    .accessibilityLabel("Editable transcript")
                if !model.partialTranscript.isEmpty {
                    Text(model.partialTranscript)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                        .accessibilityLabel("Interim speech recognition result")
                }
            }
            .frame(maxHeight: .infinity)

            HStack {
                Button("Clear") { showingClearConfirmation = true }
                    .disabled(model.transcript.isEmpty && model.partialTranscript.isEmpty)
                Spacer()
                Button("Export .txt", systemImage: "square.and.arrow.down") { model.exportTranscript() }
                    .disabled(model.transcript.isEmpty && model.partialTranscript.isEmpty)
            }

            Text("Speech recognition is provided by Apple and may process audio according to macOS settings. This app has no server and does not save automatically. Recognition can stop before 60 minutes; pause/resume or export regularly.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(24)
        .alert("Clear transcript?", isPresented: $showingClearConfirmation) {
            Button("Cancel", role: .cancel) { }
            Button("Clear", role: .destructive) { model.clearTranscript() }
        } message: {
            Text("This removes the in-memory transcript from this session. Export it first if you need a copy.")
        }
    }
}
