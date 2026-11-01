import { z } from 'zod';
import { type FailureClass, FailureClassSchema } from '../domain/experiment.js';

/** One captured output stream: where it was kept, and how much the command really wrote. */
export const LogCaptureSchema = z.object({
  path: z.string().min(1),
  /** The full size of the stream, including anything over the cap. */
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type LogCapture = z.infer<typeof LogCaptureSchema>;

/** One command as it really ran: enough to rerun it and to see how it ended. */
export const CommandRecordSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().min(1),
  /** The process (and process group) id, or null when it never started. */
  pid: z.number().int().positive().nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  wallTimeMs: z.number().nonnegative(),
  /** Null when it was ended by a signal or never started. */
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  /** Whether the runner ended it for overrunning its timeout. */
  timedOut: z.boolean(),
  /** Why it could not be started, or null. */
  spawnError: z.string().nullable(),
  stdout: LogCaptureSchema,
  stderr: LogCaptureSchema,
});
export type CommandRecord = z.infer<typeof CommandRecordSchema>;

/**
 * What one pipeline stage found. `failureClass` is null exactly when `ok` is true. `outcome` is the
 * stage's parsed result, whose shape belongs to the adapter that ran it.
 */
export const StageResultSchema = z
  .object({
    stage: z.string().min(1),
    ok: z.boolean(),
    failureClass: FailureClassSchema.nullable(),
    /** One line on why it failed, or null. */
    message: z.string().nullable(),
    commands: z.array(CommandRecordSchema),
    /** The version line of the tool, or null when it could not be established. */
    toolVersion: z.string().nullable(),
    wallTimeMs: z.number().nonnegative(),
    warnings: z.array(z.string()),
    outcome: z.unknown(),
  })
  .refine((stage) => stage.ok === (stage.failureClass === null), {
    message: 'failureClass must be null exactly when the stage is ok',
  });

export interface StageResult<TOutcome = unknown> extends Omit<
  z.infer<typeof StageResultSchema>,
  'outcome'
> {
  readonly outcome: TOutcome;
}

/**
 * The failure a command's ending shows by itself, or null for exit 0. A non-zero exit says only that
 * the tool failed; an adapter that can read the tool's output refines it to a design failure.
 */
export function classifyCommand(
  record: Pick<CommandRecord, 'exitCode' | 'spawnError' | 'timedOut'>,
): FailureClass | null {
  if (record.spawnError !== null) return 'infrastructure-failure';
  if (record.timedOut) return 'timeout';
  return record.exitCode === 0 ? null : 'tool-failure';
}
