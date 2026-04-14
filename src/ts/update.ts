import { writable } from "svelte/store"

export interface UpdateInfo {
    currentVersion: string
    latestVersion: string
    hasUpdate: boolean
    severity: 'none' | 'optional' | 'required' | 'outdated'
    releaseUrl: string
    releaseName: string
    publishedAt: string
    popupMessage?: string
    disabled?: boolean
}

/** Reactive store for update info — used by home screen and popup */
export const updateInfoStore = writable<UpdateInfo | null>(null)

/** Independent store for the update popup — does not collide with alertStore */
export const updatePopupStore = writable<UpdateInfo | null>(null)

export async function checkRisuUpdate(): Promise<UpdateInfo | null> {
    try {
        const res = await fetch('/api/update-check')
        if (!res.ok) return null
        const data: UpdateInfo = await res.json()
        updateInfoStore.set(data)

        if (data.hasUpdate) {
            showUpdatePopupOnce(data)
        }

        return data
    } catch {
        return null
    }
}

const DISMISSED_KEY = 'risuNodeOnly_dismissedUpdateVersion'

function showUpdatePopupOnce(info: UpdateInfo) {
    const dismissed = localStorage.getItem(DISMISSED_KEY)
    if (dismissed === info.latestVersion) return

    localStorage.setItem(DISMISSED_KEY, info.latestVersion)
    updatePopupStore.set(info)
}

export function dismissUpdatePopup() {
    updatePopupStore.set(null)
}
