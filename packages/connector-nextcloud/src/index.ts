export {
	type AiClient,
	AiUnavailableError,
	checkVerification,
	CAPTION_PROMPT,
	DOCUMENT_PAGE_PROMPT,
	HttpAiClient,
	NO_TEXT_MARKER,
	ResponseMismatchError,
	VERIFICATION_INSTRUCTION,
	type ImagePurpose,
} from "@sqrrl/extract"
export {
	ConfigError,
	loadConfigFromEnv,
	type NextcloudConnectorConfig,
} from "./config.js"
export {
	type ConnectorOptions,
	NextcloudConnector,
	partPath,
	slugForSourcePath,
	type SyncReport,
	type WikiWriter,
} from "./connector.js"
export {
	classify,
	EXTRACTOR_VERSION,
	extract,
	type ExtractResult,
	splitText,
} from "@sqrrl/extract"
export {
	categorySelected,
	type NextcloudNote,
	NextcloudNotes,
} from "./notes.js"
export {
	emptyState,
	type ItemState,
	loadState,
	saveState,
	type SyncState,
} from "./state.js"
export {
	type NextcloudFile,
	NextcloudHttpError,
	NextcloudWebDav,
	parseMultistatus,
} from "./webdav.js"
export {
	type Capabilities,
	discoverItems,
	needsSync,
	type WorkItem,
} from "./discovery.js"
export { type MediaOptions, transcribeRecording } from "@sqrrl/extract"
export {
	ensureStampFont,
	heicToPng,
	newVerificationCode,
	probeTools,
	renderPdfPage,
	resolveFfmpeg,
	splitRecording,
	stampImage,
	toVisionPng,
	type ToolStatus,
} from "@sqrrl/extract"
