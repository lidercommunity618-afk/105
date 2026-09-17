import { useState } from 'react';
import { ArrowRight, ArrowLeft, Check, Activity, ShieldAlert, Volume2 } from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import { clsx } from '@/lib/utils';

interface OnboardingProps {
  onComplete: () => void;
}

const STEPS = ['welcome', 'signals', 'risk', 'sound'] as const;
type Step = (typeof STEPS)[number];

export function Onboarding({ onComplete }: OnboardingProps) {
  const [step, setStep] = useState<Step>('welcome');
  const setOnboardingCompleted = useSettingsStore((s) => s.setOnboardingCompleted);

  const stepIndex = STEPS.indexOf(step);

  const finish = () => {
    setOnboardingCompleted(true);
    onComplete();
  };

  const next = () => {
    const nextStep = STEPS[stepIndex + 1];
    if (nextStep) setStep(nextStep);
    else finish();
  };

  const back = () => {
    const prevStep = STEPS[stepIndex - 1];
    if (prevStep) setStep(prevStep);
  };

  return (
    <div className="flex h-[100dvh] flex-col bg-base-950">
      <div className="flex items-center gap-1.5 px-4 pt-4">
        {STEPS.map((s, i) => (
          <div
            key={s}
            className={clsx(
              'h-1 flex-1 rounded-full transition',
              i <= stepIndex ? 'bg-secondary-500' : 'bg-base-800',
            )}
          />
        ))}
      </div>

      <div className="flex flex-1 flex-col justify-center px-6">
        {step === 'welcome' && (
          <div className="flex flex-col items-center text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-secondary-700/20">
              <Activity size={32} className="text-secondary-400" />
            </div>
            <h1 className="text-2xl font-bold text-base-100">Торговый терминал</h1>
            <p className="mt-2 max-w-sm text-sm text-base-400">
              Анализ свечей в реальном времени с распознаванием паттернов, конfluence индикаторов
              и генерацией сигналов с помощью ИИ. Давайте настроим всё под вас.
            </p>
          </div>
        )}

        {step === 'signals' && (
          <div>
            <h2 className="mb-1 text-lg font-bold text-base-100">Как читать сигналы</h2>
            <p className="mb-4 text-sm text-base-400">
              Каждый сигнал содержит всё необходимое для оценки сделки:
            </p>
            <div className="flex flex-col gap-3">
              <InfoRow
                title="Направление и уверенность"
                desc="Покупка или продажа с оценкой уверенности от 0 до 100%."
              />
              <InfoRow
                title="Вход и экспирация"
                desc="Цена входа и время экспирации сделки (не путать со стопом/целью — их здесь нет: это бинарный опцион с фиксированной экспирацией и выплатой, а не CFD/форекс-сделка с ценовыми уровнями)."
              />
              <InfoRow
                title="Сила сигнала"
                desc="Слабый, средний или сильный — на основе конfluence индикаторов."
              />
            </div>
          </div>
        )}

        {step === 'risk' && (
          <div>
            <div className="mb-4 flex items-center gap-2">
              <ShieldAlert size={24} className="text-accent-400" />
              <h2 className="text-lg font-bold text-base-100">Дисклеймер о рисках</h2>
            </div>
            <div className="rounded-xl border border-accent-700/40 bg-accent-700/10 p-4">
              <p className="text-sm leading-relaxed text-base-300">
                Данный инструмент предназначен исключительно для образовательных и информационных целей.
                Он не является финансовой рекомендацией или советом для торговли.
              </p>
              <p className="mt-3 text-sm leading-relaxed text-base-300">
                Торговля связана с существенным риском потери. Никогда не рискуйте больше, чем можете
                позволить себе потерять. Всегда проводите собственное исследование и проконсультируйтесь
                с лицензированным финансовым консультантом перед принятием инвестиционных решений.
              </p>
              {/* Фаза 5 ("UI/UX и продуктовая честность"): два пункта, которых
                  здесь не было — (1) демо-статус, чтобы не создавалось
                  впечатление реальной торговли/брокерского исполнения;
                  (2) юрисдикционный статус — бинарные опционы для розничных
                  трейдеров запрещены или жёстко ограничены в ряде юрисдикций
                  (например, в ЕС/EEA — решением ESMA), продукт не проверяет
                  и не гарантирует легальность использования в юрисдикции
                  пользователя. */}
              <p className="mt-3 text-sm leading-relaxed text-base-300">
                Это демо-счёт: сделки не исполняются у реального брокера и не затрагивают реальные
                деньги — все результаты симулируются локально на исторических/текущих рыночных данных.
              </p>
              <p className="mt-3 text-sm leading-relaxed text-base-300">
                Бинарные опционы как продукт запрещены или жёстко ограничены для розничных трейдеров
                в ряде юрисдикций (например, в ЕС/EEA). Приложение не проверяет и не гарантирует
                легальность использования бинарных опционов в вашей юрисдикции — уточните это
                самостоятельно перед принятием любых решений на основе увиденного здесь.
              </p>
            </div>
            <p className="mt-3 text-xs text-base-500">
              Продолжая, вы подтверждаете, что понимаете и принимаете эти риски.
            </p>
          </div>
        )}

        {step === 'sound' && (
          <div>
            <div className="mb-4 flex items-center gap-2">
              <Volume2 size={24} className="text-secondary-400" />
              <h2 className="text-lg font-bold text-base-100">Звуковые уведомления</h2>
            </div>
            <p className="mb-4 text-sm text-base-400">
              Звук и приоритетный баннер воспроизводятся автоматически при
              каждом сигнале, прошедшем порог приоритета — отключить их
              нельзя, это гарантирует, что вы не пропустите ни один сигнал.
            </p>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between px-6 pb-6">
        <button
          onClick={back}
          disabled={stepIndex === 0}
          className="flex items-center gap-1 rounded-lg px-3 py-2 text-sm font-semibold text-base-400 transition hover:text-base-100 disabled:opacity-30"
        >
          <ArrowLeft size={16} />
          Назад
        </button>
        <button
          onClick={next}
          className="flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-primary-500"
        >
          {stepIndex === STEPS.length - 1 ? (
            <>
              <Check size={16} />
              Понятно, начать
            </>
          ) : (
            <>
              Далее
              <ArrowRight size={16} />
            </>
          )}
        </button>
      </div>
    </div>
  );
}

function InfoRow({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="rounded-lg border border-base-800 bg-base-900 px-4 py-3">
      <div className="text-sm font-semibold text-base-100">{title}</div>
      <div className="mt-0.5 text-xs text-base-400">{desc}</div>
    </div>
  );
}

