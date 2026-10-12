import { useEffect, useEffectEvent, useRef, useState } from "react";
import { ImagePlus, Mic, Square, Volume2, Video, Download, X } from "lucide-react";
import { useKiln } from "@/lib/store";
import { configuredMedia, mediaRequest, transcribeConfigured, type VideoJob } from "@/lib/media";
import { recordAudio, speak, stopSpeaking, type AudioRecording } from "@/lib/speech";
import { base64ToBlob } from "@/lib/images";
import { saveMedia, loadMedia } from "@/lib/library";
import type { Capability } from "@/lib/types";

const field = "h-11 w-full rounded-md border border-line bg-canvas px-3 text-sm";
const button =
  "press min-h-11 rounded-md border border-line px-4 text-sm font-medium disabled:opacity-50";
const capabilities: Capability[] = ["vision", "image", "transcription", "speech", "video"];
type Output = { id: string; type: "image" | "audio" | "video"; url: string; extension: string };

export function MediaPanel({
  onInsertTranscript,
}: {
  onInsertTranscript?: (text: string) => void;
}) {
  const endpoints = useKiln((state) => state.endpoints);
  const settings = useKiln((state) => state.settings);
  const updateSettings = useKiln((state) => state.updateSettings);
  const [tab, setTab] = useState<"image" | "audio" | "video">("image");
  const [prompt, setPrompt] = useState("");
  const [transcript, setTranscript] = useState("");
  const [voice, setVoice] = useState("alloy");
  const [size, setSize] = useState("1024x1024");
  const [videoSize, setVideoSize] = useState("1280x720");
  const [quality, setQuality] = useState("");
  const [seconds, setSeconds] = useState("4");
  const [trackJobs, setTrackJobs] = useState(false);
  const [file, setFile] = useState<File>();
  const [referencePreview, setReferencePreview] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [output, setOutput] = useState<Output>();
  const [jobs, setJobs] = useState<VideoJob[]>([]);
  const controller = useRef<AbortController | null>(null);
  const recorder = useRef<AudioRecording | null>(null);
  const outputUrl = useRef("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    try {
      const saved: unknown = JSON.parse(localStorage.getItem("kiln-video-jobs") || "[]");
      if (Array.isArray(saved))
        setJobs(
          saved
            .filter((job) => typeof job.id === "string" && typeof job.endpointId === "string")
            .slice(0, 20),
        );
    } catch {
      /* incompatible previous job metadata */
    }
    return () => {
      alive.current = false;
      controller.current?.abort();
      recorder.current?.cancel();
      if (outputUrl.current) URL.revokeObjectURL(outputUrl.current);
      stopSpeaking();
    };
  }, []);
  useEffect(() => {
    if (!file?.type.startsWith("image/")) {
      setReferencePreview("");
      return;
    }
    const url = URL.createObjectURL(file);
    setReferencePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  function saveJobs(next: VideoJob[]) {
    setJobs(next);
    localStorage.setItem(
      "kiln-video-jobs",
      JSON.stringify(
        next.map(({ id, status, progress, endpointId }) => ({ id, status, progress, endpointId })),
      ),
    );
  }
  function replaceJob(job: VideoJob) {
    setJobs((current) => {
      const next = [job, ...current.filter((item) => item.id !== job.id)].slice(0, 20);
      localStorage.setItem(
        "kiln-video-jobs",
        JSON.stringify(
          next.map(({ id, status, progress, endpointId }) => ({
            id,
            status,
            progress,
            endpointId,
          })),
        ),
      );
      return next;
    });
  }
  async function show(blob: Blob, type: Output["type"], id: string = crypto.randomUUID()) {
    await saveMedia(id, blob);
    if (outputUrl.current) URL.revokeObjectURL(outputUrl.current);
    outputUrl.current = URL.createObjectURL(blob);
    const extension = blob.type.includes("webm")
      ? "webm"
      : blob.type.includes("webp")
        ? "webp"
        : blob.type.includes("jpeg")
          ? "jpg"
          : type === "image"
            ? "png"
            : type === "video" || blob.type.includes("mp4")
              ? "mp4"
              : "mp3";
    setOutput({ id, type, url: outputUrl.current, extension });
  }
  async function run(task: (signal: AbortSignal) => Promise<void>) {
    if (busy) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError("");
    setStatus("Processing…");
    try {
      await task(abort.signal);
    } catch (err) {
      setStatus("");
      setError(
        abort.signal.aborted
          ? "Stopped. A submitted video job may still run at the provider; refresh its status to continue."
          : err instanceof Error
            ? err.message
            : "Media request failed.",
      );
    } finally {
      setBusy(false);
      controller.current = null;
    }
  }
  function choose(capability: Capability, endpointId: string, model?: string) {
    const previous = settings.mediaDefaults?.[capability];
    updateSettings({
      mediaDefaults: {
        ...settings.mediaDefaults,
        [capability]: { endpointId, model: model ?? previous?.model ?? "" },
      },
    });
  }
  async function transcribe(signal: AbortSignal, source = file) {
    if (!source) throw new Error("Select an audio file or record your microphone.");
    setTranscript(await transcribeConfigured(source, signal));
    setStatus("Transcript ready. Review and edit before sending.");
  }
  async function startRecording() {
    stopSpeaking();
    setError("");
    try {
      const recording = await recordAudio();
      if (!alive.current) {
        recording.cancel();
        return;
      }
      recorder.current = recording;
      setRecording(true);
      setStatus("Recording · up to two minutes. Stop to review or transcribe.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Microphone permission was denied.");
    }
  }
  async function finishRecording() {
    setRecording(false);
    try {
      const source = await recorder.current?.stop();
      if (source) {
        setFile(source);
        await show(source, "audio");
        setStatus("Recording ready. Transcribe to review your words.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Recording failed.");
    } finally {
      recorder.current = null;
    }
  }
  async function image(signal: AbortSignal) {
    const { endpoint, model } = configuredMedia("image");
    const response = await mediaRequest(
      endpoint,
      "image",
      { model, input: prompt, size, quality },
      file,
      signal,
    );
    const json = (await response.json()) as {
      mime?: string;
      data?: string | { b64_json?: string; url?: string }[];
    };
    let blob: Blob;
    if (typeof json.data === "string") blob = base64ToBlob(json.mime || "image/png", json.data);
    else {
      const item = json.data?.[0];
      if (item?.b64_json) blob = base64ToBlob("image/png", item.b64_json);
      else if (item?.url) {
        const res = await fetch(item.url, { signal, credentials: "omit" });
        if (!res.ok) throw new Error("Could not download the generated image.");
        blob = await res.blob();
      } else throw new Error("Provider returned no image.");
    }
    await show(blob, "image");
    setStatus("Image ready. Saved in this browser.");
  }
  async function speech(signal: AbortSignal) {
    const { endpoint, model } = configuredMedia("speech");
    const response = await mediaRequest(
      endpoint,
      "speech",
      { model, input: transcript || prompt, voice },
      undefined,
      signal,
    );
    await show(await response.blob(), "audio");
    setStatus("AI-generated speech ready.");
  }
  async function createVideo(signal: AbortSignal) {
    const { endpoint, model } = configuredMedia("video");
    const result = (await (
      await mediaRequest(
        endpoint,
        "video-create",
        { model, input: prompt, seconds, size: videoSize },
        file,
        signal,
      )
    ).json()) as VideoJob;
    if (!result.id) throw new Error("Provider returned no video job ID.");
    replaceJob({ ...result, endpointId: endpoint.id });
    setTrackJobs(true);
    setStatus(
      "Video submitted. Job status is saved and checked every 15 seconds while this panel is open.",
    );
  }
  async function refreshJob(job: VideoJob, signal: AbortSignal) {
    const endpoint = endpoints.find((item) => item.id === job.endpointId);
    if (!endpoint)
      throw new Error("The video provider was removed. Restore it to access this job.");
    const next = (await (
      await mediaRequest(endpoint, "video-status", { model: "", jobId: job.id }, undefined, signal)
    ).json()) as VideoJob;
    replaceJob({ ...next, endpointId: endpoint.id });
    if (next.status === "failed")
      throw new Error(next.error?.message || "Video generation failed at the provider.");
    if (next.status === "completed") {
      const content = await mediaRequest(
        endpoint,
        "video-content",
        { model: "", jobId: job.id },
        undefined,
        signal,
      );
      await show(await content.blob(), "video", job.id);
      setStatus("Video ready. Download a copy before the provider expires it.");
    } else
      setStatus(`Video ${next.status}${next.progress === undefined ? "" : ` · ${next.progress}%`}`);
  }
  async function removeJob(job: VideoJob, signal: AbortSignal) {
    const endpoint = endpoints.find((item) => item.id === job.endpointId);
    if (!endpoint) throw new Error("Restore the provider before removing this remote job.");
    await mediaRequest(endpoint, "video-delete", { model: "", jobId: job.id }, undefined, signal);
    saveJobs(jobs.filter((item) => item.id !== job.id));
    setStatus(
      "Video deleted at the provider. Deletion does not guarantee cancellation of rendering or billing.",
    );
  }
  async function restoreJob(job: VideoJob) {
    const blob = await loadMedia(job.id);
    if (blob) await show(blob, "video", job.id);
    else await run((signal) => refreshJob(job, signal));
  }
  const pollJob = useEffectEvent((job: VideoJob) => void run((signal) => refreshJob(job, signal)));
  // Effect Events intentionally are not dependencies (React 19.2; older hooks lint).
  useEffect(() => {
    if (!trackJobs || busy || tab !== "video") return;
    const job = jobs.find((item) => ["queued", "in_progress"].includes(item.status));
    if (!job) return;
    const timer = setTimeout(() => pollJob(job), 15_000);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- React 19.2 Effect Events are intentionally not dependencies.
  }, [trackJobs, jobs, busy, tab]);
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-medium">Media studio</h2>
        <p className="mt-2 text-sm text-muted">
          Create, listen, and understand. Media providers work independently of your chat model.
        </p>
      </div>
      <details
        className="rounded-lg border border-line p-4"
        open={!settings.mediaDefaults?.image && !settings.mediaDefaults?.transcription}
      >
        <summary className="cursor-pointer text-sm font-medium">Provider routing</summary>
        <p className="my-3 text-xs text-muted">
          Use exact model IDs from your provider. These are protocol adapters; model capability and
          account access are validated by the provider when you run a task. Add credentials in
          Providers. Custom media endpoints must implement the OpenAI media API.
        </p>
        <div className="flex flex-col gap-4">
          {capabilities.map((capability) => (
            <div key={capability} className="grid gap-2 sm:grid-cols-2">
              <label className="text-sm capitalize">
                {capability} provider
                <select
                  className={`${field} mt-1`}
                  value={settings.mediaDefaults?.[capability]?.endpointId || ""}
                  onChange={(event) => choose(capability, event.target.value)}
                >
                  <option value="">Choose provider</option>
                  {endpoints
                    .filter(
                      (endpoint) =>
                        capability === "vision" ||
                        ["openai", "grok", "custom", "lmstudio", "ollama"].includes(endpoint.kind),
                    )
                    .map((endpoint) => (
                      <option key={endpoint.id} value={endpoint.id}>
                        {endpoint.name}
                      </option>
                    ))}
                </select>
              </label>
              <label className="text-sm">
                Model ID
                <input
                  className={`${field} mt-1`}
                  value={settings.mediaDefaults?.[capability]?.model || ""}
                  onChange={(event) =>
                    choose(
                      capability,
                      settings.mediaDefaults?.[capability]?.endpointId || "",
                      event.target.value,
                    )
                  }
                  placeholder={`Your ${capability} model ID`}
                />
              </label>
            </div>
          ))}
        </div>
      </details>
      <div className="flex gap-2" role="tablist" aria-label="Media type">
        {(["image", "audio", "video"] as const).map((kind) => (
          <button
            className={`${button} flex-1 capitalize ${tab === kind ? "bg-accent text-accent-ink" : ""}`}
            role="tab"
            aria-selected={tab === kind}
            key={kind}
            onClick={() => {
              setTab(kind);
              setFile(undefined);
              setError("");
            }}
          >
            {kind}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-3">
        {tab !== "audio" ? (
          <label className="text-sm">
            {tab === "image" ? "Image prompt" : "Video prompt"}
            <textarea
              aria-label={tab === "image" ? "Image prompt" : "Video prompt"}
              className="mt-2 min-h-28 w-full rounded-md border border-line bg-canvas p-3"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Describe what you want to create…"
            />
          </label>
        ) : null}
        <label className="text-sm">
          {tab === "audio" ? "Audio upload" : "Optional reference image"}
          <input
            className={`${field} mt-2 py-2`}
            type="file"
            accept={tab === "audio" ? "audio/*" : "image/png,image/jpeg,image/webp"}
            onChange={(event) => setFile(event.target.files?.[0])}
          />
        </label>
        {file ? (
          <div className="flex items-center gap-3 text-sm text-muted">
            {referencePreview ? (
              <img
                className="h-16 w-16 rounded-md object-cover"
                src={referencePreview}
                alt="Reference preview"
              />
            ) : null}
            <span className="min-w-0 flex-1 truncate">
              {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB
            </span>
            <button
              className={button}
              onClick={() => setFile(undefined)}
              aria-label="Remove media file"
            >
              <X size={16} />
            </button>
          </div>
        ) : null}
        {tab === "image" ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm">
                Size
                <select
                  aria-label="Size"
                  className={`${field} mt-1`}
                  value={size}
                  onChange={(event) => setSize(event.target.value)}
                >
                  {["1024x1024", "1536x1024", "1024x1536"].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                Quality
                <select
                  aria-label="Quality"
                  className={`${field} mt-1`}
                  value={quality}
                  onChange={(event) => setQuality(event.target.value)}
                >
                  <option value="">Provider default</option>
                  {["low", "medium", "high"].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
            </div>
            <button
              className={`${button} flex items-center justify-center gap-2 bg-accent text-accent-ink`}
              disabled={busy || !prompt.trim()}
              onClick={() => void run(image)}
            >
              <ImagePlus size={16} />
              {file ? "Edit reference image" : "Generate image"}
            </button>
          </>
        ) : null}
        {tab === "audio" ? (
          <>
            <div className="flex flex-wrap gap-2">
              <button
                className={`${button} flex items-center gap-2`}
                disabled={busy}
                onClick={() => void (recording ? finishRecording() : startRecording())}
              >
                {recording ? <Square size={16} /> : <Mic size={16} />}
                {recording ? "Stop recording" : "Record microphone"}
              </button>
              <button
                className={button}
                disabled={busy || !file || recording}
                onClick={() => void run((signal) => transcribe(signal))}
              >
                Transcribe audio
              </button>
            </div>
            <label className="text-sm">
              Editable transcript / speech text
              <textarea
                aria-label="Editable transcript / speech text"
                className="mt-2 min-h-36 w-full rounded-md border border-line bg-canvas p-3"
                value={transcript}
                onChange={(event) => setTranscript(event.target.value)}
                placeholder="Your transcript appears here. You can also type text for speech."
              />
            </label>
            <label className="text-sm">
              Provider voice ID
              <input
                className={`${field} mt-1`}
                value={voice}
                onChange={(event) => setVoice(event.target.value)}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                className={`${button} flex items-center gap-2`}
                disabled={busy || !transcript.trim()}
                onClick={() => void run(speech)}
              >
                <Volume2 size={16} />
                Generate speech
              </button>
              <button
                className={button}
                disabled={!transcript.trim()}
                onClick={() => speak(transcript)}
              >
                Read with browser voice
              </button>
              <button
                className={button}
                onClick={() => {
                  stopSpeaking();
                  document.querySelectorAll("audio").forEach((audio) => audio.pause());
                }}
              >
                Interrupt playback
              </button>
              {onInsertTranscript ? (
                <button
                  className={button}
                  disabled={!transcript.trim()}
                  onClick={() => onInsertTranscript(transcript)}
                >
                  Use transcript in chat
                </button>
              ) : null}
            </div>
            <p className="text-xs text-muted">
              Microphone capture stays on this device until you select Transcribe. Generated speech
              is AI audio. Recording while listening interrupts browser speech.
            </p>
          </>
        ) : null}
        {tab === "video" ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm">
                Duration
                <select
                  aria-label="Duration"
                  className={`${field} mt-1`}
                  value={seconds}
                  onChange={(event) => setSeconds(event.target.value)}
                >
                  {["4", "8", "12"].map((value) => (
                    <option key={value} value={value}>
                      {value} seconds
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                Resolution
                <select
                  aria-label="Resolution"
                  className={`${field} mt-1`}
                  value={videoSize}
                  onChange={(event) => setVideoSize(event.target.value)}
                >
                  {["1280x720", "720x1280", "1792x1024", "1024x1792"].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
            </div>
            <p className="text-xs text-muted">
              Reference images must match the selected resolution. Generation uses your provider's
              async video API and may incur a charge. Model access, inputs, and available settings
              depend on your provider.
            </p>
            <button
              className={`${button} flex items-center justify-center gap-2 bg-accent text-accent-ink`}
              disabled={busy || !prompt.trim()}
              onClick={() => void run(createVideo)}
            >
              <Video size={16} />
              Submit video job
            </button>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={trackJobs}
                onChange={(event) => setTrackJobs(event.target.checked)}
              />
              Track pending jobs every 15 seconds
            </label>
            {jobs.map((job) => (
              <div key={job.id} className="rounded-md border border-line p-3">
                <p className="break-all text-xs text-muted">{job.id}</p>
                <p className="my-2 text-sm">
                  {job.status} {job.progress === undefined ? "" : `${job.progress}%`}
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    className={button}
                    disabled={busy}
                    onClick={() => void run((signal) => refreshJob(job, signal))}
                  >
                    Refresh status
                  </button>
                  {job.status === "completed" ? (
                    <button className={button} disabled={busy} onClick={() => void restoreJob(job)}>
                      Open saved video
                    </button>
                  ) : null}
                  <button
                    className={button}
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          "Delete this video at the provider? This cannot be undone and may not stop billing for a running job.",
                        )
                      )
                        void run((signal) => removeJob(job, signal));
                    }}
                  >
                    Delete remote video
                  </button>
                </div>
              </div>
            ))}
            <div className="rounded-md border border-line p-3 text-sm text-muted">
              To understand a video, attach it in chat. Kiln samples up to six timestamped frames
              for a vision model. This does not capture every moment or audio; transcribe an audio
              track separately for spoken content.
            </div>
          </>
        ) : null}
      </div>
      {busy ? (
        <button className={button} onClick={() => controller.current?.abort()}>
          Stop request
        </button>
      ) : null}
      {status ? (
        <p role="status" className="text-sm text-muted">
          {status}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-md border border-danger p-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {output ? (
        <div className="flex flex-col gap-3 rounded-lg border border-line p-3">
          {output.type === "image" ? (
            <img
              className="max-h-96 w-full rounded-md object-contain"
              src={output.url}
              alt={prompt || "Generated image"}
            />
          ) : output.type === "video" ? (
            <video className="w-full rounded-md" src={output.url} controls />
          ) : (
            <audio className="w-full" src={output.url} controls />
          )}
          <a
            className={`${button} flex items-center justify-center gap-2`}
            href={output.url}
            download={`kiln-${output.id}.${output.extension}`}
          >
            <Download size={16} />
            Download {output.type}
          </a>
        </div>
      ) : null}
    </div>
  );
}
