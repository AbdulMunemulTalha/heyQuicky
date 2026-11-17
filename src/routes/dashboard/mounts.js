import { shellRoutes } from './shell.js';
import { overviewRoutes } from './overview.js';

// Dashboard feature routers, mounted under /api/dash in this order. Each is (db, config, ctx) => Router.
export const dashboardMounts = [shellRoutes, overviewRoutes];
