import { useState } from 'react';
import { X, ChevronRight, CandlestickChart, Box, MoveDiagonal, Activity, Ruler, Shield } from 'lucide-react';
import { clsx } from '@/lib/utils';

interface EducationProps {
  onClose: () => void;
}

interface Section {
  id: string;
  title: string;
  icon: typeof CandlestickChart;
  intro: string;
  points: { heading: string; text: string }[];
}

const SECTIONS: Section[] = [
  {
    id: 'candles',
    title: 'Свечные паттерны',
    icon: CandlestickChart,
    intro: 'Свечные паттерны — это базовый язык ценового движения. Контекст важнее самой формации.',
    points: [
      { heading: 'Уровни S/R', text: 'Паттерн у ключевого уровня поддержки/сопротивления имеет больший вес, чем тот же паттерн в середине диапазона.' },
      { heading: 'Тренд', text: 'Паттерн продолжения тренда надёжнее, чем разворотный паттерн против сильного направленного движения.' },
      { heading: 'Подтверждение', text: 'Ждите следующую свечу для подтверждения. Паттерн — это сигнал, а не команда на вход.' },
    ],
  },
  {
    id: 'ob',
    title: 'Order Blocks',
    icon: Box,
    intro: 'Order Block — последняя противоположная свеча перед сильным импульсным движением. Зона, откуда инициирован крупный ордер.',
    points: [
      { heading: 'Построение', text: 'Для бычьего OB: последняя медвежья свеча перед бычьим импульсом, пробивающим её максимум. Для медвежьего — зеркально.' },
      { heading: 'Бычий / Медвежий', text: 'Бычий OB — ожидаем откуп от зоны снизу вверх. Медвежий OB — ожидаем заход цены сверху вниз.' },
      { heading: 'Mitigation', text: 'Зона считается отработанной (mitigated), когда цена возвращается и касается её границ. После mitigation зона теряет актуальность.' },
      { heading: 'Фильтрация слабых', text: 'Сильный OB: объём выше среднего, тело свечи больше соседних, последующее движение не менее 2 ATR. Слабые OB без объёма игнорируются.' },
    ],
  },
  {
    id: 'fvg',
    title: 'Fair Value Gaps',
    icon: MoveDiagonal,
    intro: 'FVG (Imbalance) — ценовой разрыв между свечами, где нет встречного интереса. Цена стремится вернуться и заполнить разрыв.',
    points: [
      { heading: 'Формирование', text: 'Бычий FVG: минимум третьей свечи выше максимума первой. Медвежий FVG: максимум третьей свечи ниже минимума первой. Зона — между ними.' },
      { heading: 'Торговля на fill', text: 'Цена часто возвращается к FVG для заполнения. В терминах этого приложения касание зоны в направлении тренда — повод ждать сигнал по инструменту с этим паттерном, а не повод самостоятельно выставлять стоп: сделка здесь — бинарный опцион с фиксированной экспирацией, структурного стопа нет ни у одного сигнала.' },
      { heading: 'Незаполненные FVG', text: 'Если разрыв не заполнен, он остаётся «магнитом» для цены. Визуально на графике такие зоны тянутся до правого края.' },
    ],
  },
  {
    id: 'smc',
    title: 'SMC / ICT',
    icon: Activity,
    intro: 'Smart Money Concepts — модель поведения крупного капитала. Ликвидность, структурные сдвиги, kill zones.',
    points: [
      { heading: 'Ликвидность', text: 'Скопления стоп-лоссов над экстремумами и под ними. Крупный капитал ищет ликвидность для исполнения крупных позиций.' },
      { heading: 'BOS (Break of Structure)', text: 'Пробой предыдущего максимума (бычий BOS) или минимума (медвежий BOS) подтверждает продолжение тренда.' },
      { heading: 'CHoCH (Change of Character)', text: 'Смена характера: первый пробой структуры против тренда. Ранний сигнал возможного разворота, но требует подтверждения.' },
      { heading: 'Kill Zones', text: 'Лондонская сессия (07:00–10:00 UTC) и Нью-Йорк (12:00–15:00 UTC) — время наибольшей волатильности и наиболее чистых SMC-сетапов.' },
    ],
  },
  {
    id: 'fib',
    title: 'Фибоначчи',
    icon: Ruler,
    intro: 'Уровни Фибоначчи — зоны коррекции и расширения на основе золотого сечения.',
    points: [
      { heading: 'Коррекции', text: 'Ключевые уровни: 0.5 (50%), 0.618 (61.8%), 0.705 (70.5%). Зона между 0.618 и 0.705 — «золотая зона» для входа по тренду.' },
      { heading: 'Расширения', text: 'Используются для целей: 1.272, 1.414, 1.618, 2.0. Расширение 1.618 — частая цель третьей волны.' },
      { heading: 'Применение', text: 'Натяните сетку от начала до конца импульса. Коррекция к 0.618 в зоне OB — высоковероятный сетап.' },
    ],
  },
  {
    id: 'risk',
    title: 'Риск-менеджмент',
    icon: Shield,
    intro: 'Без риск-менеджмента любой сигнал — лотерея. Дисциплина важнее стратегии. В бинарном опционе с фиксированной выплатой риск-менеджмент устроен иначе, чем в форекс/CFD: здесь нет стопа, который можно «подвинуть» или структурного R:R — есть только ставка и фиксированная выплата.',
    points: [
      // BUGFIX (Фаза 5, "UI/UX и продуктовая честность"): раньше здесь было
      // "R:R ≥ 1.5" — соотношение риска к прибыли не существует для
      // бинарного опциона с фиксированной выплатой (нет ни структурного
      // риска, ни структурной прибыли, которые можно было бы делить друг
      // на друга — есть только ставка и payout%). Вместо R:R —
      // точка безубыточности, реальный аналог для этого продукта.
      { heading: 'Точка безубыточности', text: 'При выплате 80% нужен winRate не ниже 100/(100+80) ≈ 55.56%, чтобы просто выйти в ноль — точную цифру для текущей выплаты счёта показывает панель «Калибровка». Winrate ниже этого порога убыточен, даже если он выше 50%.' },
      // BUGFIX (Фаза 5): раньше здесь было "Стоп всегда за экстремумом
      // свечи входа..." — структурного стопа у сигналов этого приложения
      // нет вообще (см. Signal.entryPrice в types/domain.ts), выставлять
      // его нечему и незачем.
      { heading: 'Нет стоп-лосса, есть экспирация', text: 'Сделка закрывается автоматически на экспирации — не раньше и не позже, независимо от того, куда ходила цена внутри интервала. Единственный риск на сделку — это размер ставки, а не расстояние до какого-либо уровня.' },
      { heading: 'Размер ставки', text: 'Ставка на сделку — фиксированный небольшой процент от баланса (например, 1–2%), не всё «на удачу». При проигрыше теряется вся ставка целиком — это тоже отличие от форекс/CFD, где убыток обычно меньше стопа не бывает, но и не всегда равен 100% риска.' },
      { heading: 'Мартингейл — с осторожностью', text: 'Автоматическое увеличение ставки после проигрыша (доступно в настройках демо-счёта) ускоряет как рост, так и разорение депозита: серия из нескольких проигрышей подряд статистически неизбежна на любой accuracy < 100%, а мартингейл увеличивает ставку именно в такой серии.' },
      { heading: 'Консистентность', text: 'Одинаковый процент риска на каждую сделку вне мартингейла. Отыгрываться повышением ставки после проигрыша (вне продуманной мартингейл-схемы) — путь к сливу.' },
    ],
  },
];

export function Education({ onClose }: EducationProps) {
  const [openId, setOpenId] = useState<string | null>(SECTIONS[0].id);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-base-800 bg-base-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-base-800 px-5 py-4">
          <h2 className="flex items-center gap-2 text-sm font-bold text-base-100">
            <CandlestickChart size={16} className="text-secondary-400" />
            Учебный курс
          </h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-base-400 transition hover:bg-base-800 hover:text-base-100"
            aria-label="Закрыть"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          <div className="flex flex-col gap-2">
            {SECTIONS.map((section) => {
              const isOpen = openId === section.id;
              const Icon = section.icon;
              return (
                <div key={section.id} className="overflow-hidden rounded-xl border border-base-800 bg-base-900">
                  <button
                    onClick={() => setOpenId(isOpen ? null : section.id)}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-base-800/50"
                  >
                    <Icon size={18} className={clsx('shrink-0 transition', isOpen ? 'text-secondary-400' : 'text-base-500')} />
                    <span className="flex-1 text-sm font-semibold text-base-100">{section.title}</span>
                    <ChevronRight
                      size={16}
                      className={clsx('text-base-500 transition-transform', isOpen && 'rotate-90')}
                    />
                  </button>
                  {isOpen && (
                    <div className="border-t border-base-800 px-4 py-3">
                      <p className="mb-3 text-xs leading-relaxed text-base-300">{section.intro}</p>
                      <div className="flex flex-col gap-2.5">
                        {section.points.map((point) => (
                          <div key={point.heading} className="flex flex-col gap-0.5">
                            <span className="text-xs font-bold text-secondary-400">{point.heading}</span>
                            <span className="text-xs leading-relaxed text-base-300">{point.text}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
