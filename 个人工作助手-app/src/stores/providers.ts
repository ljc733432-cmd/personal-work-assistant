import { create } from 'zustand'
import type { Provider, ProviderInput } from '@/types'
import { invoke } from '@/lib/ipc'

interface ProvidersState {
  providers: Provider[]
  loading: boolean
  /** 是否已完成过至少一次 refresh（区分「初始未加载」vs「加载完确实为空」）。
   *  v1.16.1：修启动卡顿——textarea/select 不再因 providerId 暂时为空误伤交互。 */
  initialized: boolean
  error: string | null
  refresh: () => Promise<void>
  upsert: (input: ProviderInput) => Promise<void>
  remove: (id: string) => Promise<void>
}

export const useProvidersStore = create<ProvidersState>((set) => ({
  providers: [],
  loading: false,
  initialized: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null })
    try {
      const list = await invoke<Provider[]>('provider:list')
      set({ providers: list, loading: false, initialized: true })
    } catch (e) {
      set({ error: String(e), loading: false, initialized: true })
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
