export interface OpenAIChat{
    role: 'system'|'user'|'assistant'|'function'
    content: string
    memo?:string
    name?:string
    removable?:boolean
    attr?:string[]
    multimodals?: MultiModal[]
    thoughts?: string[]
    cachePoint?: boolean
}

export interface MultiModal{
    type:'image'|'video'|'audio'|'signature'
    base64:string,
    height?:number,
    width?:number
}

export interface requestTokenPart{
    name:string
    tokens:number
}

export interface OnnxModelFiles {
    files: { [key: string]: string },
    id: string,
    name?: string
}