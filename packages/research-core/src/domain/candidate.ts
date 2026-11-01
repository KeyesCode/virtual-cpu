import { z } from 'zod';
import { GitCommitSchema, RepoPathSchema, Sha256Schema } from './primitives.js';

export const CANDIDATE_VALIDATION_STATUSES = ['pending', 'valid', 'invalid'] as const;
export const CandidateValidationStatusSchema = z.enum(CANDIDATE_VALIDATION_STATUSES);
export type CandidateValidationStatus = z.infer<typeof CandidateValidationStatusSchema>;

/** An immutable RTL candidate (brief §5), identified by its content. */
export const CandidateDescriptorSchema = z.strictObject({
  candidateHash: Sha256Schema,
  sourceCommit: GitCommitSchema.optional(),
  parentCandidateHash: Sha256Schema.optional(),
  changedFiles: z.array(RepoPathSchema).min(1),
  architectureParameters: z.record(z.string().min(1), z.union([z.number(), z.string()])),
});
export type CandidateDescriptor = z.infer<typeof CandidateDescriptorSchema>;
