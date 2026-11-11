import { handle } from "hono/vercel";
import { getConfig } from "../src/config/index.js";
import { createDataSource } from "../src/data/index.js";
import { createApp } from "../src/server/app.js";

const config = getConfig({ ...process.env, RUNTIME_DIR: "/tmp/colos" });
export default handle(createApp(() => createDataSource(config), config));
