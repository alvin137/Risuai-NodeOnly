export interface TranslatorPreset {
    name: string;
    prompt: string;
    maxResponse: number;
}

export interface TranslatorPresetStateLike {
    translatorPrompt?: string;
    translatorMaxResponse?: number;
    translatorPresets?: unknown[];
    translatorPresetId?: number;
}

interface EncryptedTranslatorPresetFile {
    translatorPresetVersion: 1;
    type: "translator-preset";
    preset: Uint8Array | ArrayBuffer;
}