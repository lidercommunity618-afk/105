/*
  # Атрибуция сигнала для постмортем-анализа убыточных сделок

  Добавляет к trading_signals четыре jsonb-колонки, которые раньше нигде не
  сохранялись — раньше причина сигнала схлопывалась в единственную строку
  `reason`, теперь рядом сохраняется структурированная версия того же самого
  плюс дополнительный контекст, которого не было вовсе:

  1. `factors` — структурированная атрибуция (какие индикаторы/паттерны/
     стратегии и с каким числовым вкладом повлияли на сигнал). Параллельна
     существующей строке `reason`, ничего в ней не заменяет.
  2. `rejected_patterns` — паттерны, сработавшие на той же свече, но не
     ставшие триггером (в т.ч. встречного направления).
  3. `engine_config_snapshot` — "замороженная" конфигурация движка на
     момент сигнала (пороги/периоды/переключатели индикаторов) — без неё
     старые сигналы становятся нечитаемы после смены настроек.
  4. `chart_context` — свечи вокруг сигнала (до и после) + максимальное
     благоприятное/неблагоприятное движение цены (MFE/MAE) за время, что
     сигнал был "в рынке" — заполняется в два приёма: candlesBefore сразу
     при создании сигнала, остальное — в момент резолва исхода.
  5. `market_context` — regime/structure/session на момент сигнала. Эти
     данные уже считались в Snapshot (decision/engine.ts), но раньше нигде
     не копировались в сам Signal — без них нельзя было ответить, шёл ли
     сигнал против тренда старшего порядка, был ли рынок трендовым/
     флэтовым и в какую сессию открылась сделка.

  Все пять — NOT NULL DEFAULT, чтобы существующие строки (созданные до
  этой миграции) остались валидными без бэкофилла: у них будет пустая/
  нейтральная атрибуция, а не NULL, с которым UI/экспорт постмортема
  падал бы на `.map()`.
*/

ALTER TABLE trading_signals
  ADD COLUMN IF NOT EXISTS factors jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS rejected_patterns jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS engine_config_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS chart_context jsonb NOT NULL DEFAULT
    '{"candlesBefore":[],"candlesAfter":[],"maxFavorableExcursion":null,"maxAdverseExcursion":null}'::jsonb,
  ADD COLUMN IF NOT EXISTS market_context jsonb NOT NULL DEFAULT
    '{"regime":"range","structure":{"trend":"range","bos":false,"choch":false,"swingHigh":null,"swingLow":null,"provisional":false},"session":"closed"}'::jsonb;

-- GIN-индекс на factors — позволяет агрегировать по конкретному фактору
-- (`WHERE factors @> '[{"name":"rsi"}]'`) без вытаскивания всей таблицы на
-- клиент, когда историй сигналов станет много (см. предложение по экрану
-- "факторной аналитики" в CalibrationPanel.tsx).
CREATE INDEX IF NOT EXISTS idx_trading_signals_factors_gin
  ON trading_signals USING gin (factors);

COMMENT ON COLUMN trading_signals.factors IS 'Структурированная атрибуция сигнала (SignalFactor[]) — индикаторы/паттерны/стратегии с числовым вкладом, параллельно строке reason';
COMMENT ON COLUMN trading_signals.rejected_patterns IS 'Паттерны, сработавшие на той же свече, но не выбранные триггером (RejectedPattern[])';
COMMENT ON COLUMN trading_signals.engine_config_snapshot IS 'Конфигурация движка (пороги/периоды/переключатели), замороженная на момент генерации сигнала (EngineConfigSnapshot)';
COMMENT ON COLUMN trading_signals.chart_context IS 'Свечи до/после сигнала + MFE/MAE (ChartContext) — для реконструкции контекста входа без скриншота';
COMMENT ON COLUMN trading_signals.market_context IS 'Regime/structure/session на момент сигнала (MarketContext)';
