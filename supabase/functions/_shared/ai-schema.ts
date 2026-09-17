import { z } from 'npm:zod@3.23.8';

export const AIAnalysisSchema = z.object({
  trend: z.enum(['bullish', 'bearish', 'sideways']),
  confidence: z.number().min(0).max(100),
  levels: z.object({ support: z.number(), resistance: z.number() }),
  recommendation: z.enum(['buy', 'sell', 'wait']),
  reasoning: z.string().min(10),
  keyLevels: z.array(z.number()).optional(),
  riskNote: z.string().optional(),
});

export const AI_ANALYSIS_JSON_SCHEMA = {
  type: 'OBJECT',
  properties: {
    trend: { type: 'STRING', enum: ['bullish', 'bearish', 'sideways'] },
    confidence: { type: 'NUMBER' },
    levels: {
      type: 'OBJECT',
      properties: { support: { type: 'NUMBER' }, resistance: { type: 'NUMBER' } },
      required: ['support', 'resistance'],
    },
    recommendation: { type: 'STRING', enum: ['buy', 'sell', 'wait'] },
    reasoning: { type: 'STRING' },
    keyLevels: { type: 'ARRAY', items: { type: 'NUMBER' } },
    riskNote: { type: 'STRING' },
  },
  required: ['trend', 'confidence', 'levels', 'recommendation', 'reasoning'],
} as const;
