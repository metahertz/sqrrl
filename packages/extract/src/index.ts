// @sqrrl/extract — bytes to text, for any connector.
//
// Documents (PDF with OCR of scanned pages, Office, HTML, plain text),
// images (vision model description and transcription, HEIC), and recordings
// (ffmpeg segmenting + an OpenAI-compatible transcription endpoint). Moved
// out of @sqrrl/connector-nextcloud so the Slack, email and calendar
// connectors can read attachments the same way (roadmap, Phase 2).

export * from "./ai.js"
export * from "./extract.js"
export * from "./markup.js"
export * from "./media.js"
export * from "./tools.js"
