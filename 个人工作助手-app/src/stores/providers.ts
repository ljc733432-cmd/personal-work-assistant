import { create } from 'zustand'
import type { Provider, ProviderInput } from '@/types'
import { invoke } from '@/lib/ipc'

interface ProvidersState {
  providers: Provider[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  upsert: (input: ProviderInput) => Promise<void>
  remove: (id: string) => Promise<void>
}

export const useProvidersStore = create<ProvidersState>((set) => ({
  providers: [],
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null })
    try {
      const list = await invoke<Provider[]>('provider:list')
      set({ providers: list, loading: false })
    } catch (e) {
      set({ error: String(e), loading: false })
    }
  },

  upsert: async (input) => {
    await invoke<Provider>('provider:upsert', input)
    const list = await invoke<Provider[]>('provider:list')
    set({ providers: list })
  },

  remove: async (id) => {
    await invoke<true>('provider:delete', id)
    const list = await invoke<Provider[]>('provider:list')
    set({ providers: list })
  },
}))
