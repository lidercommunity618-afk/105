import { useState } from 'react';
import type { Signal } from '@/types/domain';
import { buildPostMortemReport } from '@/lib/trade-report';

// Реальные проблемы, п.5: логика экспорта постмортем-отчёта (копирование
// Markdown в буфер обмена + скачивание .md-файла) была продублирована
// один-в-один в SignalCard.tsx и EntryPointPopup.tsx — идентичный код,
// скопированный, а не вынесенный в общее место, с риском рассинхрона при
// следующей правке (например, если поменяется имя файла или обработка
// ошибки буфера обмена в одном месте, но не в другом). Теперь оба
// компонента используют этот хук как единственный источник истины.
export function useTradeReportExport(signal: Signal) {
  const [copied, setCopied] = useState(false);

  async function handleExport() {
    const report = buildPostMortemReport(signal);
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Буфер обмена может быть недоступен (небезопасный контекст, старый
      // WebView без разрешения) — скачивание файла ниже остаётся рабочим
      // способом получить отчёт независимо от этого.
    }
    const blob = new Blob([report], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trade-${signal.symbolId}-${signal.time}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return { copied, handleExport };
}
