import { useCallback, useRef, useState } from 'react';
import type { Candle, Timeframe } from '@/types/domain';
import { findSymbol } from '@/data/symbols';
import { runGeminiAnalysis, type AIAnalysis, GeminiError } from '@/lib/gemini-analysis';

interface AiState {
  loading: boolean;
  result: AIAnalysis | null;
  error: string | null;
}

interface UseAiAnalysisReturn {
  state: AiState;
  analyze: () => Promise<void>;
  clear: () => void;
}

export function useAiAnalysis(
  symbolId: string,
  timeframe: Timeframe,
  candles: Candle[],
): UseAiAnalysisReturn {
  const [state, setState] = useState<AiState>({ loading: false, result: null, error: null });
  const abortRef = useRef<AbortController | null>(null);

  const analyze = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState({ loading: true, result: null, error: null });

    try {
      const symbol = findSymbol(symbolId);
      const displaySymbol = symbol?.displaySymbol ?? symbolId;
      const result = await runGeminiAnalysis(displaySymbol, candles, controller.signal);
      if (controller.signal.aborted) return;
      setState({ loading: false, result, error: null });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      const message = err instanceof GeminiError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Failed to reach AI analysis service.';
      if (controller.signal.aborted) return;
      setState({ loading: false, result: null, error: message });
    }
  }, [symbolId, candles]);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    setState({ loading: false, result: null, error: null });
  }, []);

  return { state, analyze, clear };
}
