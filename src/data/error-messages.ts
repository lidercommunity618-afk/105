import type { SourceId } from '@/types/domain';

// Причины сбоя загрузки рыночных данных, для которых у нас есть
// человекочитаемый текст. Технический message исключения по-прежнему
// уходит в Sentry через captureError/errorDetail — сюда попадает только
// то, что стоит показать пользователю.
export type DataErrorReason =
  | 'unknown-symbol'
  | 'all-sources-failed'
  | 'timeout'
  | 'connection-lost'
  | 'unsupported-symbol'
  | 'rate-limited'
  | 'not-configured'
  | 'unknown';

const MESSAGES: Record<DataErrorReason, string> = {
  'unknown-symbol': 'Инструмент не найден. Проверьте выбранный символ в настройках.',
  'all-sources-failed': 'Не удалось подключиться ни к одному источнику данных. Проверьте интернет-соединение.',
  timeout: 'Источник данных не отвечает — проверьте соединение с интернетом.',
  'connection-lost': 'Соединение с источником данных прервалось. Пытаемся переподключиться…',
  'unsupported-symbol': 'Этот источник данных не поддерживает выбранный инструмент.',
  'rate-limited': 'Источник данных временно ограничил запросы. Пробуем другой источник.',
  'not-configured': 'Источник данных временно недоступен.',
  unknown: 'Не удалось загрузить рыночные данные. Попробуйте ещё раз.',
};

export function getHumanReadableError(reason: DataErrorReason): string {
  return MESSAGES[reason];
}

// Классифицирует технический message исключения (см. throw new Error(...) в
// src/data/sources/*.ts) в одну из известных причин, чтобы подобрать для неё
// человекочитаемый текст. Сами адаптеры источников не меняются — это чисто
// текстовая эвристика поверх их существующих сообщений об ошибках.
export function classifyDataError(message: string | undefined | null): DataErrorReason {
  if (!message) return 'unknown';
  const m = message.toLowerCase();
  if (m.includes('timeout')) return 'timeout';
  if (m.includes('closed') || m.includes('socket lost') || m.includes('connection failed') || m.includes('disconnected')) {
    return 'connection-lost';
  }
  if (m.includes('unsupported')) return 'unsupported-symbol';
  if (m.includes('rate limit')) return 'rate-limited';
  if (m.includes('not configured') || m.includes('proxy required')) return 'not-configured';
  return 'unknown';
}

const SOURCE_LABELS: Record<SourceId, string> = {
  binance: 'Binance',
  deriv: 'Deriv',
  twelvedata: 'TwelveData',
  finnhub: 'Finnhub',
  yahoo: 'Yahoo',
};

export function sourceLabel(sourceId: SourceId): string {
  return SOURCE_LABELS[sourceId] ?? sourceId;
}
