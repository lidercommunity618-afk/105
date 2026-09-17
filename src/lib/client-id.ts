const STORAGE_KEY = 'deepchart-client-id';

let cached: string | null = null;

export function getClientId(): string {
  if (cached) return cached;

  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing && existing.length >= 8) {
      cached = existing;
      return cached;
    }
  } catch {
    // localStorage may be unavailable (private mode, SSR)
  }

  const id = generateId();
  cached = id;
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // ignore write failure
  }
  return id;
}

function generateId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
