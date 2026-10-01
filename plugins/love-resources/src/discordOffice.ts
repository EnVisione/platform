import { get, writable } from 'svelte/store'

export interface DiscordMember {
  id: string
  name: string
  avatar: string
  ranks: string[]
  staff: boolean
  status: 'online' | 'idle' | 'dnd' | 'offline' | 'unknown'
  lastActiveAt?: number
  voiceRoomId: string | null
}

export interface DiscordRoom {
  id: string
  name: string
  kind: 'meeting' | 'voice'
  status: 'closed' | 'live' | 'open' | 'unavailable'
  joinUrl: string
  joinable: boolean
  memberIds: string[]
}

export interface DiscordOffice {
  connected: boolean
  canHost: boolean
  discordUrl: string
  csrf: string
  members: DiscordMember[]
  rooms: DiscordRoom[]
}

export const discordOffice = writable<DiscordOffice | undefined>(undefined)
export const discordOfficeError = writable<string | undefined>(undefined)

let endpoint: string | undefined

export function connectDiscordOffice(officeUrl: string): () => void {
  endpoint = officeUrl.replace(/\/office\/?$/, '/api/office')
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined

  async function refresh(): Promise<void> {
    try {
      const response = await fetch(endpoint as string, { signal: controller.signal, credentials: 'same-origin' })
      if (!response.ok) throw new Error('Discord office is unavailable')
      discordOffice.set((await response.json()) as DiscordOffice)
      discordOfficeError.set(undefined)
    } catch (error) {
      if (!controller.signal.aborted) {
        discordOffice.set(undefined)
        discordOfficeError.set(error instanceof Error ? error.message : 'Discord office is unavailable')
      }
    } finally {
      if (!controller.signal.aborted)
        timer = setTimeout(() => {
          void refresh()
        }, 5000)
    }
  }

  void refresh()
  return () => {
    controller.abort()
    clearTimeout(timer)
    discordOffice.set(undefined)
    endpoint = undefined
  }
}

export async function changeDiscordMeeting(room: DiscordRoom, action: 'start' | 'end'): Promise<void> {
  const snapshot = get(discordOffice)
  if (
    endpoint === undefined ||
    snapshot === undefined ||
    !snapshot.connected ||
    !snapshot.canHost ||
    room.kind !== 'meeting'
  ) {
    throw new Error('Meeting controls are unavailable')
  }
  const response = await fetch(`${endpoint}/${encodeURIComponent(room.id)}/${action}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': snapshot.csrf },
    body: '{}'
  })
  if (!response.ok) throw new Error('The meeting could not be updated')
  discordOffice.set((await response.json()) as DiscordOffice)
}

export function discordVoiceUrl(room: DiscordRoom): string | undefined {
  return /^https:\/\/discord\.com\/channels\/\d+\/\d+$/.test(room.joinUrl) ? room.joinUrl : undefined
}
