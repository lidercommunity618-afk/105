import { describe, it, expect } from 'vitest';
import { CalibrationModel, MIN_SAMPLES, persistCalibrationState, loadCalibrationState } from './calibration-model';

describe('CalibrationModel', () => {
  it('starts not ready with 0 samples', () => {
    const model = new CalibrationModel(3);
    expect(model.isReady()).toBe(false);
    expect(model.getSampleCount()).toBe(0);
  });

  it('becomes ready after MIN_SAMPLES', () => {
    const model = new CalibrationModel(2);
    for (let i = 0; i < MIN_SAMPLES; i++) {
      model.addSample({ features: [0.5, 0.3], score: 3, outcome: i % 2 === 0 ? 1 : 0 });
    }
    expect(model.isReady()).toBe(true);
    expect(model.getSampleCount()).toBe(MIN_SAMPLES);
  });

  it('predicts a value in [0, 1] after training', () => {
    const model = new CalibrationModel(2);
    for (let i = 0; i < 60; i++) {
      model.addSample({
        features: [0.8, 0.6],
        score: 4,
        outcome: 1,
      });
    }
    for (let i = 0; i < 60; i++) {
      model.addSample({
        features: [0.2, 0.1],
        score: 1,
        outcome: 0,
      });
    }
    model.retrain();
    const predHigh = model.predict([0.8, 0.6]);
    const predLow = model.predict([0.2, 0.1]);
    expect(predHigh).toBeGreaterThan(predLow);
    expect(predHigh).toBeGreaterThan(0.5);
    expect(predLow).toBeLessThan(0.5);
  });

  it('caps samples at 500', () => {
    const model = new CalibrationModel(1);
    for (let i = 0; i < 600; i++) {
      model.addSample({ features: [i / 600], score: 1, outcome: 1 });
    }
    expect(model.getSampleCount()).toBe(500);
  });

  it('exportState and loadState round-trip', () => {
    const model = new CalibrationModel(2);
    for (let i = 0; i < MIN_SAMPLES; i++) {
      model.addSample({ features: [0.5, 0.3], score: 3, outcome: i % 2 === 0 ? 1 : 0 });
    }
    model.retrain();
    const state = model.exportState();

    const model2 = new CalibrationModel(2);
    model2.loadState(state);
    const state2 = model2.exportState();
    expect(state2.weights).toEqual(state.weights);
    expect(state2.bias).toBe(state.bias);
    expect(model2.getSampleCount()).toBe(state.sampleCount);
    // BUGFIX (аудит "калибровка: 0 сигналов после 100"): featureMean/
    // featureStd должны пережить round-trip вместе с weights — иначе
    // model2.predict() будет интерпретировать вход иначе, чем model.
    expect(state2.featureMean).toEqual(state.featureMean);
    expect(state2.featureStd).toEqual(state.featureStd);
  });

  // BUGFIX-регрессия (аудит "калибровка: 0 сигналов после 100", реальный
  // инцидент): признаки разного масштаба (как 'vwap'/'atr' — абсолютная
  // цена инструмента — рядом с остальными признаками, уже нормированными
  // в диапазон примерно [-1, 1] в signal-builder.ts::buildFeatureVector) не
  // должны заставлять веса "разгоняться" настолько, чтобы predict()
  // залипал на константе для ЛЮБОГО нового входа. Раньше (до z-score
  // стандартизации в trainLogisticRegression) этот тест ловил бы
  // predHigh === predLow === либо 0, либо 1 — калибровка становилась
  // константой, gate `calibratedProbability < priorityThreshold` в
  // signal-builder.ts либо блокировал 100% новых сигналов, либо переставал
  // фильтровать вообще.
  it('does not saturate to a constant prediction when one feature has a much larger raw scale than the others (BUGFIX regression)', () => {
    const model = new CalibrationModel(3);
    // features: [rsi_like (~0-1), macd_like (~-5..5), vwap_like (RAW PRICE, ~45000-70000)]
    for (let i = 0; i < 60; i++) {
      model.addSample({ features: [0.8, 3, 68000 + i * 5], score: 4, outcome: 1 });
    }
    for (let i = 0; i < 60; i++) {
      model.addSample({ features: [0.2, -3, 46000 + i * 5], score: 1, outcome: 0 });
    }
    model.retrain();

    const predHigh = model.predict([0.8, 3, 68500]);
    const predLow = model.predict([0.2, -3, 46500]);
    // The old (unstandardized) implementation drove z into the tens of
    // millions here — sigmoid() saturated both predictions to the exact
    // same constant (0 or 1), so predHigh - predLow collapsed to 0 and
    // neither bound below held. A healthy model must still discriminate
    // between a clearly-winning and a clearly-losing setup, and must not
    // sit glued to an extreme for every input.
    expect(predHigh).toBeGreaterThan(predLow);
    expect(predHigh).toBeGreaterThan(0.5);
    expect(predLow).toBeLessThan(0.5);
    expect(predHigh).toBeLessThan(1);
    expect(predLow).toBeGreaterThan(0);
  });

  // BUGFIX-регрессия: loadState() должна принять легаси-состояние (без
  // featureMean/featureStd, как персистилось до этого фикса) без падения
  // и без NaN на выходе predict() — откатывается на no-op нормализацию.
  it('loadState falls back to neutral normalization for legacy state without featureMean/featureStd', () => {
    const model = new CalibrationModel(2);
    model.loadState({ weights: [0.1, -0.2], bias: 0.05, sampleCount: 100 });
    const p = model.predict([0.5, 0.5]);
    expect(Number.isFinite(p)).toBe(true);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
  });

  // BUGFIX-регрессия (самоисцеление уже застрявших пользователей):
  // loadCalibrationState() должна обнаружить легаси-состояние (сохранённое
  // до фикса нормализации — без featureMean) и немедленно переобучить
  // модель по уже накопленным (валидным) сэмплам вместо того, чтобы
  // молча унаследовать потенциально залипшие веса и оставить пользователя
  // застрявшим до следующего резолвнутого исхода — которому взяться
  // неоткуда, пока сигналы заблокированы этим же багом.
  it('loadCalibrationState self-heals a legacy (pre-fix) persisted state by retraining from its own stored samples', () => {
    const samples: { features: number[]; score: number; outcome: 1 | 0 }[] = [];
    for (let i = 0; i < 60; i++) samples.push({ features: [0.8, 3, 68000 + i * 5], score: 4, outcome: 1 });
    for (let i = 0; i < 60; i++) samples.push({ features: [0.2, -3, 46000 + i * 5], score: 1, outcome: 0 });
    // Simulate a pre-fix persisted blob: weights present, but saturated
    // (as the old buggy trainLogisticRegression would have produced), and
    // no featureMean/featureStd at all.
    const legacyBlob = {
      state: { weights: [0, 0, 1250], bias: -0.05, sampleCount: 120 },
      samples,
    };
    localStorage.setItem('terminal-calibration-v1', JSON.stringify(legacyBlob));

    const model = loadCalibrationState(3);
    expect(model).not.toBeNull();
    expect(model!.isReady()).toBe(true);

    const predHigh = model!.predict([0.8, 3, 68500]);
    const predLow = model!.predict([0.2, -3, 46500]);
    expect(predHigh).toBeGreaterThan(predLow);
    expect(predHigh).toBeGreaterThan(0.5);
    expect(predLow).toBeLessThan(0.5);
  });

  it('persists and loads from localStorage', () => {
    const model = new CalibrationModel(2);
    for (let i = 0; i < MIN_SAMPLES; i++) {
      model.addSample({ features: [0.5, 0.3], score: 3, outcome: 1 });
    }
    model.retrain();
    persistCalibrationState(model);

    const loaded = loadCalibrationState(2);
    expect(loaded).not.toBeNull();
    expect(loaded!.getSampleCount()).toBe(MIN_SAMPLES);
    expect(loaded!.isReady()).toBe(true);
  });

  it('returns null for wrong feature count on load', () => {
    const model = new CalibrationModel(2);
    model.addSample({ features: [0.5, 0.3], score: 3, outcome: 1 });
    persistCalibrationState(model);
    expect(loadCalibrationState(3)).toBeNull();
  });
});
