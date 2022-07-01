export * from './static-server';

import { initServer } from './static-server';

if (module === require.main) initServer();
