import { getMetadata } from '@hcengineering/platform'
import workbench from '@hcengineering/workbench'
import { readable } from 'svelte/store'

interface ContactRanks {
  connected: boolean
  byAccount: Record<string, string[]>
}

export const staffContactRanks = readable<ContactRanks | undefined>(undefined, (set) => {
  const endpoint = getMetadata(workbench.metadata.StaffContactRanksUrl)
  if (endpoint === undefined) return () => {}

  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined

  async function refresh(): Promise<void> {
    try {
      const response = await fetch(endpoint, { credentials: 'same-origin', signal: controller.signal })
      if (!response.ok) throw new Error('Discord ranks are unavailable')
      set((await response.json()) as ContactRanks)
    } catch {
      if (!controller.signal.aborted) set({ connected: false, byAccount: {} })
    } finally {
      if (!controller.signal.aborted)
        timer = setTimeout(() => {
          void refresh()
        }, 15000)
    }
  }

  void refresh()
  return () => {
    controller.abort()
    clearTimeout(timer)
  }
})
