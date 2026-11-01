import 'reflect-metadata';
import { createDataSource } from './data-source.js';

const action = process.argv[2];
if (action !== 'run' && action !== 'revert') {
  console.error('usage: migrate.ts run|revert');
  process.exit(2);
}

const dataSource = createDataSource();
await dataSource.initialize();
try {
  if (action === 'run') {
    const applied = await dataSource.runMigrations();
    console.log(
      applied.length > 0
        ? `applied: ${applied.map((migration) => migration.name).join(', ')}`
        : 'no pending migrations',
    );
  } else {
    await dataSource.undoLastMigration();
    console.log('reverted the last migration');
  }
} finally {
  await dataSource.destroy();
}
