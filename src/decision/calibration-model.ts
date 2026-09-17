import type { CalibrationState } from '@/types/domain';

export const MIN_SAMPLES = 100;
export const MAX_SAMPLES = 500;
const LEARNING_RATE = 0.1;
const EPOCHS = 500;
const L2_REGULARIZATION = 0.0001;
const STORAGE_KEY = 'terminal-calibration-v1';

export interface CalibrationSample {
  features: number[];
  score: number;
  outcome: 1 | 0;
}

export interface TrainingResult {
  weights: number[];
  bias: number;
  // BUGFIX (аудит "калибровка: 0 сигналов после 100", 2026-09-10): см.
  // подробный комментарий у trainLogisticRegression ниже. Хранятся здесь
  // (а не выводятся заново из samples на каждый predict()), потому что
  // predict() должен применять РОВНО ТУ ЖЕ нормализацию, на которой
  // обучались веса — иначе веса и вход снова рассинхронизируются.
  featureMean: number[];
  featureStd: number[];
}

function sigmoid(z: number): number {
  if (z >= 0) {
    const ez = Math.exp(-z);
    return 1 / (1 + ez);
  }
  const ez = Math.exp(z);
  return ez / (1 + ez);
}

// BUGFIX (аудит "калибровка: 0 сигналов после 100", 2026-09-10, реальный
// инцидент — найденный, не гипотетический): buildFeatureVector()
// (signal-builder.ts) кладёт в один вектор признаки РАЗНОГО масштаба —
// большинство уже нормировано в диапазон примерно [-1, 1] (rsi/100,
// ema_cross как отношение, bb_width как отношение, булевы 0/1,
// pattern_conf), но 'atr' и, особенно, 'vwap' идут АБСОЛЮТНЫМИ значениями
// цены как есть (для BTCUSDT vwap ~ 45000-120000). Полный батч-градиентный
// спуск ниже — без нормализации входа и с фиксированным LEARNING_RATE —
// вычисляет градиент по каждому весу пропорционально МАСШТАБУ самого
// признака (gradW[i] += err * s.features[i]): при s.features[i] ~ 50000
// первый же шаг градиентного спуска сразу выбрасывает w[vwap] на сотни-
// тысячи, экспоненциально расходясь дальше по эпохам, тогда как остальные
// веса остаются в разумных пределах.
//
// К моменту 100-го (MIN_SAMPLES) исхода CalibrationModel.isReady()
// становится true, calibrationSource сигналов переключается с 'fallback'
// на 'model' (signal-builder.ts), и ИМЕННО ДЛЯ 'model' действует
// приоритетный гейт `calibratedProbability < priorityThreshold` (см. его
// собственный BUGFIX-комментарий в signal-builder.ts — тот фикс защитил
// только от старого бага "гейт душит fallback", а не от этого). sigmoid()
// ниже специально написан overflow-safe и не даёт NaN/Infinity —
// вместо этого он просто НАСЫЩАЕТСЯ на константе 0 или 1 при любом z
// такого масштаба (проверено эмпирически: |z| выходит в диапазон
// десятков миллионов). Если модель расходится в сторону 0 — калибровка
// молча и НАВСЕГДА (пока не переобучится на новых данных — а новых
// данных взяться неоткуда, см. ниже) возвращает calibratedProbability≈0
// для АБСОЛЮТНО ЛЮБОГО нового сигнала, вне зависимости от его реального
// качества — гейт блокирует 100% сигналов. Тот же класс самоподдерживаю-
// щегося тупика, что уже был найден и исправлен 2026-09-05 (см. комментарий
// у гейта в signal-builder.ts), но ЗДЕСЬ он возникает даже после фикса той
// даты — в момент ПЕРЕХОДА fallback -> model, а не до него.
//
// Фикс: стандартизация (z-score) признаков ПЕРЕД обучением — каждый
// признак приводится к среднему 0 / стд.отклонению 1 по обучающей
// выборке, поэтому масштаб исходных единиц (доллары vwap против долей
// rsi) больше не влияет на величину градиента ни для одного веса.
// featureMean/featureStd возвращаются вместе с весами и должны
// применяться к входу при КАЖДОМ predict() (см. CalibrationModel.predict
// ниже) — иначе веса, обученные на стандартизированных данных, снова
// дадут бессмысленный результат на сыром входе.
function computeFeatureStats(
  samples: CalibrationSample[],
  featureCount: number,
): { mean: number[]; std: number[] } {
  const n = samples.length;
  const mean = new Array<number>(featureCount).fill(0);
  if (n === 0) {
    return { mean, std: new Array<number>(featureCount).fill(1) };
  }
  for (const s of samples) {
    for (let i = 0; i < featureCount; i++) {
      mean[i] += s.features[i];
    }
  }
  for (let i = 0; i < featureCount; i++) {
    mean[i] /= n;
  }
  const variance = new Array<number>(featureCount).fill(0);
  for (const s of samples) {
    for (let i = 0; i < featureCount; i++) {
      const d = s.features[i] - mean[i];
      variance[i] += d * d;
    }
  }
  const std = new Array<number>(featureCount);
  for (let i = 0; i < featureCount; i++) {
    const v = variance[i] / n;
    // Защита от константного признака (std === 0, например 'regime_trend'
    // в выборке, где режим ни разу не менялся): деление на ноль превратило
    // бы каждое значение этого признака в NaN/Infinity и отравило бы ВЕСЬ
    // градиентный спуск, а не только вес этого одного признака. Порог
    // 1e-12, а не строгое === 0, — чтобы отловить и denormal-остатки от
    // float-арифметики, не только точный ноль.
    std[i] = v > 1e-12 ? Math.sqrt(v) : 1;
  }
  return { mean, std };
}

function standardize(features: number[], mean: number[], std: number[]): number[] {
  return features.map((v, i) => (v - mean[i]) / std[i]);
}

// Pure module-level function so it can also be run inside the compute
// worker (see src/compute/worker.ts, case 'retrain_calibration') without
// needing a CalibrationModel instance. Constants (EPOCHS/LEARNING_RATE/
// L2_REGULARIZATION) stay in this file — the worker imports the function,
// not the constants, so nothing is duplicated.
export function trainLogisticRegression(
  samples: CalibrationSample[],
  featureCount: number,
): TrainingResult {
  const n = samples.length;
  const { mean, std } = computeFeatureStats(samples, featureCount);
  const standardized = samples.map((s) => standardize(s.features, mean, std));
  const w = new Array<number>(featureCount).fill(0);
  let b = 0;

  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    const gradW = new Array<number>(featureCount).fill(0);
    let gradB = 0;

    for (let si = 0; si < n; si++) {
      const features = standardized[si];
      let z = b;
      for (let i = 0; i < featureCount; i++) {
        z += w[i] * features[i];
      }
      const pred = sigmoid(z);
      const err = pred - samples[si].outcome;
      for (let i = 0; i < featureCount; i++) {
        gradW[i] += err * features[i];
      }
      gradB += err;
    }

    for (let i = 0; i < featureCount; i++) {
      gradW[i] = gradW[i] / n + L2_REGULARIZATION * w[i];
      w[i] -= LEARNING_RATE * gradW[i];
    }
    b -= LEARNING_RATE * (gradB / n);
  }

  return { weights: w, bias: b, featureMean: mean, featureStd: std };
}

export class CalibrationModel {
  private weights: number[];
  private bias: number;
  private samples: CalibrationSample[] = [];
  private featureCount: number;
  private restoredSampleCount = 0;
  // BUGFIX (аудит "калибровка: 0 сигналов после 100"): нормализация,
  // применяемая к входу predict() перед умножением на weights — должна
  // быть РОВНО ТОЙ ЖЕ, что использовалась при обучении этих весов (см.
  // trainLogisticRegression). По умолчанию — нейтральная (mean=0/std=1,
  // то есть no-op), пока модель ни разу не обучалась: predict() тогда
  // просто применяет веса как есть (все нули изначально -> sigmoid(0)).
  private featureMean: number[];
  private featureStd: number[];

  constructor(featureCount: number) {
    this.featureCount = featureCount;
    this.weights = new Array<number>(featureCount).fill(0);
    this.bias = 0;
    this.featureMean = new Array<number>(featureCount).fill(0);
    this.featureStd = new Array<number>(featureCount).fill(1);
  }

  isReady(): boolean {
    return this.getSampleCount() >= MIN_SAMPLES;
  }

  getSampleCount(): number {
    return Math.max(this.samples.length, this.restoredSampleCount);
  }

  addSample(sample: CalibrationSample): void {
    if (sample.features.length !== this.featureCount) return;
    this.samples.push(sample);
    if (this.samples.length > MAX_SAMPLES) {
      this.samples.shift();
    }
  }

  predict(features: number[]): number {
    if (features.length !== this.featureCount) return sigmoid(0);
    let z = this.bias;
    for (let i = 0; i < this.featureCount; i++) {
      // BUGFIX (аудит "калибровка: 0 сигналов после 100"): применяем ту же
      // стандартизацию (featureMean/featureStd), на которой были обучены
      // weights — см. trainLogisticRegression. std всегда >= 1e-6-масштаба
      // (computeFeatureStats гарантирует std=1, не 0, для константных
      // признаков), но на всякий случай ещё раз страхуемся от деления на 0
      // здесь же (`|| 1`), чтобы гарантированно легитимное (пусть даже
      // непрогретое дефолтное) состояние модели никогда не могло вернуть
      // NaN из-за постороннего повреждения featureStd (например, ручной
      // правки localStorage).
      const normalized = (features[i] - this.featureMean[i]) / (this.featureStd[i] || 1);
      z += this.weights[i] * normalized;
    }
    return sigmoid(z);
  }

  // Synchronous full-batch retrain. Kept for unit tests
  // (calibration-model.test.ts) and as the single source of truth for the
  // training algorithm. Production code paths (engine.ts, useTickStore.ts)
  // no longer call this directly — they offload the same computation to
  // the worker via workerClient.retrainCalibration() and apply the result
  // with applyTrainedWeights() instead, so the UI thread never blocks on
  // the 500-epoch gradient descent below.
  retrain(): void {
    if (this.samples.length < MIN_SAMPLES) return;
    const result = trainLogisticRegression(this.samples, this.featureCount);
    this.weights = result.weights;
    this.bias = result.bias;
    this.featureMean = result.featureMean;
    this.featureStd = result.featureStd;
  }

  // Applies a training result computed elsewhere (e.g. in the worker) directly,
  // without recomputing anything.
  applyTrainedWeights(result: TrainingResult): void {
    this.weights = [...result.weights];
    this.bias = result.bias;
    this.featureMean = [...result.featureMean];
    this.featureStd = [...result.featureStd];
  }

  exportState(): CalibrationState {
    return {
      weights: [...this.weights],
      bias: this.bias,
      sampleCount: this.getSampleCount(),
      featureMean: [...this.featureMean],
      featureStd: [...this.featureStd],
    };
  }

  loadState(state: CalibrationState): void {
    if (state.weights.length !== this.featureCount) return;
    this.weights = [...state.weights];
    this.bias = state.bias;
    this.restoredSampleCount = state.sampleCount;
    // BUGFIX (аудит "калибровка: 0 сигналов после 100"): состояния,
    // сохранённые ДО этого фикса, не содержат featureMean/featureStd —
    // откатываемся на нейтральную (no-op) нормализацию, чтобы не упасть на
    // undefined и не поменять поведение уже загруженных (пусть и потенциально
    // испорченных прошлым багом) весов молча. Реальное исцеление для уже
    // испорченных состояний — в loadCalibrationState() ниже, которая при
    // отсутствии featureMean принудительно переобучает модель на уже
    // накопленных (валидных!) сэмплах.
    this.featureMean =
      state.featureMean && state.featureMean.length === this.featureCount
        ? [...state.featureMean]
        : new Array<number>(this.featureCount).fill(0);
    this.featureStd =
      state.featureStd && state.featureStd.length === this.featureCount
        ? [...state.featureStd]
        : new Array<number>(this.featureCount).fill(1);
  }

  loadSamples(samples: CalibrationSample[]): void {
    this.samples = samples.slice(-MAX_SAMPLES);
  }

  getSamples(): CalibrationSample[] {
    return [...this.samples];
  }
}

// Этап 1 аудита ("КАЛИБРОВКА" и "АНАЛИТИКА ПО ФАКТОРАМ" не связаны, п.1):
// раньше localStorage-ключ был один на всё приложение (STORAGE_KEY без
// суффикса) — модель, обученная на BTCUSDT, молча подмешивалась к EURUSD и
// наоборот при переключении инструмента. symbolId теперь необязательный
// параметр: вызов БЕЗ него (как в существующих юнит-тестах
// calibration-model.test.ts) сохраняет старое поведение и старый ключ один
// в один — ничего не ломает и продолжает читать/писать данные, накопленные
// до этого фикса. Вызовы С symbolId (useTickStore.ts, per-symbol Map) пишут
// в отдельный ключ на инструмент.
function storageKeyFor(symbolId?: string): string {
  return symbolId ? `${STORAGE_KEY}:${symbolId}` : STORAGE_KEY;
}

export function loadCalibrationState(featureCount: number, symbolId?: string): CalibrationModel | null {
  try {
    const raw = localStorage.getItem(storageKeyFor(symbolId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state: CalibrationState; samples: CalibrationSample[] };
    if (!parsed.state || parsed.state.weights.length !== featureCount) return null;
    const model = new CalibrationModel(featureCount);
    model.loadState(parsed.state);
    if (Array.isArray(parsed.samples)) {
      model.loadSamples(parsed.samples);
    }
    // BUGFIX (аудит "калибровка: 0 сигналов после 100" — самоисцеление уже
    // застрявших пользователей): состояние без featureMean было сохранено
    // ДО фикса нормализации в trainLogisticRegression — его веса могли быть
    // обучены на сырых (ненормированных) признаках и НАСЫЩЕНЫ (predict()
    // залипает на константе ~0 или ~1 для любого входа, см. подробный
    // комментарий у trainLogisticRegression). Просто загрузить такое
    // состояние — значит воспроизвести тот же баг после каждой перезагрузки
    // страницы, БЕССРОЧНО: новые обучающие сэмплы берутся только из исходов
    // уже созданных сигналов, а создание сигналов и заблокировано этим же
    // багом (calibratedProbability застряла ниже priorityThreshold) — то
    // есть без вмешательства модель никогда не получит повод переобучиться
    // сама. Сами по себе сэмплы (features/outcome) багом не затронуты — баг
    // был только в обучении, не в данных, — поэтому переобучаем немедленно
    // по уже накопленной (и просто загруженной строкой выше) истории,
    // ФИКСОМ, вместо того чтобы ждать новый исход, которому взяться неоткуда.
    if (model.isReady() && !parsed.state.featureMean) {
      model.retrain();
    }
    return model;
  } catch {
    return null;
  }
}

export function persistCalibrationState(model: CalibrationModel, symbolId?: string): void {
  try {
    const data = JSON.stringify({
      state: model.exportState(),
      samples: model.getSamples(),
    });
    localStorage.setItem(storageKeyFor(symbolId), data);
  } catch {
    // localStorage may be unavailable — non-fatal
  }
}
