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

export function speak(text: string): void {
  if (!speechOutputAvailable()) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text.slice(0, 4000));
  utterance.lang = navigator.language || "en-US";
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking(): void {
  if (speechOutputAvailable()) window.speechSynthesis.cancel();
}
