import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Mic, Square, Send, Volume2, X } from "lucide-react";
import { configuredMedia, mediaRequest, transcribeConfigured } from "@/lib/media";
import { recordAudio, stopSpeaking, type AudioRecording } from "@/lib/speech";

export function VoiceConversation({
  onSend,
  lastAssistant,
  busy,
}: {
  onSend: (text: string) => void;
  lastAssistant?: string;
  busy: boolean;
}) {
  const [enabled, setEnabled] = useState(false);
  const [recording, setRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [voice, setVoice] = useState("alloy");
  const [autoSpeak, setAutoSpeak] = useState(false);
  const recorder = useRef<AudioRecording | null>(null);
  const controller = useRef<AbortController | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const playbackUrl = useRef("");
  const previous = useRef(lastAssistant);
  const awaitingReply = useRef(false);
  const captureVersion = useRef(0);
  function interrupt() {
    captureVersion.current++;
    controller.current?.abort();
    recorder.current?.cancel();
    recorder.current = null;
    setRecording(false);
    setProcessing(false);
    audio.current?.pause();
    stopSpeaking();
    setStatus("Interrupted. You can record your next turn.");
  }
  useEffect(
    () => () => {
      captureVersion.current++;
      controller.current?.abort();
      recorder.current?.cancel();
      audio.current?.pause();
      if (playbackUrl.current) URL.revokeObjectURL(playbackUrl.current);
    },
    [],
  );
  async function readReply(reply: string) {
    if (!reply.trim()) return;
    const abort = new AbortController();
    controller.current?.abort();
    controller.current = abort;
    setProcessing(true);
    setError("");
    setStatus("Generating AI speech…");
    try {
      const { endpoint, model } = configuredMedia("speech");
      const response = await mediaRequest(
        endpoint,
        "speech",
        { model, input: reply, voice },
        undefined,
        abort.signal,
      );
      const blob = await response.blob();
      if (abort.signal.aborted) return;
      audio.current?.pause();
      if (playbackUrl.current) URL.revokeObjectURL(playbackUrl.current);
      playbackUrl.current = URL.createObjectURL(blob);
      const player = new Audio(playbackUrl.current);
      audio.current = player;
      player.onended = () => setStatus("Ready for your next turn.");
      await player.play();
      setStatus("Playing AI speech. Interrupt to speak.");
    } catch (err) {
      if (!abort.signal.aborted)
        setError(err instanceof Error ? err.message : "Speech playback failed.");
    } finally {
      if (controller.current === abort) {
        setProcessing(false);
        controller.current = null;
      }
    }
  }
  const speakReply = useEffectEvent((reply: string) => void readReply(reply));
  // Effect Events intentionally are not dependencies (React 19.2; older hooks lint).
  useEffect(() => {
    if (busy || lastAssistant === previous.current) return;
    previous.current = lastAssistant;
    if (enabled && autoSpeak && awaitingReply.current && lastAssistant) {
      awaitingReply.current = false;
      speakReply(lastAssistant);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- React 19.2 Effect Events are intentionally not dependencies.
  }, [lastAssistant, busy, enabled, autoSpeak]);
  async function capture() {
    interrupt();
    setError("");
    const version = captureVersion.current;
    try {
      configuredMedia("transcription");
      const recording = await recordAudio();
      if (version !== captureVersion.current) {
        recording.cancel();
        return;
      }
      recorder.current = recording;
      setRecording(true);
      setStatus("Recording. Stop to transcribe, then review your message.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open microphone.");
    }
  }
  async function finish() {
    const active = recorder.current;
    recorder.current = null;
    setRecording(false);
    if (!active) return;
    const abort = new AbortController();
    controller.current = abort;
    setProcessing(true);
    setStatus("Transcribing your recording…");
    try {
      const file = await active.stop();
      setText(await transcribeConfigured(file, abort.signal));
      setStatus("Review your transcript, then send.");
    } catch (err) {
      if (!abort.signal.aborted)
        setError(err instanceof Error ? err.message : "Transcription failed.");
    } finally {
      if (controller.current === abort) {
        setProcessing(false);
        controller.current = null;
      }
    }
  }
  const button = "min-h-11 rounded-md border border-line px-3 text-sm disabled:opacity-50";
  if (!enabled)
    return (
      <button
        type="button"
        className={`${button} flex items-center gap-2`}
        onClick={() => {
          setEnabled(true);
          previous.current = lastAssistant;
        }}
      >
        <Mic size={16} />
        Voice conversation
      </button>
    );
  return (
    <section
      aria-label="Voice conversation"
      className="flex flex-col gap-3 overflow-y-auto rounded-lg border border-line bg-elevated p-4"
      style={{ maxHeight: "40dvh" }}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-medium">Voice conversation</h3>
        <button
          type="button"
          aria-label="Close voice conversation"
          className={button}
          onClick={() => {
            interrupt();
            setEnabled(false);
          }}
        >
          <X size={16} />
        </button>
      </div>
      <p className="text-xs text-muted">
        Uses your separate transcription and speech providers from Media. Stopping a recording sends
        audio to transcription. Review every transcript before sending. Automatic reply audio may
        incur provider charges.
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={autoSpeak}
          onChange={(event) => setAutoSpeak(event.target.checked)}
        />
        Read new replies automatically
      </label>
      <label className="text-sm">
        Speech voice
        <input
          className="ml-2 min-h-11 rounded-md border border-line bg-canvas px-3"
          value={voice}
          onChange={(event) => setVoice(event.target.value)}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={`${button} flex items-center gap-2`}
          disabled={processing || busy}
          onClick={() => void (recording ? finish() : capture())}
        >
          {recording ? <Square size={16} /> : <Mic size={16} />}
          {recording ? "Stop and transcribe" : "Record next turn"}
        </button>
        <button type="button" className={button} onClick={interrupt}>
          Interrupt
        </button>
        <button
          type="button"
          className={`${button} flex items-center gap-2`}
          disabled={!lastAssistant || processing || busy}
          onClick={() => void readReply(lastAssistant || "")}
        >
          <Volume2 size={16} />
          Listen to reply
        </button>
      </div>
      <textarea
        aria-label="Review voice transcript"
        className="min-h-24 w-full rounded-md border border-line bg-canvas p-3"
        placeholder="Your editable transcript appears here…"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <button
        type="button"
        className={`${button} flex items-center justify-center gap-2 bg-accent text-accent-ink`}
        disabled={!text.trim() || busy || processing || recording}
        onClick={() => {
          awaitingReply.current = true;
          onSend(text.trim());
          setText("");
          setStatus("Waiting for chat reply…");
        }}
      >
        <Send size={16} />
        Send voice message
      </button>
      {status ? (
        <p role="status" className="text-xs text-muted">
          {status}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
