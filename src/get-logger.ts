import { type LogLevelType, NLogger } from '@lzwme/fe-utils';
import { color } from 'console-log-colors';

function getLogger(levelType?: LogLevelType, logDir?: string): NLogger {
  return NLogger.getLogger('[sserver]', { levelType, color, logDir });
}

export const logger = getLogger();
