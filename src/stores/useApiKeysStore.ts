import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface ApiKeys {
  derivAppId: string;
}

interface ApiKeysState {
  keys: ApiKeys;
  setKey: (key: keyof ApiKeys, value: string) => void;
}

const emptyKeys: ApiKeys = {
  derivAppId: '',
};

export const useApiKeysStore = create<ApiKeysState>()(
  persist(
    (set) => ({
      keys: { ...emptyKeys },
      setKey: (key, value) =>
        set((s) => ({ keys: { ...s.keys, [key]: value } })),
    }),
    {
      name: 'terminal-api-keys',
      storage: createJSONStorage(() => sessionStorage),
    },
  ),
);

export function getApiKey(key: keyof ApiKeys): string {
  return useApiKeysStore.getState().keys[key] ?? '';
}
