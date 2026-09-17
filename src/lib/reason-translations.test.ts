import { describe, it, expect } from 'vitest';
import { translateReason } from './reason-translations';

describe('translateReason', () => {
  it('translates a BOS fragment', () => {
    expect(translateReason('BOS bullish')).toEqual(['Слом структуры вверх (BOS)']);
  });

  it('translates a CHoCH fragment', () => {
    expect(translateReason('CHoCH bearish')).toEqual(['Смена характера тренда вниз (CHoCH)']);
  });

  it('translates RSI oversold/overbought and keeps the numeric value', () => {
    expect(translateReason('RSI oversold (28.4)')).toEqual(['RSI в зоне перепроданности (28.4)']);
    expect(translateReason('RSI overbought (71.2)')).toEqual(['RSI в зоне перекупленности (71.2)']);
  });

  it('translates an untouched order block fragment without a touch count', () => {
    expect(translateReason('Untouched bullish OB nearby')).toEqual([
      'Непротестированный бычий ордер-блок рядом',
    ]);
  });

  it('translates a tested order block fragment and preserves the touch count', () => {
    expect(translateReason('Tested bearish OB holding (3 touches)')).toEqual([
      'Протестированный медвежий ордер-блок рядом (3 касан.)',
    ]);
  });

  it('translates a pattern fragment using the Russian pattern dictionary', () => {
    expect(translateReason('order-block-continuation pattern (72%)')).toEqual([
      'Паттерн "Продолжение от ордер-блока" (72% уверенности)',
    ]);
  });

  it('translates a pattern fragment with confirming-patterns fusion suffix', () => {
    expect(translateReason('hammer pattern (65%) + 2 confirming patterns')).toEqual([
      'Паттерн "Молот" (65% уверенности) + ещё 2 подтверждающих паттерна',
    ]);
  });

  it('translates OBC / MDM strategy confirmation fragments', () => {
    expect(translateReason('OBC strategy (+0.30)')).toEqual([
      'Подтверждение стратегией Order Block Continuation',
    ]);
    expect(translateReason('MDM strategy (+0.18)')).toEqual([
      'Подтверждение стратегией MACD Deceleration',
    ]);
  });

  it('translates OB Nested / OB Breaker Block strategy confirmation fragments', () => {
    expect(translateReason('OB Nested strategy (+0.32)')).toEqual([
      'Подтверждение стратегией "Вложенный ордер-блок"',
    ]);
    expect(translateReason('OB Breaker Block strategy (+0.25)')).toEqual([
      'Подтверждение стратегией "Брейкер-блок ордер-блока"',
    ]);
  });

  it('splits a realistic multi-fragment reason and translates each part', () => {
    const reason = 'BOS bullish; RSI oversold (28.4); order-block-continuation pattern (72%)';
    expect(translateReason(reason)).toEqual([
      'Слом структуры вверх (BOS)',
      'RSI в зоне перепроданности (28.4)',
      'Паттерн "Продолжение от ордер-блока" (72% уверенности)',
    ]);
  });

  it('returns an unmatched fragment unchanged instead of dropping information', () => {
    expect(translateReason('Some future indicator fragment')).toEqual([
      'Some future indicator fragment',
    ]);
  });

  it('translates type-specific harmonic strategy fragments with Russian harmonic names', () => {
    expect(translateReason('gartley harmonic strategy (+0.50)')).toEqual([
      'Подтверждение гармоническим паттерном «Гартли»',
    ]);
    expect(translateReason('butterfly harmonic strategy (+0.50)')).toEqual([
      'Подтверждение гармоническим паттерном «Бабочка»',
    ]);
    expect(translateReason('ab-cd harmonic strategy (+0.50)')).toEqual([
      'Подтверждение гармоническим паттерном «AB=CD»',
    ]);
  });

  it('returns an empty array for an empty reason', () => {
    expect(translateReason('')).toEqual([]);
  });
});
