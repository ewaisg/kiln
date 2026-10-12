type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

function recognitionCtor(): (new () => Recognition) | null {
  if (typeof window === "undefined") return null;
  const root = window as Window & { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return root.SpeechRecognition || root.webkitSpeechRecognition || null;
}

export function speechInputAvailable(): boolean {
  return recognitionCtor() !== null;
}

export function speechOutputAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export function startDictation(onText: (text: string) => void, onEnd?: () => void): { stop: () => void } {
  const Ctor = recognitionCtor();
  if (!Ctor) throw new Error("This browser has no speech recognition.");
  const recognition = new Ctor();
  recognition.lang = navigator.language || "en-US";
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.onresult = (event) => {
    const lines = Array.from(event.results).map((row) => row[0]?.transcript ?? "");
    onText(lines.join(" ").trim());
  };
  recognition.onerror = () => onEnd?.();
  recognition.onend = () => onEnd?.();
  recognition.start();
  return { stop: () => recognition.stop() };
}

export function speak(text: string, voiceURI?: string, rate = 1): void {
  if (!speechOutputAvailable()) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text.slice(0, 4000));
  utterance.lang = navigator.language || "en-US";
  if (voiceURI) utterance.voice = window.speechSynthesis.getVoices().find((voice) => voice.voiceURI === voiceURI) || null;
  utterance.rate = Math.max(0.5, Math.min(2, rate));
  window.speechSynthesis.speak(utterance);
}

export type AudioRecording = { stop: () => Promise<File>; cancel: () => void };
export async function recordAudio(): Promise<AudioRecording> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("Microphone recording requires a secure browser with MediaRecorder support.");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((type) => MediaRecorder.isTypeSupported(type));
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = []; let cancelled = false;
  const finished = new Promise<File>((resolve, reject) => {
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onerror = () => { clearTimeout(timer); stream.getTracks().forEach((track) => track.stop()); reject(new Error("Microphone recording failed.")); };
    recorder.onstop = () => {
      clearTimeout(timer); stream.getTracks().forEach((track) => track.stop());
      if (cancelled) { reject(new DOMException("Recording cancelled", "AbortError")); return; }
      const type = recorder.mimeType || "audio/webm";
      resolve(new File(chunks, `recording.${type.includes("mp4") ? "m4a" : "webm"}`, { type }));
    };
  });
  // Avoid an unhandled rejection if recording is cancelled before stop is awaited.
  void finished.catch(() => undefined);
  recorder.start(1000); const timer = setTimeout(() => { if (recorder.state !== "inactive") recorder.stop(); }, 120_000);
  return { stop: () => { if (recorder.state !== "inactive") recorder.stop(); return finished; }, cancel: () => { cancelled = true; if (recorder.state !== "inactive") recorder.stop(); } };
}

export function stopSpeaking(): void {
  if (speechOutputAvailable()) window.speechSynthesis.cancel();
}
