import { pino, type DestinationStream, type Logger } from 'pino';

export type { Logger };

/**
 * JSON-lines logs. Every line about an experiment carries `experimentId`, `stage` and `attempt`
 * (as child-logger bindings), so one experiment's history can be grepped out of the stream.
 */
export function createLogger(level = 'info', destination?: DestinationStream): Logger {
  const options = { name: 'research-worker', level, base: { pid: process.pid } };
  return destination ? pino(options, destination) : pino(options);
}
