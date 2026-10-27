import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { defineConfig } from "hardhat/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers],
  solidity: {
    version: "0.8.36",
    path:
      process.env.DEX_SOLC ??
      fileURLToPath(new URL("../.local/toolchain/solc", import.meta.url)),
    settings: {
      // 兼容教学中使用的 Ganache 节点。
      evmVersion: "paris",
      optimizer: { enabled: true, runs: 200 },
      viaIR: false,
    },
  },
  networks: {
    hardhat: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: 31337,
    },
    localhost: {
      type: "http",
      chainType: "l1",
      chainId: 31337,
      url: process.env.LOCAL_RPC_URL ?? "http://127.0.0.1:8545",
      accounts: "remote",
    },
    ganache: {
      type: "http",
      chainType: "l1",
      url: process.env.GANACHE_RPC_URL ?? "http://127.0.0.1:8545",
      accounts: "remote",
    },
  },
});
