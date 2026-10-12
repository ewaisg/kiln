# Media workflows

Add a provider and credentials in Providers, then open Media → Provider routing.
Select a separate endpoint and exact model ID for vision, images, transcription,
speech, and video. These choices are independent of the chat model; an in-browser
GGUF model can use a cloud vision or audio adapter without changing chat providers.

## Implemented protocols

- Transcription: OpenAI-compatible `POST /audio/transcriptions` with the actual
  uploaded file in multipart form data, selected model, JSON transcript response.
- Speech: `POST /audio/speech`, configurable voice ID, MP3 output. Text is limited
  to 4,096 characters per request. Generated speech is identified as AI audio.
- Images: `POST /images/generations`; reference edits use multipart
  `POST /images/edits` with actual `image[]` bytes. Model, size, and quality are
  configurable. Unsupported options return the provider's error, with no automatic
  retry that could create another paid generation.
- Video: OpenAI-compatible async `POST /videos`, status `GET /videos/{id}`,
  content `GET /videos/{id}/content`, delete `DELETE /videos/{id}`. Job IDs and
  endpoint IDs survive refresh; credentials are never included in job metadata.
  Status checks occur every 15 seconds while automatic tracking is enabled in
  the visible video panel. Downloaded output is stored in browser-managed storage.
  Stopping a web request does **not** cancel a submitted remote generation; remote
  deletion does not guarantee cancellation or reversal of billing.

OpenAI-compatible is a protocol requirement, not a claim that every provider or
model supports every feature. Add separate compatible endpoints where a chat
provider has no media API. Azure deployment-specific media paths and native xAI
video protocols are not implemented by this adapter. Account availability and
supported resolutions/voices/models must be verified with the provider.

## Attachments and understanding

Text and code are extracted locally (24,000 characters). PDF text is extracted
with PDF.js (up to 100 pages or 60,000 characters); DOCX raw text uses Mammoth.
Scanned PDFs without embedded text give a useful error rather than pretending
the model received document content. Convert scanned pages to images for vision.

Images are resized locally. Video understanding samples up to six browser-decoded
frames across the clip and includes timestamps. This is a clearly labelled sparse
sampling pipeline, **not** native continuous video perception. It cannot establish
events between frames or hear sound. Upload an audio track to transcription and
include the resulting transcript when spoken content matters. Unsupported codecs
produce an actionable decode error. Content and extracted text are marked as
untrusted material.

Audio attachments use the selected transcription provider. Voice conversation
records locally, transcribes on stop, allows transcript review, then sends only
on explicit action. Optional automatic reply speech uses the independently
selected TTS provider. Interrupt stops playback/capture and aborts active media
requests. Browser dictation and speech remain available when supported.

## Limits and privacy

The application bounds uploads to 24 MB and bounds streamed public relay requests
and responses. Hosting platforms may impose a lower request size limit; Vercel's
function payload limits can require smaller files or a separately deployed media
backend. Use direct local media endpoints for local servers; enable their CORS
access as appropriate. Public relay access is restricted to validated public
HTTPS hosts and rejects redirects/private addresses.

Production client preflight caps relayed file uploads at 4 MB, leaving multipart overhead under [Vercel's 4.5 MB request limit](https://vercel.com/docs/functions/limitations). Local development and direct endpoints retain the 24 MB app cap. Speech/video downloads stream with bounded byte counts so large responses do not require a buffered server payload; a server's duration or provider's download expiry may still interrupt them.

OpenAI reasoning chat models use a separate request profile with `max_completion_tokens` and provider sampling defaults. Custom endpoints and Azure deployment names can select it explicitly in Providers. Model parameter support still depends on the endpoint; [official OpenAI Chat Completions documentation](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) defines the supported fields.

Selecting a file or recording does not automatically upload it from the Media
studio. Transcribe/Generate submits content and your configured provider key to
the selected endpoint (through the server relay for public cloud APIs). Generated
files remain in browser-managed IndexedDB storage. Download copies you want to
retain outside this browser. Image/audio previews are object URLs that are cleaned
up when replaced or unmounted.

## Verification

`node --experimental-strip-types --test scripts/media-protocol.test.mjs` checks
multipart file bytes, independent model selection, image references, bounded
speech inputs, async video job paths, invalid inputs, and a local mock HTTP
transcription/speech server. These are protocol and mock checks; they do not
prove live provider entitlement, model availability, output quality, or billing.
No paid provider requests are made by the test suite. Live generation/transcription
checks require credentials and explicit authorization to spend provider quota.

Protocol sources: [Audio API](https://developers.openai.com/api/reference/resources/audio),
[image edits](https://developers.openai.com/api/reference/resources/images/methods/edit),
[video generation](https://developers.openai.com/api/docs/guides/video-generation).
