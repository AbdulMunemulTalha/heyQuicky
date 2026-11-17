import { shellRoutes } from './shell.js';
import { overviewRoutes } from './overview.js';
import { inboxRoutes } from './inbox.js';
import { commentRoutes } from './comments.js';
import { orderRoutes } from './orders.js';
import { orderDetailRoutes } from './orderDetail.js';
import { customerRoutes } from './customers.js';
import { growthRoutes } from './growth.js';
import { savedReplyRoutes } from './savedReplies.js';
import { agentRoutes } from './agent.js';
import { catalogRoutes } from './catalog.js';

// Dashboard feature routers, mounted under /api/dash in this order. Each is (db, config, ctx) => Router.
export const dashboardMounts = [shellRoutes, overviewRoutes, inboxRoutes, commentRoutes, orderRoutes, orderDetailRoutes, customerRoutes, growthRoutes, savedReplyRoutes, agentRoutes, catalogRoutes];
