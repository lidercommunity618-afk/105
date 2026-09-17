/*
# calibration_state: singleton → per-symbol

## Overview

Аудит ("КАЛИБРОВКА" и "АНАЛИТИКА ПО ФАКТОРАМ" не связаны, п.1): таблица
`calibration_state` была singleton'ом — единственная строка с фиксированным
`id = '00000000-0000-0000-0000-000000000001'`, enforced CHECK-constraint'ом
(`singleton_check`). Это означает, что ВСЕ инструменты (BTCUSDT, EURUSD и
т.д.) делили одну и ту же обученную логистическую регрессию — исходы
сделок по крипте на M1 обучали ту же модель, что и исходы по форексу,
хотя предсказательные паттерны для них разные.

Эта миграция превращает таблицу в one-row-per-instrument: добавляет
`symbol_id`, снимает singleton-constraint, переносит существующую
единственную строку (если она есть) на `'BTCUSDT'` — сохраняя уже
накопленные веса/сэмплы, а не теряя их — и делает `symbol_id` ключом
конфликта для будущих upsert'ов (см. `saveCalibrationState`/
`loadCalibrationStateFromDb` в `src/lib/signal-persistence.ts`).

## What changes

1. `symbol_id text NOT NULL DEFAULT 'BTCUSDT'` — новый столбец.
   Существующая единственная строка (если есть) получает 'BTCUSDT' по
   умолчанию автоматически — её веса/samples/sample_count сохраняются
   как есть, просто получают привязку к инструменту.
2. `singleton_check` (CHECK на фиксированный id) — снимается: строк
   теперь может быть несколько, по одной на каждый инструмент, для
   которого приложение когда-либо считало калибровку.
3. Первичный ключ переносится с `id` на `symbol_id` — именно по нему
   происходит upsert из клиента (один инструмент = одна строка).
   Старый столбец `id` остаётся (ничего не удаляется, чтобы не ломать
   уже накопленные данные/PostgREST-кэш схемы), но перестаёт быть PK;
   для новых строк он по-прежнему заполняется значением по умолчанию,
   просто больше не используется как ключ.
4. RLS/политики (SELECT/INSERT/UPDATE, DELETE ранее уже закрыт в
   20260828120000_lock_down_signals_and_calibration_delete.sql) не
   меняются — они уже `TO anon, authenticated USING (true)` без
   привязки к конкретному столбцу, продолжают работать как есть на
   уровне таблицы независимо от того, что теперь является PK.

## Important notes

- Ничего не удаляется и не теряется: если на момент миграции уже была
  накопленная (обученная) строка, она становится записью для 'BTCUSDT'
  — ровно тот инструмент, что задан как значение по умолчанию и в
  `useSettingsStore` (`symbolId: 'BTCUSDT'`), так что для активного на
  сегодня инструмента ничего не сбрасывается.
- Для любого другого инструмента (EURUSD и т.д.) калибровка начнётся
  "с нуля" — это ожидаемо и является ЦЕЛЬЮ этой миграции: раньше её
  веса были неотличимо смешаны с BTCUSDT в одной строке, у неё никогда
  не было собственного, изолированного состояния.
- Безопасно перезапускать (`ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT
  IF EXISTS`) — как и остальные миграции в этом проекте.
*/

-- ─── calibration_state: добавляем symbol_id ─────────────────────────

ALTER TABLE calibration_state
  ADD COLUMN IF NOT EXISTS symbol_id text NOT NULL DEFAULT 'BTCUSDT';

-- На случай, если какая-то среда уже допускала symbol_id NULL до
-- добавления NOT NULL DEFAULT выше (defensive, обычно no-op).
UPDATE calibration_state SET symbol_id = 'BTCUSDT' WHERE symbol_id IS NULL;

-- ─── снимаем singleton-ограничение и старый PK на id ────────────────

ALTER TABLE calibration_state DROP CONSTRAINT IF EXISTS singleton_check;
ALTER TABLE calibration_state DROP CONSTRAINT IF EXISTS calibration_state_pkey;

-- ─── symbol_id становится ключом (одна строка на инструмент) ────────

ALTER TABLE calibration_state ADD CONSTRAINT calibration_state_pkey PRIMARY KEY (symbol_id);

-- id больше не участвует в конфликт-резолюции upsert'ов, но столбец
-- сохраняется (не дропаем) — не несёт риска, не используется клиентом
-- ни для чтения, ни для записи после этой миграции.
ALTER TABLE calibration_state ALTER COLUMN id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_calibration_state_symbol_id
  ON calibration_state (symbol_id);
