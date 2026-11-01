import assert from "node:assert/strict";
import { it } from "node:test";
import { transcribeAudioChunk } from "./voiceTranscription";

it("rejects empty or oversized audio payloads", async () => {
  await assert.rejects(transcribeAudioChunk({ audioBase64: "", deepgramApiKey: "k" }), /empty or too large/);
  await assert.rejects(transcribeAudioChunk({ audioBase64: "QQ==", }), /Deepgram or ElevenLabs/);
});

it("uses Deepgram when a key is present", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const result = await transcribeAudioChunk({
    audioBase64: Buffer.from("fake-audio").toString("base64"),
    mimeType: "audio/webm",
    deepgramApiKey: "dg-test",
    fetchImpl: (async (url, init) => {
      calls.push({ url: String(url), init });
      return {
        ok: true,
        async json() {
          return { results: { channels: [{ alternatives: [{ transcript: " hello world " }] }] } };
        },
        async text() { return ""; }
      } as Response;
    }) as typeof fetch
  });
  assert.equal(result.provider, "deepgram");
  assert.equal(result.text, "hello world");
  assert.equal(calls[0]?.url.includes("api.deepgram.com"), true);
  assert.equal((calls[0]?.init?.headers as Record<string, string>).Authorization, "Token dg-test");
});

it("falls back to ElevenLabs when only that key is present", async () => {
  const result = await transcribeAudioChunk({
    audioBase64: Buffer.from("fake-audio").toString("base64"),
    elevenLabsApiKey: "el-test",
    fetchImpl: (async (_url, init) => {
      assert.equal((init?.headers as Record<string, string>)["xi-api-key"], "el-test");
      return {
        ok: true,
        async json() { return { text: "eleven labs text" }; },
        async text() { return ""; }
      } as Response;
    }) as typeof fetch
  });
  assert.equal(result.provider, "elevenlabs");
  assert.equal(result.text, "eleven labs text");
});
