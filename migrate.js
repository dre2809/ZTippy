'use strict';

const db = require('./src/db');
const logger = require('./src/logger');

try {
  db.migrate();
  logger.info('All migrations applied successfully.');
  process.exit(0);
} catch (err) {
  logger.error('Migration failed:', err);
  process.exit(1);
}
