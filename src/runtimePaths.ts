import "./environment";
import { resolve } from "node:path";

/** Installed code and private operator data can live in separate directories. */
export const APPLICATION_ROOT = resolve(__dirname, "..");
export const DATA_ROOT = resolve(process.env.BROWSER_AGENT_DATA_DIR || APPLICATION_ROOT);
