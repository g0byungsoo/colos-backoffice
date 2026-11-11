import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createConversation } from "../agents/phone.js";
import {
  approveInvoice,
  previewInvoice,
  sendInvoice,
} from "../backoffice/invoices.js";
import { negotiate } from "../backoffice/negotiation.js";
import { refreshPrices } from "../backoffice/prices.js";
import { getConfig } from "../config/index.js";
import { doctor } from "../data/doctor.js";
import { createDataSource, RequestDataSource, seed } from "../data/index.js";
import { parseCallTime } from "../domain/time.js";
import { getEmbedder, llmReranker, RagIndex } from "../rag/index.js";

const [command, ...raw] = process.argv.slice(2);
const args = raw.filter((a) => a !== "--");
const option = (key: string) => {
  const index = args.indexOf(key);
  return index >= 0 ? args[index + 1] : undefined;
};
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
try {
  const config = getConfig(
    args.includes("--offline")
      ? { ...process.env, OPENAI_API_KEY: "" }
      : process.env,
  );
  const at = parseCallTime(option("--at"), config.TIMEZONE);
  if (Number.isNaN(at.getTime())) throw new Error("Invalid --at timestamp");
  if (command === "doctor") {
    const result = await doctor(config);
    print(result);
    if (!result.ok) process.exitCode = 1;
  } else {
    const raw = createDataSource(config);
    const data = new RequestDataSource(raw);
    switch (command) {
      case "seed":
        print(await seed(raw, args.includes("--force")));
        break;
      case "index": {
        const index = new RagIndex(
          data,
          getEmbedder(config, { offline: !config.OPENAI_API_KEY }),
          {
            cacheDir: `${config.RUNTIME_DIR}/.cache/rag`,
            reranker:
              config.RAG_RERANK && config.OPENAI_API_KEY
                ? llmReranker(config.OPENAI_MODEL)
                : undefined,
          },
        );
        print(await index.build());
        console.log(
          config.OPENAI_API_KEY
            ? "OpenAI embeddings"
            : "Offline deterministic embeddings",
        );
        break;
      }
      case "chat": {
        const conversation = await createConversation({
          data: raw,
          config,
          from: option("--from") ?? "+15555550199",
          at,
          onTool: (call) => print({ tool: call }),
        });
        print({
          route: conversation.route,
          mode: config.OPENAI_API_KEY
            ? "live"
            : "offline deterministic adapter",
        });
        const input = createInterface({
          input: process.stdin,
          output: process.stdout,
          terminal: process.stdin.isTTY,
        });
        for await (const line of input) {
          if (line.trim() === "/quit") break;
          console.log((await conversation.turn(line)).text);
        }
        await conversation.finish();
        break;
      }
      case "negotiate":
        if (!args[0]) throw new Error("Provide an email file");
        print(
          await negotiate(data, config, await readFile(args[0], "utf8"), {
            now: at,
          }),
        );
        break;
      case "prices:refresh":
        print(await refreshPrices(data, config, { now: at }));
        break;
      case "invoice:preview":
      case "invoice:approve":
      case "invoice:send": {
        if (!args[0]) throw new Error("Provide an order id");
        const fn =
          command === "invoice:preview"
            ? previewInvoice
            : command === "invoice:approve"
              ? approveInvoice
              : sendInvoice;
        print(
          await fn(data, config, args[0], {
            now: at,
            method: option("--method") === "card" ? "card" : "wire",
          }),
        );
        break;
      }
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
