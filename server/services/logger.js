// This module is also loaded by out-of-repo probes (e.g. the rain-engine
// watcher requiring server/services/* from a bare git worktree with no
// node_modules), so winston and config/dotenv must stay optional: when they
// can't be resolved, fall back to a console logger with the same interface
// instead of throwing at require time.
let winston = null;
try {
  winston = require('winston');
} catch (err) {
  if (err.code !== 'MODULE_NOT_FOUND') throw err;
}

let nodeEnv;
try {
  nodeEnv = require('../config').nodeEnv;
} catch (err) {
  if (err.code !== 'MODULE_NOT_FOUND') throw err;
  nodeEnv = process.env.NODE_ENV || 'development';
}

let logger;

if (winston) {
  logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.errors({ stack: true }),
      winston.format.json()
    ),
    defaultMeta: { service: 'waves-portal' },
    transports: [
      new winston.transports.Console({
        format: nodeEnv === 'development'
          ? winston.format.combine(
              winston.format.colorize(),
              winston.format.printf(({ timestamp, level, message, ...meta }) => {
                const metaStr = Object.keys(meta).length > 1
                  ? ` ${JSON.stringify(meta)}` : '';
                return `${timestamp} [${level}] ${message}${metaStr}`;
              })
            )
          : winston.format.json(),
      }),
    ],
  });
} else {
  const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
  const threshold = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;
  const write = (level, args) => {
    if (LEVELS[level] > threshold) return;
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const method = level === 'debug' ? 'log' : level;
    console[method](`${timestamp} [${level}]`, ...args);
  };
  logger = {
    error: (...args) => write('error', args),
    warn: (...args) => write('warn', args),
    info: (...args) => write('info', args),
    debug: (...args) => write('debug', args),
  };
}

module.exports = logger;
