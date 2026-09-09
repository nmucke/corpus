import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from './service.js';

const command = process.argv[2];
if (!['status', 'sync', 'export'].includes(command)) {
  console.error('Usage: node server/cli.js status|sync|export');
  process.exitCode = 1;
} else {
  let service;
  try {
    service = await createService({ dataDir: resolve(process.env.CORPUS_DATA_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '../data')) });
    if (command === 'sync') console.log(JSON.stringify(await service.sync(), null, 2));
    else if (command === 'export') console.log(JSON.stringify(await service.exportMarkdown(), null, 2));
    else {
      const state = await service.getState();
      console.log(JSON.stringify({ mode: state.mode, settings: state.settings, workouts: state.workouts.length, routines: state.routines.length, programs: state.programs.length }, null, 2));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally { service?.close(); }
}
