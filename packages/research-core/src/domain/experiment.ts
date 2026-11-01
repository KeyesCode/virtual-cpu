import { z } from 'zod';

/** The experiment lifecycle (brief §6). Which moves are legal belongs to the state machine. */
export const EXPERIMENT_STATES = [
  'CREATED',
  'QUEUED',
  'PREPARING',
  'GENERATING',
  'STATIC_VALIDATION',
  'COMPILING',
  'VERIFYING',
  'SYNTHESIZING',
  'PHYSICAL_ANALYSIS',
  'SCORING',
  'COMPLETED',
  'REJECTED',
  'FAILED',
  'CANCELLED',
] as const;
export const ExperimentStateSchema = z.enum(EXPERIMENT_STATES);
export type ExperimentState = z.infer<typeof ExperimentStateSchema>;

export const FAILURE_CLASSES = [
  'incorrect-design',
  'unsupported-design',
  'tool-failure',
  'timeout',
  'infrastructure-failure',
  'budget-exceeded',
  'policy-violation',
] as const;
export const FailureClassSchema = z.enum(FAILURE_CLASSES);
export type FailureClass = z.infer<typeof FailureClassSchema>;

export const AGENT_PROVIDERS = ['claude-code', 'codex'] as const;
export const AgentProviderSchema = z.enum(AGENT_PROVIDERS);
export type AgentProvider = z.infer<typeof AgentProviderSchema>;

/** The correctness gates of decisions §2. */
export const VERIFICATION_SUITES = [
  'lint',
  'unit',
  'differential',
  'randomized',
  'structural',
] as const;
export const VerificationSuiteSchema = z.enum(VERIFICATION_SUITES);
export type VerificationSuite = z.infer<typeof VerificationSuiteSchema>;

/** The kinds of finding a report keeps apart: only `verified` may be presented as established. */
export const FINDING_TYPES = ['verified', 'estimated', 'ai-interpreted', 'unresolved'] as const;
export const FindingTypeSchema = z.enum(FINDING_TYPES);
export type FindingType = z.infer<typeof FindingTypeSchema>;

export const CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const;
export const ConfidenceLevelSchema = z.enum(CONFIDENCE_LEVELS);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevelSchema>;

export const ARTIFACT_KINDS = [
  'candidate-source',
  'patch',
  'test-vectors',
  'verification-report',
  'synthesis-report',
  'timing-report',
  'power-report',
  'agent-output',
  'tool-log',
  'waveform',
  'experiment-config',
  'reproducibility-manifest',
] as const;
export const ArtifactKindSchema = z.enum(ARTIFACT_KINDS);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;
