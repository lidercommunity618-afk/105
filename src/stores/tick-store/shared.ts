import type { FeatureName, Signal } from '@/types/domain';
import type { TickState } from '../useTickStore';
import { playPriorityAlert } from '@/lib/audio';
import { captureError } from '@/lib/sentry';
import { sigmoidFallback } from '@/decision/signal-builder';

// Вынесено из useTickStore.ts как есть (без изменения логики), чтобы им могли
// пользоваться и useTickStore.ts, и src/stores/tick-store/*.ts без
// циклического импорта useTickStore.ts <-> tick-store/*.ts.
export function getActiveFeatures(settings: { activePatterns: string[]; activeIndicators: string[] }): FeatureName[] {
  return [...settings.activePatterns, ...settings.activeIndicators] as FeatureName[];
}

export interface SignalNotificationSettings {
  priorityThreshold: number;
}

// Аудит, п.3: единственное место, где решается — звучит ли сигнал звуком и
// показывается ли приоритетный баннер. Раньше эта логика была продублирована
// только в tick-store/pre-close.ts; путь открытия сделки "по подстраховке"
// (fallback, когда pre-close не успел сработать — см. useTickStore.ts,
// maybeEvaluateSignal) её не вызывал вовсе, из-за чего часть сделок
// открывалась полностью бесшумно, без каких-либо уведомлений. Теперь оба
// места используют одну и ту же функцию.
//
// Аудит, п.4: приоритет определяется ИСКЛЮЧИТЕЛЬНО порогом из настроек
// ("Приоритетные уведомления" → "Порог приоритета"). Раньше здесь также
// требовалось signal.strength === 'strong', из-за чего сигнал с высокой
// calibratedProbability, но силой 'moderate' (strength считается по своей
// отдельной шкале — см. strengthFor() в signal-builder.ts и не всегда
// совпадает с calibratedProbability, особенно когда активна ML-модель
// калибровки), никогда не показывался как приоритетный, даже уверенно
// превышая порог. Теперь единственное условие — prob >= priorityThreshold,
// то есть порог из настроек буквально управляет тем, какие сигналы
// считаются приоритетными, независимо от их strength.
//
// Резервная формула для prob (когда calibratedProbability ещё не
// проставлен) приведена к той же кривой, что используется при создании и
// пересчёте сигнала (buildSignal/reviseSignal в signal-builder.ts), чтобы
// одинаковый score давал одинаковую оценку вероятности везде в приложении.
// Все сигналы, доходящие до этой функции, ОБЫЧНО уже прошли приоритетный
// фильтр в buildSignal (calibratedProbability >= priorityThreshold) —
// поэтому каждый из них по-прежнему гарантированно вызывает приоритетный
// баннер и звук, ветка "не приоритетный" не существует. ИСКЛЮЧЕНИЕ (аудит
// 2026-09-05, п.2): сигналы с calibrationSource === 'fallback' сюда могут
// долетать и ниже порога — см. подробный BUGFIX-комментарий в
// signal-builder.ts у самого гейта. Это НЕ обход контракта, а его
// целенаправленное сужение: фильтр по priorityThreshold применяется только
// к 'model'-вероятностям, потому что 'fallback'-вероятность в принципе не
// является калиброванной оценкой уверенности (она зажата в [0.35, 0.65]
// именно чтобы не выглядеть таковой) — раньше игнорирование этого различия
// приводило к тому, что ни один сигнал не создавался вообще, пока не
// накопится 100+ исходов, взять которые было неоткуда.
//
// Задача 1 (доделка): раньше эта функция полностью игнорировала settings
// (`void settings;`) и звук/баннер играли безусловно для любого пришедшего
// сигнала — правильно, потому что buildSignal() уже гарантирует, что сюда
// не долетит ничего ниже порога (для calibrationSource === 'model'). Но эта
// гарантия раньше держалась только "по памяти" (контракт между двумя
// разными файлами, ничем не проверяемый прямо здесь). Теперь порог
// перепроверяется и на этом конце — но только для 'model'-сигналов, иначе
// каждый легитимный fallback-сигнал ниже порога (ожидаемый, не баг) вызывал
// бы ложное срабатывание этой проверки. Расхождение НЕ приводит к скрытию
// сигнала (см. ниже, почему) — только логируется как аномалия.
export function notifySignal(
  signal: Signal,
  settings: SignalNotificationSettings,
  set: (partial: Partial<TickState>) => void,
): void {
  const probability = signal.calibratedProbability ?? sigmoidFallback(signal.score);
  if (signal.calibrationSource !== 'fallback' && probability < settings.priorityThreshold) {
    // Инвариант нарушен: 'model'-сигнал, дошедший до notifySignal(), обязан
    // был уже пройти фильтр priorityThreshold внутри buildSignal(). Раз
    // этого не произошло — где-то в коде появился путь, создающий сигнал в
    // обход штатного фильтра. Мы намеренно НЕ скрываем баннер/звук в ответ
    // на это: требование "исключить сигнал без баннера и звука" важнее, чем
    // самозащита от собственной аномалии, а тихое скрытие реального сигнала
    // выглядело бы для пользователя как пропущенный сигнал. Вместо этого —
    // громко логируем, чтобы аномалию заметили и разобрали.
    captureError(new Error('notifySignal: signal below priorityThreshold reached notification'), {
      context: 'notifySignal.invariant',
      signalId: signal.id,
      calibratedProbability: probability,
      priorityThreshold: settings.priorityThreshold,
    });
  }
  set({ prioritySignal: signal });
  playPriorityAlert(signal.direction);
}
