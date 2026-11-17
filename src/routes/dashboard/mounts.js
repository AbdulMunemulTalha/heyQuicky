import { shellRoutes } from './shell.js';
import { overviewRoutes } from './overview.js';
import { inboxRoutes } from './inbox.js';
import { commentRoutes } from './comments.js';

// Dashboard feature routers, mounted under /api/dash in this order. Each is (db, config, ctx) => Router.
export const dashboardMounts = [shellRoutes, overviewRoutes, inboxRoutes, commentRoutes];
