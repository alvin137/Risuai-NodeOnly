import type { OpenAIChat } from "./process.types";

export interface HypaV3Preset {
    name: string;
    settings: HypaV3Settings;
}

export interface HypaV3Settings {
    summarizationModel: string;
    summarizationPrompt: string;
    reSummarizationPrompt: string;
    memoryTokensRatio: number;
    extraSummarizationRatio: number;
    maxChatsPerSummary: number;
    recentMemoryRatio: number;
    similarMemoryRatio: number;
    enableSimilarityCorrection: boolean;
    preserveOrphanedMemory: boolean;
    processRegexScript: boolean;
    doNotSummarizeUserMessage: boolean;
    // Experimental
    useExperimentalImpl: boolean;
    summarizationRequestsPerMinute: number;
    summarizationMaxConcurrent: number;
    embeddingRequestsPerMinute: number;
    embeddingMaxConcurrent: number;
    alwaysToggleOn: boolean;
    queryChatCount: number;
}

interface HypaV3Data {
    summaries: Summary[];
    categories?: { id: string; name: string }[];
    lastSelectedSummaries?: number[]; // legacy
    metrics?: {
        lastImportantSummaries: number[];
        lastRecentSummaries: number[];
        lastSimilarSummaries: number[];
        lastRandomSummaries: number[];
    };
    modalSettings?: {
        displayMode: DisplayMode;
        displayRangeFrom: number;
        displayRangeTo: number;
        displayRecentCount: number;
        displayImportant: boolean;
        displaySelected: boolean;
    };
}

export interface SerializableHypaV3Data extends Omit<HypaV3Data, "summaries"> {
    summaries: SerializableSummary[];
}

interface Summary {
    text: string;
    chatMemos: Set<string>;
    isImportant: boolean;
    categoryId?: string;
    tags?: string[];
}

export interface SerializableSummary extends Omit<Summary, "chatMemos"> {
    chatMemos: string[];
}

interface SummaryChunk {
    text: string;
    summary: Summary;
}

export interface HypaV3Result {
    currentTokens: number;
    chats: OpenAIChat[];
    error?: string;
    memory?: SerializableHypaV3Data;
}

export interface SummaryItemState {
  originalRef: HTMLTextAreaElement;
  translationRef: HTMLTextAreaElement;
  rerolledTranslationRef: HTMLTextAreaElement;
  chatMemoRefs: HTMLButtonElement[];
}

export interface ExpandedMessageState {
  summaryIndex: number;
  selectedChatMemo: string;
  isTranslating: boolean;
  translation: string | null;
  translationRef: HTMLTextAreaElement;
}

export interface SearchState {
  ref: HTMLInputElement;
  query: string;
  results: SearchResult[];
  currentResultIndex: number;
  requestedSearchFromIndex: number;
  isNavigating: boolean;
}

export type SearchResult = SummarySearchResult | ChatMemoSearchResult;

export interface SummarySearchResult {
  type: "summary";
  summaryIndex: number;
  start: number;
  end: number;
}

export interface ChatMemoSearchResult {
  type: "chatmemo";
  summaryIndex: number;
  memoIndex: number;
}

export interface BulkResummaryState {
    isProcessing: boolean;
    result: string | null;
    selectedIndices: number[];
    mergedChatMemos: string[];
    isTranslating: boolean;
    translation: string | null;
}

// Category Management Types
export interface Category {
    id: string;
    name: string;
}

export interface CategoryManagerState {
    isOpen: boolean;
    editingCategory: Category | null;
    selectedCategoryFilter: string;
}

// Tag Management Types
export interface TagManagerState {
    isOpen: boolean;
    currentSummaryIndex: number;
    editingTag: string;
    editingTagIndex: number;
}

// Bulk Edit Types
export interface BulkEditState {
    isEnabled: boolean;
    selectedSummaries: Set<number>;
    selectedCategory: string;
    bulkSelectInput: string;
}

// Filter States
export interface FilterState {
    showImportantOnly: boolean;
    selectedCategoryFilter: string;
    isManualImportantToggle: boolean;
}

// UI States
export interface UIState {
    collapsedSummaries: Set<number>;
    dropdownOpen: boolean;
}

export const DISPLAY_MODE = {
  All: "All",
  Range: "Range",
  Recent: "Recent",
} as const;

export type DisplayMode = (typeof DISPLAY_MODE)[keyof typeof DISPLAY_MODE];
