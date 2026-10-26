// blockchain/hardhat.config.js
require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config({ path: "../backend/.env" });
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

// Compile with the pure-JS `solc` package (pinned in devDependencies) so the build also works
// offline / behind proxies that block the native compiler download. Set HARDHAT_NATIVE_SOLC=1
// to use Hardhat's default native-compiler download instead.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  if (process.env.HARDHAT_NATIVE_SOLC === "1" || args.solcVersion !== "0.8.20") return runSuper();
  return {
    compilerPath: require.resolve("solc/soljson.js"),
    isSolcJs: true,
    version: args.solcVersion,
    longVersion: require("solc").version(),
  };
});

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: { version: "0.8.20", settings: { optimizer: { enabled: true, runs: 200 } } },
  networks: {
    localhost: { url: process.env.ETH_RPC_URL || "http://127.0.0.1:8545" },
    // Optional public testnet. Provide the key through the environment only; never commit it.
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "",
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
  },
};
