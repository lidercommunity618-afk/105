let audioCtx: AudioContext | null = null;
let unlocked = false;

export function unlockAudio(): void {
  if (unlocked) return;
  const handler = () => {
    try {
      const ctx = ensureCtx();
      if (ctx && ctx.state === 'suspended') void ctx.resume();
      unlocked = true;
    } catch {
      // audio not supported / blocked — non-fatal
    }
    document.removeEventListener('pointerdown', handler);
    document.removeEventListener('touchstart', handler);
  };
  document.addEventListener('pointerdown', handler, { passive: true });
  document.addEventListener('touchstart', handler, { passive: true });
}

function ensureCtx(): AudioContext | null {
  if (audioCtx && audioCtx.state === 'closed') {
    audioCtx = null;
  }
  if (!audioCtx) {
    try {
      audioCtx = new AudioContext();
    } catch {
      return null;
    }
  }
  return audioCtx;
}

export function playSignalAlert(direction: 'buy' | 'sell'): void {
  const ctx = ensureCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    void ctx.resume();
    return;
  }
  if (ctx.state !== 'running') return;
  try {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = direction === 'buy' ? 'sine' : 'sawtooth';
    osc.frequency.setValueAtTime(direction === 'buy' ? 660 : 440, now);
    osc.frequency.exponentialRampToValueAtTime(direction === 'buy' ? 880 : 220, now + 0.15);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.2, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
    osc.start(now);
    osc.stop(now + 0.32);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
  } catch {
    // audio context closed or unavailable — non-fatal
  }
}

export function playPriorityAlert(direction: 'buy' | 'sell'): void {
  const ctx = ensureCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    void ctx.resume();
    return;
  }
  if (ctx.state !== 'running') return;
  try {
    const now = ctx.currentTime;
    const baseFreq = direction === 'buy' ? 523.25 : 311.13;
    for (let i = 0; i < 3; i++) {
      const start = now + i * 0.18;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(baseFreq, start);
      osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.5, start + 0.12);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.14);
      osc.start(start);
      osc.stop(start + 0.16);
      osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    }
  } catch {
    // audio context closed or unavailable — non-fatal
  }
}
