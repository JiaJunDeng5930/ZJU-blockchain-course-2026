import { readFile } from "node:fs/promises";

const path = new URL("../.local/toolchain/environment.json", import.meta.url);
let environment;
try {
  environment = JSON.parse(await readFile(path, "utf8"));
} catch (error) {
  // DEFENSE: a fresh checkout has not prepared its isolated proof toolchain.
  if (error.code === "ENOENT")
    throw new Error(
      "The formal toolchain is missing. Run npm run formal:bootstrap first.",
    );
  throw error;
}
const overrides = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key.startsWith("DEX_")),
);
Object.assign(process.env, environment, overrides);

process.env.SOLC_BINARY = process.env.DEX_SOLC;
