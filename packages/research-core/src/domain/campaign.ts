import { z } from 'zod';
import { VerificationSuiteSchema } from './experiment.js';
import { RepoPathSchema } from './primitives.js';

export const CAMPAIGN_STATUSES = [
  'CREATED',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'CANCELLED',
  'FAILED',
] as const;
export const CampaignStatusSchema = z.enum(CAMPAIGN_STATUSES);
export type CampaignStatus = z.infer<typeof CampaignStatusSchema>;

/** The audit trail of a campaign: budgets, duplicates, and who paused or resumed it. */
export const CAMPAIGN_EVENT_TYPES = [
  'started',
  'paused',
  'resumed',
  'cancelled',
  'completed',
  'budget-exceeded',
  'budget-raised',
  'duplicate-candidate',
] as const;
export const CampaignEventTypeSchema = z.enum(CAMPAIGN_EVENT_TYPES);
export type CampaignEventType = z.infer<typeof CampaignEventTypeSchema>;

export const CAMPAIGN_OBJECTIVES = ['minimize-area-delay-product'] as const;
export const CampaignObjectiveSchema = z.enum(CAMPAIGN_OBJECTIVES);
export type CampaignObjective = z.infer<typeof CampaignObjectiveSchema>;

const positiveCount = z.number().int().positive();

/** A campaign file (brief §16) plus the budgets of decisions §5, which are all optional. */
export const CampaignConfigSchema = z
  .strictObject({
    name: z.string().min(1),
    target: z.string().min(1),
    baseline: z.string().min(1),
    objective: CampaignObjectiveSchema,
    maxExperiments: positiveCount,
    maxConcurrentExperiments: positiveCount,
    maxRuntimeHours: z.number().positive(),
    allowedChanges: z.array(RepoPathSchema).min(1),
    requiredVerification: z.array(VerificationSuiteSchema).min(1),
    stopConditions: z.strictObject({
      targetImprovementPercent: z.number().positive().optional(),
      stopOnBudgetExceeded: z.boolean(),
    }),
    maxAgentInvocations: positiveCount.optional(),
    maxTokens: positiveCount.optional(),
    maxAgentCostUsd: z.number().positive().optional(),
    maxEdaHours: z.number().positive().optional(),
    maxArtifactBytes: positiveCount.optional(),
  })
  .refine((config) => config.maxConcurrentExperiments <= config.maxExperiments, {
    message: 'maxConcurrentExperiments must not exceed maxExperiments',
    path: ['maxConcurrentExperiments'],
  });
export type CampaignConfig = z.infer<typeof CampaignConfigSchema>;
