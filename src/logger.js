// src/logger.js
// Centralised winston logger for the bot.
// Logs to console (with colorized output) and optionally to a file.
// Adjust transports as needed.

import winston from 'winston';

const { combine, timestamp, printf, colorize } = winston.format;

const logFormat = printf(({ level, message, timestamp }) => {
  return `${timestamp} [${level}]: ${message}`;
});

const logger = winston.createLogger({
  level: 'info',
  format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), colorize(), logFormat),
  transports: [
    new winston.transports.Console(),
    // Uncomment the following line to enable file logging.
    // new winston.transports.File({ filename: 'bot.log', level: 'info' })
  ],
});

export default logger;
