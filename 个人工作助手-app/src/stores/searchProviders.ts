import { create } from 'zustand'
import type { SearchProvider, SearchProviderInput } from '@/types'
import { invoke } from '@/lib/ipc'

interface SearchProvidersState {
  searchProviders: SearchProvider[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  upsert: (input: SearchProviderInput) => Promise<void>
  remove: (id: string) => Promise<void>
  test: (id: string) => Promise<string>
}

export const useSearchProvidersStore = create<SearchProvidersState>((set) => ({
  searchProviders: [],
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null })
    try {
      const list = await invoke<SearchProvider[]>('search-provider:list')
      set({ searchProviders: list, loading: false })
    } catch (e) {
      set({ error: String(e), loading: false })
    }
  },

  upsert: async (input) => {
    await invoke<SearchProvider>('search-provider:upsert', input)
    const list = await invoke<SearchProvider[]>('search-provider:list')
    set({ searchProviders: list })
  },

  remove: async (id) => {
    await invoke<true>('search-provider:delete', id)
    const list = await invoke<SearchProvider[]>('search-provider:list')
    set({ searchProviders: list })
  },

  test: async (id) => {
    return await invoke<string>('search-provider:test', id)
  },
}))
