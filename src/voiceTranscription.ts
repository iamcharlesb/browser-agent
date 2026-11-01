/** Optional cloud transcription for long voice sessions (operator opt-in). */

export type TranscriptionProvider = "deepgram" | "elevenlabs";

export type TranscriptionResult = {
  text: string;
  provider: TranscriptionProvider;
};

const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

function decodeAudio(base64: string): Buffer {
  const trimmed = base64.trim();
  if (!trimmed || trimmed.length > MAX_AUDIO_BYTES * 2) throw new Error("Audio payload is empty or too large.");
  const buffer = Buffer.from(trimmed, "base64");
  if (!buffer.length || buffer.length > MAX_AUDIO_BYTES) throw new Error("Audio payload exceeds the 8 MB chunk limit.");
  return buffer;
}

export async function transcribeAudioChunk(input: {
  audioBase64: string;
  mimeType?: string;
  language?: string;
  deepgramApiKey?: string;
  elevenLabsApiKey?: string;
  fetchImpl?: typeof fetch;
}): Promise<TranscriptionResult> {
  const audio = decodeAudio(input.audioBase64);
  const mimeType = (input.mimeType || "audio/webm").split(";")[0].trim() || "audio/webm";
  const language = (input.language || "en").slice(0, 16);
  const fetchImpl = input.fetchImpl ?? fetch;

  if (input.deepgramApiKey?.trim()) {
    const url = new URL("https://api.deepgram.com/v1/listen");
    url.searchParams.set("model", "nova-2");
    url.searchParams.set("smart_format", "true");
    url.searchParams.set("punctuate", "true");
    if (language) url.searchParams.set("language", language);
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${input.deepgramApiKey.trim()}`,
        "Content-Type": mimeType
      },
      body: Uint8Array.from(audio)
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Deepgram transcription failed (${response.status}). ${detail.slice(0, 180)}`.trim());
    }
    const payload = await response.json() as {
      results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
    };
    const text = payload.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() || "";
    return { text, provider: "deepgram" };
  }

  if (input.elevenLabsApiKey?.trim()) {
    const form = new FormData();
    form.append(
      "file",
      new Blob([Uint8Array.from(audio)], { type: mimeType }),
      `chunk.${mimeType.includes("mp4") ? "m4a" : "webm"}`
    );
    form.append("model_id", "scribe_v1");
    if (language) form.append("language_code", language);
    const response = await fetchImpl("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": input.elevenLabsApiKey.trim() },
      body: form
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`ElevenLabs transcription failed (${response.status}). ${detail.slice(0, 180)}`.trim());
    }
    const payload = await response.json() as { text?: string };
    return { text: (payload.text || "").trim(), provider: "elevenlabs" };
  }

  throw new Error("Add a Deepgram or ElevenLabs API key in Settings to transcribe long voice recordings.");
}
