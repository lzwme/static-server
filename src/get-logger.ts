import { color } from 'console-log-colors';
import { NLogger, type LogLevelType } from '@lzwme/fe-utils';

function getLogger(levelType?: LogLevelType, logDir?: string): NLogger {
  return NLogger.getLogger('[sserver]', { levelType, color, logDir });
}

export const logger = getLogger();
