import { serve } from "@hono/node-server";
import { getConfig } from "../config/index.js";
import { createDataSource } from "../data/index.js";
import { createApp } from "./app.js";

const config = getConfig();
serve({
  fetch: createApp(() => createDataSource(config), config).fetch,
  port: config.PORT,
});
console.log(`Colos listening on http://localhost:${config.PORT}`);
