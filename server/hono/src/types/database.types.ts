import type { ColorScheme } from './colorscheme.types'
import type { Hotkey } from './hotkey.types'
import type { HypaModel } from './hypamemory.types'
import type { HypaV3Preset, HypaV3Settings, SerializableHypaV3Data } from './hypav3.types'
import type { Loadout } from './loadout.types'
import type { LLMFlags, LLMFormat, LLMTokenizer } from './model.types'
import type { RisuModule } from './modules.types'
import type { NAISettings } from './nai.types'
import type { OobaChatCompletionRequestParams } from './ooba.types'
import type { RisuPlugin } from './plugins.types'
import type { TranslatorPreset } from './presets.types'
import type { OnnxModelFiles, OpenAIChat } from './process.types'
import type { PromptItem, PromptSettings } from './prompt.types'
import type { triggerscript } from './trigger.types'

export interface DynamicOutput {
    autoAdjustSchema: boolean
    dynamicMessages: boolean
    dynamicMemory: boolean
    dynamicResponseTiming: boolean
    dynamicOutputPrompt: boolean
    showTypingEffect: boolean
    dynamicRequest: boolean
}

export interface Database{
    characters: character[],
    apiType: string
    openAIKey: string
    proxyKey:string
    mainPrompt: string
    jailbreak: string
    globalNote:string
    temperature: number
    maxContext: number
    maxResponse: number
    frequencyPenalty: number
    PresensePenalty: number
    formatingOrder: FormatingOrderItem[]
    aiModel: string
    jailbreakToggle:boolean
    loreBookDepth: number
    loreBookToken: number,
    cipherChat: boolean,
    loreBook: {
        name:string
        data:loreBook[]
    }[]
    loreBookPage: number
    username: string
    userIcon: string
    userNote: string
    additionalPrompt: string
    descriptionPrefix: string
    forceReplaceUrl: string
    language: string
    translator: string
    plugins: RisuPlugin[]
    currentPluginProvider: string
    zoomsize:number
    customBackground:string
    textgenWebUIStreamURL:string
    textgenWebUIBlockingURL:string
    autoTranslate: boolean
    fullScreen:boolean
    playMessage:boolean
    iconsize:number
    theme: string
    nodeOnlyStandardChatWidth: 'standard' | 'wide' | 'full'
    subModel:string
    emotionPrompt: string,
    formatversion:number
    waifuWidth:number
    waifuWidth2:number
    botPresets:botPreset[]
    botPresetsId:number
    themePresets:themePreset[]
    themePresetsId:number
    togglePresets?:TogglePreset[]
    sdProvider: string
    webUiUrl:string
    sdSteps:number
    sdCFG:number
    sdConfig:sdConfig
    NAIImgUrl:string
    NAIApiKey:string
    NAIImgModel:string
    NAII2I:boolean
    NAIREF:boolean
    NAIImgConfig:NAIImgConfig
    ttsAutoSpeech?:boolean
    promptPreprocess:boolean
    bias: [string, number][]
    swipe:boolean
    confirmReroll:boolean
    textTheme: string
    customTextTheme: {
        FontColorStandard: string,
        FontColorBold : string,
        FontColorItalic : string,
        FontColorItalicBold : string,
        FontColorQuote1 : string,
        FontColorQuote2 : string
    }
    requestRetrys:number
    emotionPrompt2:string
    useSayNothing:boolean
    didFirstSetup: boolean
    showUnrecommended:boolean
    allowV2Plugin:boolean
    elevenLabKey:string
    voicevoxUrl:string
    useExperimental:boolean
    showMemoryLimit:boolean
    roundIcons:boolean
    useStreaming:boolean
    voyageApiKey:string
    supaMemoryKey:string
    textScreenColor?:string
    textBorder?:boolean
    textScreenRounded?:boolean
    textScreenBorder?:string
    characterOrder:(string|folder)[]
    hordeConfig:hordeConfig,
    novelai:{
        token:string,
        model:string
    }
    globalscript: customscript[],
    sendWithEnter:boolean
    fixedChatTextarea:boolean
    clickToEdit: boolean
    enableBlockPartialEdit: boolean
    enableDragPartialEdit: boolean
    koboldURL:string
    useAutoSuggestions:boolean
    autoSuggestPrompt:string
    autoSuggestPrefix:string
    autoSuggestClean:boolean
    claudeAPIKey:string,
    useChatCopy:boolean,
    novellistAPI:string,
    useAutoTranslateInput:boolean
    imageCompression:boolean
    inlayImageLossless:boolean
    inlayImagePriority:boolean
    account?:{
        token:string
        id:string,
        data: {
            refresh_token?:string,
            access_token?:string
            expires_in?: number
        }
        useSync?:boolean
    },
    classicMaxWidth: boolean,
    useChatSticker:boolean,
    useAdditionalAssetsPreview:boolean,
    usePlainFetch:boolean
    localNetworkMode:boolean
    localNetworkTimeoutSec:number
    memoryAlgorithmType:string // To enable new memory module/algorithms
    proxyRequestModel:string
    ooba:OobaSettings
    ainconfig: AINsettings
    personaPrompt:string
    openrouterRequestModel:string
    openrouterKey:string
    openrouterMiddleOut:boolean
    nanogptKey:string
    nanogptRequestModel:string
    nanogptRequestModelName:string
    nanogptProvider:string
    nanogptSubscriptionState:string
    nanogptUseSubscriptionEndpoint:boolean
    openrouterFallback:boolean
    selectedPersona:number
    personas:{
        personaPrompt:string
        name:string
        icon:string
        largePortrait?:boolean
        id?:string
        note?:string
    }[]
    personaNote:boolean
    assetWidth:number
    animationSpeed:number
    botSettingAtStart:false
    NAIsettings:NAISettings
    hideRealm:boolean
    colorScheme:ColorScheme
    colorSchemeName:string
    promptTemplate?:PromptItem[]
    forceProxyAsOpenAI?:boolean
    hypaModel:HypaModel
    saveTime?:number
    mancerHeader:string
    emotionProcesser:'submodel'|'embedding',
    showMenuChatList?:boolean,
    translatorType:'google'|'deepl'|'none'|'llm'|'deeplX'|'bergamot',
    translatorInputLanguage?:string
    htmlTranslation?:boolean,
    NAIadventure?:boolean,
    NAIappendName?:boolean,
    deeplOptions:{
        key:string,
        freeApi:boolean
    }
    deeplXOptions:{
        url:string,
        token:string    
    }
    localStopStrings?:string[]
    autofillRequestUrl:boolean
    customProxyRequestModel:string
    generationSeed:number
    newOAIHandle:boolean
    gptVisionQuality:string
    reverseProxyOobaMode:boolean
    reverseProxyOobaArgs: OobaChatCompletionRequestParams
    huggingfaceKey:string
    fishSpeechKey:string
    allowAllExtentionFiles?:boolean
    translatorPrompt:string
    translatorMaxResponse:number
    translatorPresets: TranslatorPreset[]
    translatorPresetId: number
    top_p: number,
    google: {
        accessToken: string
        projectId: string
    }
    mistralKey?:string
    chainOfThought?:boolean
    genTime:number
    promptSettings: PromptSettings
    top_k:number
    repetition_penalty:number
    min_p:number
    top_a:number
    claudeAws:boolean
    lastPatchNoteCheckVersion?:string,
    memoryLimitThickness?:number
    modules: RisuModule[]
    enabledModules: string[]
    sideMenuRerollButton?:boolean
    requestInfoInsideChat?:boolean
    additionalParams:[string, string][]
    heightMode:string
    noWaitForTranslate:boolean
    antiClaudeOverload:boolean
    ollamaURL:string
    ollamaModel:string
    autoContinueChat:boolean
    autoContinueMinTokens:number
    removeIncompleteResponse:boolean
    customTokenizer:string
    instructChatTemplate:string
    JinjaTemplate:string
    openrouterProvider: {
        order: string[]
        only: string[]
        ignore: string[]
    }
    useInstructPrompt:boolean
    textAreaSize:number
    sideBarSize:number
    textAreaTextSize:number
    combineTranslation:boolean
    dynamicAssets:boolean
    dynamicAssetsEditDisplay:boolean
    customPromptTemplateToggle:string
    globalChatVariables:{[key:string]:string}
    templateDefaultVariables:string
    cohereAPIKey:string
    goCharacterOnImport:boolean
    dallEQuality:string
    font: string
    customFont: string
    lineHeight: number
    stabilityModel: string
    stabilityKey: string
    stabllityStyle: string
    legacyTranslation: boolean
    comfyConfig: ComfyConfig
    comfyUiUrl: string
    useLegacyGUI: boolean
    claudeCachingExperimental: boolean
    hideApiKey: boolean
    unformatQuotes: boolean
    enableDevTools: boolean
    falToken: string
    falModel: string
    falLora: string
    falLoraName: string
    falLoraScale: number
    moduleIntergration: string
    customCSS: string
    betaMobileGUI:boolean
    jsonSchemaEnabled:boolean
    jsonSchema:string
    strictJsonSchema:boolean
    extractJson:string
    statics: {
        messages: number
        imports: number
    }
    customQuotes:boolean
    customQuotesData?:[string, string, string, string]
    groupTemplate?:string
    groupOtherBotRole?:string
    guiHTML:string
    OAIPrediction:string
    customAPIFormat:LLMFormat
    systemContentReplacement:string
    systemRoleReplacement:'user'|'assistant'
    vertexPrivateKey: string
    vertexClientEmail: string
    vertexAccessToken: string
    vertexAccessTokenExpires: number
    vertexRegion: string
    seperateParametersEnabled:boolean
    seperateParameters:{
        memory: SeparateParameters,
        emotion: SeparateParameters,
        translate: SeparateParameters,
        otherAx: SeparateParameters
        overrides: Record<string, SeparateParameters>
    }
    translateBeforeHTMLFormatting:boolean
    autoTranslateCachedOnly:boolean
    lightningRealmImport:boolean
    notification: boolean
    customFlags: LLMFlags[]
    enableCustomFlags: boolean
    googleClaudeTokenizing: boolean
    presetChain: string
    legacyMediaFindings?:boolean
    geminiStream?:boolean
    assetMaxDifference:number
    auxModelUnderModelSettings:boolean
    showModelInSidebar:boolean
    showPresetInSidebar:boolean
    showPersonaInSidebar:boolean
    disableMobileDragDrop:boolean
    disableToggleBinding:boolean
    hideLoadout:boolean
    hideEasyPanel:boolean
    menuSideBar:boolean
    pluginV2: RisuPlugin[]
    showSavingIcon:boolean
    presetRegex: customscript[]
    banCharacterset:string[]
    showPromptComparison:boolean
    hypaV3:boolean
    hypaV3Settings: HypaV3Settings // legacy
    hypaV3Presets: HypaV3Preset[]
    hypaV3PresetId: number
    realmDirectOpen:boolean
    OaiCompAPIKeys: {[key:string]:string}
    inlayErrorResponse:boolean
    reasoningEffort:number
    bulkEnabling:boolean
    showTranslationLoading: boolean
    showDeprecatedTriggerV1:boolean
    showDeprecatedTriggerV2:boolean
    returnCSSError:boolean
    checkCorruption?: boolean
    toggleConfirmRecommendedPreset?: boolean
    useExperimentalGoogleTranslator:boolean
    thinkingTokens: number
    thinkingType: 'off' | 'budget' | 'adaptive'
    adaptiveThinkingEffort: 'low' | 'medium' | 'high' | 'max'
    antiServerOverloads: boolean
    hypaCustomSettings: {
        url: string,
        key: string,
        model: string,       
    },
    localActivationInGlobalLorebook: boolean
    showFolderName: boolean
    automaticCachePoint: boolean
    chatCompression: boolean
    claudeRetrivalCaching: boolean
    outputImageModal: boolean
    playMessageOnTranslateEnd:boolean
    seperateModelsForAxModels:boolean
    seperateModels:{
        memory: string
        emotion: string
        translate: string
        otherAx: string
    }
    doNotChangeSeperateModels:boolean
    modelTools: string[]
    hotkeys:Hotkey[]
    fallbackModels: {
        memory: string[],
        emotion: string[],
        translate: string[],
        otherAx: string[]
        model: string[]
    }
    doNotChangeFallbackModels: boolean
    fallbackWhenBlankResponse: boolean
    customModels: {
        id: string
        internalId: string
        url: string
        format: LLMFormat
        tokenizer: LLMTokenizer
        key: string
        name: string
        params: string
        flags: LLMFlags[]
    }[]
    igpPrompt:string
    useTokenizerCaching:boolean
    showMenuHypaMemoryModal:boolean
    authRefreshes:{
        url:string
        tokenUrl:string
        refreshToken:string
        clientId:string
        clientSecret:string
    }[]
    promptInfoInsideChat:boolean
    promptTextInfoInsideChat:boolean
    claudeBatching:boolean
    claude1HourCaching:boolean
    rememberToolUsage:boolean
    simplifiedToolUse:boolean
    requestLocation:string
    newImageHandlingBeta?: boolean
    showFirstMessagePages:boolean
    streamGeminiThoughts:boolean
    verbosity:number
    dynamicOutput?:DynamicOutput
    hubServerType?:string
    pluginCustomStorage:{[key:string]:any}
    loadouts: Loadout[]
    longPressToPopupEditor?: boolean
    ImagenModel:string
    ImagenImageSize:string
    ImagenAspectRatio:string
    ImagenPersonGeneration:string,
    enableScrollToActiveChar:boolean
    openaiCompatImage: {
        url: string
        key: string
        model: string
        size: string
        quality: string
    }
    wavespeedImage: {
        key: string
        model: string
        loras: Array<{path: string, scale: number}>,
        reference_mode: string
        reference_image: string
        reference_base64image: string
    }
    settingsCloseButtonSize:number
    promptDiffPrefs:PromptDiffPrefs
    enableBookmark?: boolean
    hideAllImages?: boolean
    hideMessagePageCount?: boolean
    autoScrollToNewMessage?: boolean
    alwaysScrollToNewMessage?: boolean
    newMessageButtonStyle?: string
    pluginDevelopMode?: boolean
    echoMessage?:string
    echoDelay?:number
    createFolderOnBranch?:boolean
    hamburgerButtonBottom?:boolean
    hideLeftBarCollapseButton?:boolean
    enableRemoteSaving?:boolean
    blockquoteStyling?:boolean
    dynamicModelRegistry?:boolean
    enableRisuaiProTools?:boolean
    useNodeOnlyScrollButton?:boolean
    epEnabled?:boolean
    seperateParametersByModel?:boolean
    disableSeperateParameterChangeOnPresetChange?:boolean
    saveSignatures?:boolean
    keepSessionAlive: 'off' | 'pip' | 'sound'
}

export interface SeparateParameters{
    temperature?:number
    top_k?:number
    repetition_penalty?:number
    min_p?:number
    top_a?:number
    top_p?:number
    frequency_penalty?:number
    presence_penalty?:number
    reasoning_effort?:number
    thinking_tokens?:number
    thinking_type?: 'off' | 'budget' | 'adaptive'
    adaptive_thinking_effort?: 'low' | 'medium' | 'high' | 'max'
    outputImageModal?:boolean
    verbosity?:number
}

type OutputModal = 'image'|'audio'|'video'

export interface customscript{
    comment: string;
    in:string
    out:string
    type:string
    flag?:string
    ableFlag?:boolean

}

export interface loreBook{
    key:string
    secondkey:string
    insertorder: number
    comment: string
    content: string
    mode: 'multiple'|'constant'|'normal'|'child'|'folder',
    alwaysActive: boolean
    selective:boolean
    extentions?:{
        risu_case_sensitive:boolean
    }
    activationPercent?:number
    loreCache?:{
        key:string
        data:string[]
    },
    useRegex?:boolean
    bookVersion?:number
    id?:string
    folder?:string
}

export interface character{
    type?:"character"
    name:string
    image?:string
    firstMessage:string
    desc:string
    notes:string
    chats:Chat[]
    chatFolders: ChatFolder[]
    chatPage: number
    viewScreen: 'emotion'|'none'|'imggen',
    bias: [string, number][]
    emotionImages: [string, string][]
    globalLore: loreBook[]
    chaId: string
    sdData: [string, string][]
    newGenData?: {
        prompt: string,
        negative: string,
        instructions: string,
        emotionInstructions: string,
    }
    customscript: customscript[]
    triggerscript: triggerscript[]
    utilityBot: boolean
    exampleMessage:string
    removedQuotes?:boolean
    creatorNotes:string
    systemPrompt:string
    postHistoryInstructions:string
    alternateGreetings:string[]
    tags:string[]
    creator:string
    characterVersion: string
    personality:string
    scenario:string
    firstMsgIndex:number
    loreSettings?:loreSettings
    loreExt?:any
    additionalData?: {
        tag?:string[]
        creator?:string
        character_version?:string
    }
    ttsMode?:string
    ttsSpeech?:string
    voicevoxConfig?:{
        speaker?: string
        SPEED_SCALE?: number
        PITCH_SCALE?: number
        INTONATION_SCALE?: number
        VOLUME_SCALE?: number
    }
    naittsConfig?:{
        customvoice?: boolean
        voice?: string
        version?: string
    }
    gptSoVitsConfig?:{
        url?:string
        use_auto_path?:boolean
        ref_audio_path?:string
        use_long_audio?:boolean
        ref_audio_data?: {
            fileName:string
            assetId:string
        }
        volume?:number
        text_lang?: "auto" | "auto_yue" | "en" | "zh" | "ja" | "yue" | "ko" | "all_zh" | "all_ja" | "all_yue" | "all_ko"
        text?:string
        use_prompt?:boolean
        prompt?:string | null
        prompt_lang?: "auto" | "auto_yue" | "en" | "zh" | "ja" | "yue" | "ko" | "all_zh" | "all_ja" | "all_yue" | "all_ko"
        top_p?:number
        temperature?:number
        speed?:number
        top_k?:number
        text_split_method?: "cut0" | "cut1" | "cut2" | "cut3" | "cut4" | "cut5"
    }
    fishSpeechConfig?:{
        model?: {
            _id:string
            title:string
            description:string
        },
        chunk_length:number,
        normalize:boolean,

    }
    supaMemory?:boolean
    additionalAssets?:[string, string, string][]
    ttsReadOnlyQuoted?:boolean
    replaceGlobalNote:string
    backgroundHTML?:string
    reloadKeys?:number
    backgroundCSS?:string
    license?:string
    private?:boolean
    additionalText:string
    oaiVoice?:string
    virtualscript?:string
    scriptstate?:{[key:string]:string|number|boolean}
    depth_prompt?: { depth: number, prompt: string }
    extentions?:{[key:string]:any}
    largePortrait?:boolean
    inlayViewScreen?:boolean
    hfTTS?: {
        model: string
        language: string
    },
    vits?: OnnxModelFiles
    realmId?:string
    imported?:boolean
    trashTime?:number
    nickname?:string
    source?:string[]
    group_only_greetings?:string[]
    creation_date?:number
    modification_date?:number
    ccAssets?: Array<{
        type: string
        uri: string
        name: string
        ext: string
    }>
    defaultVariables?:string
    lowLevelAccess?:boolean
    hideChatIcon?:boolean
    lastInteraction?:number
    translatorNote?:string
    doNotChangeSeperateModels?:boolean
    escapeOutput?:boolean
    prebuiltAssetCommand?:boolean
    prebuiltAssetStyle?:string
    prebuiltAssetExclude?:string[]
    modules?:string[]
    coldstorage?:string
    coldStoragedChats?:string[]
}


export interface loreSettings{
    tokenBudget: number
    scanDepth:number
    recursiveScanning: boolean
    fullWordMatching?: boolean
}

export interface botPreset{
    name?:string
    apiType?: string
    openAIKey?: string
    localNetworkMode?: boolean
    localNetworkTimeoutSec?: number
    mainPrompt: string
    jailbreak: string
    globalNote:string
    temperature: number
    maxContext: number
    maxResponse: number
    frequencyPenalty: number
    PresensePenalty: number
    formatingOrder: FormatingOrderItem[]
    aiModel?: string
    subModel?:string
    currentPluginProvider?:string
    textgenWebUIStreamURL?:string
    textgenWebUIBlockingURL?:string
    forceReplaceUrl?:string
    forceReplaceUrl2?:string
    promptPreprocess: boolean,
    bias: [string, number][]
    proxyRequestModel?:string
    openrouterRequestModel?:string
    proxyKey?:string
    ooba: OobaSettings
    ainconfig: AINsettings
    koboldURL?: string
    NAISettings?: NAISettings
    autoSuggestPrompt?: string
    autoSuggestPrefix?: string
    autoSuggestClean?: boolean
    promptTemplate?:PromptItem[]
    NAIadventure?: boolean
    NAIappendName?: boolean
    localStopStrings?: string[]
    customProxyRequestModel?: string
    reverseProxyOobaArgs?: OobaChatCompletionRequestParams
    top_p?: number
    promptSettings?: PromptSettings
    repetition_penalty?:number
    min_p?:number
    top_a?:number
    openrouterProvider?: {
        order: string[]
        only: string[]
        ignore: string[]
    }
    useInstructPrompt?:boolean
    customPromptTemplateToggle?:string
    templateDefaultVariables?:string
    moduleIntergration?:string
    top_k?:number
    instructChatTemplate?:string
    JinjaTemplate?:string
    jsonSchemaEnabled?:boolean
    jsonSchema?:string
    strictJsonSchema?:boolean
    extractJson?:string
    groupTemplate?:string
    groupOtherBotRole?:string
    seperateParametersEnabled?:boolean
    seperateParameters?:{
        memory: SeparateParameters,
        emotion: SeparateParameters,
        translate: SeparateParameters,
        otherAx: SeparateParameters
        overrides: Record<string, SeparateParameters>
    }
    customAPIFormat?:LLMFormat
    systemContentReplacement?: string
    systemRoleReplacement?: 'user'|'assistant'
    enableCustomFlags?: boolean
    customFlags?: LLMFlags[]
    image?:string
    regex?:customscript[]
    reasonEffort?:number
    thinkingTokens?:number
    thinkingType?: 'off' | 'budget' | 'adaptive'
    adaptiveThinkingEffort?: 'low' | 'medium' | 'high' | 'max'
    outputImageModal?:boolean
    seperateModelsForAxModels?:boolean
    seperateModels?:{
        memory: string
        emotion: string
        translate: string
        otherAx: string
    }
    modelTools?:string[]
    fallbackModels?: {
        memory: string[],
        emotion: string[],
        translate: string[],
        otherAx: string[]
        model: string[]
    }
    fallbackWhenBlankResponse?: boolean
    verbosity?:number
    dynamicOutput?:DynamicOutput
}


export interface themePreset{
    name: string
    // Theme tab (submenu 0)
    theme: string
    nodeOnlyStandardChatWidth?: 'standard' | 'wide' | 'full'
    guiHTML: string
    customCSS: string
    waifuWidth: number
    waifuWidth2: number
    colorSchemeName: string
    colorScheme: ColorScheme
    textTheme: string
    customTextTheme: {
        FontColorStandard: string
        FontColorBold: string
        FontColorItalic: string
        FontColorItalicBold: string
        FontColorQuote1: string
        FontColorQuote2: string
    }
    font: string
    customFont: string
    // Size & Speed tab (submenu 1)
    zoomsize: number
    lineHeight: number
    iconsize: number
    textAreaSize: number
    textAreaTextSize: number
    sideBarSize: number
    assetWidth: number
    animationSpeed: number
    memoryLimitThickness?: number
    settingsCloseButtonSize: number
    // Others tab (submenu 2)
    showMemoryLimit: boolean
    showFirstMessagePages: boolean
    hideRealm: boolean
    hideAllImages?: boolean
    hideMessagePageCount?: boolean
    showFolderName: boolean
    customBackground: string
    playMessage: boolean
    playMessageOnTranslateEnd: boolean
    roundIcons: boolean
    textScreenColor?: string
    textBorder?: boolean
    textScreenRounded?: boolean
    textScreenBorder?: string
    showSavingIcon: boolean
    showPromptComparison: boolean
    useChatCopy: boolean
    useAdditionalAssetsPreview: boolean
    useLegacyGUI: boolean
    hideApiKey: boolean
    unformatQuotes: boolean
    blockquoteStyling?: boolean
    customQuotes: boolean
    customQuotesData?: [string, string, string, string]
    betaMobileGUI: boolean
    menuSideBar: boolean
    notification: boolean
    useChatSticker: boolean
}

interface hordeConfig{
    apiKey:string
    model:string
    softPrompt:string
}

export interface folder{
    name:string
    data:string[]
    color:string
    id:string
    imgFile?:string
    img?:string
}


interface sdConfig{
    width:number
    height:number
    sampler_name:string
    script_name:string
    denoising_strength:number
    enable_hr:boolean
    hr_scale: number
    hr_upscaler:string
}

export interface NAIImgConfig{
    width:number,
    height:number,
    sampler:string,
    noise_schedule:string,
    steps:number,
    scale:number,
    cfg_rescale:number,
    sm:boolean,
    sm_dyn:boolean,
    noise:number,
    strength:number,
    image:string,
    base64image:string,
    InfoExtracted:number,
    //add 4
    autoSmea:boolean,
    use_coords:boolean,
    legacy_uc: boolean,
    v4_prompt:NAIImgConfigV4Prompt,
    v4_negative_prompt:NAIImgConfigV4NegativePrompt,
    //add vibe
    reference_image_multiple?:string[],
    reference_strength_multiple?:number[],
    vibe_data?:NAIVibeData,
    vibe_model_selection?:string
    //add variety+ and decrisp options
    variety_plus:boolean,
    decrisp:boolean,
    //add character reference
    reference_mode:string,
    character_image:string,
    character_base64image:string,
    style_aware:boolean,
}

//add 4
interface NAIImgConfigV4Prompt{
    caption: NAIImgConfigV4Caption,
    use_coords: boolean,
    use_order: boolean
}
//add 4
interface NAIImgConfigV4NegativePrompt{
    caption: NAIImgConfigV4Caption,
    legacy_uc: boolean
}
//add 4
interface NAIImgConfigV4Caption{
    base_caption: string,
    char_captions: NAIImgConfigV4CharCaption[]
}
//add 4
interface NAIImgConfigV4CharCaption{
    char_caption: string,
    centers:
        {
            x: number,
            y: number
        }[]
}

// NAI Vibe Data interfaces
interface NAIVibeData {
    identifier: string;
    version: number;
    type: string;
    image: string;
    id: string;
    encodings: {
        [key: string]: {
            [key: string]: NAIVibeEncoding;
        }
    };
    name: string;
    thumbnail: string;
    createdAt: number;
    importInfo: {
        model: string;
        information_extracted: number;
        strength: number;
    };
}

interface NAIVibeEncoding {
    encoding: string;
    params: {
        information_extracted: number;
    };
}

interface ComfyConfig{
    workflow:string,
    posNodeID: string,
    posInputName:string,
    negNodeID: string,
    negInputName:string,
    timeout: number
}

export type FormatingOrderItem = 'main'|'jailbreak'|'chats'|'lorebook'|'globalNote'|'authorNote'|'lastChat'|'description'|'postEverything'|'personaPrompt'

export interface Chat{
    message: Message[]
    note:string
    name:string
    localLore: loreBook[]
    sdData?:string
    suggestMessages?:string[]
    isStreaming?:boolean
    scriptstate?:{[key:string]:string|number|boolean}
    modules?:string[]
    id?:string
    bindedPersona?:string
    fmIndex?:number
    hypaV3Data?:SerializableHypaV3Data
    folderId?:string
    lastDate?:number
    bookmarks?: string[];
    bookmarkNames?: { [chatId: string]: string };
    supaMemory?: boolean
    savedToggleValues?: Record<string, string>
    /** Runtime-only: true while awaiting hydration from server. Never persisted. */
    _placeholder?: boolean
}

/**
 * Minimal stub stored in database.bin — full chat data lives server-side.
 * Only exists in encoded/decoded data; at runtime stubs are converted to
 * placeholder Chats.
 */
export interface ChatStub {
    id: string
    name: string
    lastDate?: number
    folderId?: string
    modules?: string[]
    _stub: true
}


export interface ChatFolder{
    id:string
    name?:string
    color?:string
    folded:boolean
}

export interface Message{
    role: 'user'|'char'
    data: string
    saying?: string
    chatId?:string
    time?: number
    generationInfo?: MessageGenerationInfo
    promptInfo?: MessagePresetInfo
    name?:string
    otherUser?:boolean
    disabled?:false|true|'allBefore'
    isComment?:boolean
    swipes?: string[]
    swipeId?: number
}

export interface MessageGenerationInfo{
    model?: string
    generationId?: string
    inputTokens?: number
    outputTokens?: number
    maxContext?: number
    stageTiming?: {
        stage1?: number
        stage2?: number
        stage3?: number
        stage4?: number
    }
}

export interface MessagePresetInfo{
    promptName?: string,
    promptToggles?: {key: string, value: string}[],
    promptText?: OpenAIChat[],
}

export interface PromptDiffPrefs {
    diffStyle: 'line' | 'intraline'
    formatStyle: 'raw' | 'card'
    viewStyle: 'unified' | 'split'
    isGrouped: boolean
    showOnlyChanges: boolean
    contextRadius: number
}

interface AINsettings{
    top_p: number,
    rep_pen: number,
    top_a: number,
    rep_pen_slope:number,
    rep_pen_range: number,
    typical_p:number
    badwords:string
    stoptokens:string
    top_k:number
}

export interface OobaSettings{
    max_new_tokens: number,
    do_sample: boolean,
    temperature: number,
    top_p: number,
    typical_p: number,
    repetition_penalty: number,
    encoder_repetition_penalty: number,
    top_k: number,
    min_length: number,
    no_repeat_ngram_size: number,
    num_beams: number,
    penalty_alpha: number,
    length_penalty: number,
    early_stopping: boolean,
    seed: number,
    add_bos_token: boolean,
    truncation_length: number,
    ban_eos_token: boolean,
    skip_special_tokens: boolean,
    top_a: number,
    tfs: number,
    epsilon_cutoff: number,
    eta_cutoff: number,
    formating:{
        header:string,
        systemPrefix:string,
        userPrefix:string,
        assistantPrefix:string
        seperator:string
        useName:boolean
    }
}

export const defaultAIN:AINsettings = {
    top_p: 0.7,
    rep_pen: 1.0625,
    top_a: 0.08,
    rep_pen_slope: 1.7,
    rep_pen_range: 1024,
    typical_p: 1.0,
    badwords: '',
    stoptokens: '',
    top_k: 140
}

export const defaultOoba:OobaSettings = {
    max_new_tokens: 180,
    do_sample: true,
    temperature: 0.7,
    top_p: 0.9,
    typical_p: 1,
    repetition_penalty: 1.15,
    encoder_repetition_penalty: 1,
    top_k: 20,
    min_length: 0,
    no_repeat_ngram_size: 0,
    num_beams: 1,
    penalty_alpha: 0,
    length_penalty: 1,
    early_stopping: false,
    seed: -1,
    add_bos_token: true,
    truncation_length: 4096,
    ban_eos_token: false,
    skip_special_tokens: true,
    top_a: 0,
    tfs: 1,
    epsilon_cutoff: 0,
    eta_cutoff: 0,
    formating:{
        header: "Below is an instruction that describes a task. Write a response that appropriately completes the request.",
        systemPrefix: "### Instruction:",
        userPrefix: "### Input:",
        assistantPrefix: "### Response:",
        seperator:"",
        useName:false,
    }
}

export interface TogglePreset {
    name: string
    values: Record<string, string>   // toggle_key → value
    promptPresetName?: string        // name of the prompt preset active when saved
}