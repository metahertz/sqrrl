// @sqrrl/source-layer — Layer 1.
//
// Raw source items and the distillers that turn them into Layer 2 wiki
// pages: source pages, tasks with owners and due dates, and links to person
// and topic hubs.

export {
	CALENDAR_SOURCE,
	type CalendarAttendee,
	type CalendarEventMeta,
	DEFAULT_MAX_NEW_PEOPLE,
	distillCalendarEvents,
	EVENT_NOTES_MARKER,
	localTime,
	type MeetingDistillOptions,
	type MeetingDistillSummary,
	readEventMeta,
	renderMeetingPage,
	sourcePageSlug,
	transcriptTime,
} from "./calendar.js"
export {
	distillEmailThreads,
	type EmailDistillSummary,
	renderThread,
	threadPath,
} from "./email.js"
export {
	bulkReason,
	type MailAddress,
	type MailRecord,
	type MailSkipReason,
	mailToRawItem,
	messageIds,
	parseAddress,
	parseHeaders,
	stripQuoted,
	threadRoot,
} from "./mail-parse.js"
export {
	type DistillDeps,
	type DistillOptions,
	type DistillResult,
	type DistillTasksSummary,
	distillChangedSources,
} from "./distill.js"
export {
	carriedTaskState,
	type ExtractedTask,
	type GraphLinkResult,
	linkIngestedGraph,
	listTasksForSource,
	listTopicLabels,
	matchExistingTaskPage,
	renderTopicVocabulary,
	resolveTopicHub,
	syncTasksForSource,
	TASK_EXTRACTION_PROMPT,
	TASK_MATCH_THRESHOLD,
	type TaskExtractFn,
	type TaskExtractionResult,
	type TaskSyncResult,
	taskSimilarity,
	taskSlug,
	TOPIC_LEXICAL_THRESHOLD,
	TOPIC_SEMANTIC_THRESHOLD,
	topicSimilarity,
} from "./tasks.js"
export {
	buildRawPrefilter,
	ensureRawItemsSchema,
	getRawItemHistory,
	listCurrentRawItems,
	type RawSourceActivity,
	rawSourceActivity,
	listRawItemsInUnit,
	normalizeRawItem,
	RAW_ITEM_KINDS,
	RAW_ITEMS_MAX_BATCH,
	RAW_ITEMS_SEARCH_INDEX_TARGETS,
	RAW_SEARCH_MAX_LIMIT,
	type RawItemAttachment,
	type RawItemInput,
	type RawItemKind,
	RawItemValidationError,
	type RawItemView,
	rawContentHash,
	rawItemsCollection,
	type RawSearchParams,
	type RawSearchResult,
	RawSearchUnavailableError,
	type RawWriteReceipt,
	retireMissingRawItems,
	type RawWriteStatus,
	type RunInTransaction,
	searchRawItems,
	toRawItemView,
	upsertRawItems,
} from "./raw-items.js"
export {
	cleanName,
	isServiceEmail,
	nameKey,
	normalizeEmail,
	type ParsedRef,
	parseRef,
	partialMatches,
	type RefKind,
	splitRefs,
} from "./identity.js"
export {
	acceptIdentitySuggestion,
	dismissIdentitySuggestion,
	IdentityDecisionError,
	mergePersonHubs,
} from "./identity-decide.js"
export {
	countIdentitySuggestions,
	ensureIdentitySchema,
	getIdentitySuggestion,
	type IdentityCandidate,
	type IdentitySuggestion,
	type IdentitySuggestionKind,
	type IdentitySuggestionStatus,
	listIdentitySuggestions,
} from "./identity-suggestions.js"
export {
	type HubEntry,
	invalidatePeopleDirectory,
	matchPerson,
	nameFromEmail,
	type PersonRef,
	peopleDirectory,
	type ResolvedPerson,
	resolvePersonHub,
	slugify,
} from "./people.js"
export {
	getSelfIdentity,
	invalidateSelfIdentity,
	isSelfRef,
	type SelfIdentity,
	selfKeys,
} from "./self.js"
export {
	readSelfInput,
	type SelfApplyResult,
	SelfIdentityError,
	saveSelfIdentity,
} from "./self-identity.js"
export {
	DEFAULT_LINK_MAX_NEW_PEOPLE,
	type LinkPeopleInput,
	LinkPeopleError,
	type LinkPeopleResult,
	type LinkPerson,
	linkPeopleToPage,
	readLinkPeople,
} from "./people-link.js"
export {
	describeMentions,
	findPeopleMentions,
	type PersonMention,
} from "./people-mentions.js"
export {
	applyPeopleCleanup,
	type CleanupPlan,
	type CleanupResult,
	loadCleanupInput,
	planPeopleCleanup,
} from "./people-cleanup.js"
export {
	mergeRedactions,
	type RedactionResult,
	redactionCount,
	redactSecrets,
} from "./redact.js"
export * from "./task-review/index.js"
