// blockchain/scripts/deploy.js
// Deploys BlueCarbonRegistry and writes a deployment file (address, chain id, ABI) that the backend reads.
//
//   npx hardhat node                                              (terminal 1)
//   npx hardhat run scripts/deploy.js --network localhost         (terminal 2)
//
// Local development: Hardhat's unlocked accounts are assigned development roles
//   [0] NCCR admin   [1] verifier A   [2] registrar (backend service)   [3] verifier B
// Other networks: set VERIFIER_ADDRESSES (comma separated) and REGISTRAR_ADDRESS in the environment.
// No private keys are stored in this repository.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const { ethers, network, artifacts } = hre;
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  console.log(`Deploying BlueCarbonRegistry to ${network.name} as NCCR admin ${deployer.address}`);

  const reg = await (await ethers.getContractFactory("BlueCarbonRegistry")).deploy();
  await reg.waitForDeployment();
  const address = await reg.getAddress();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  console.log("Deployed at", address);

  let verifiers = [], registrar = null;
  if (network.name === "localhost" || network.name === "hardhat") {
    verifiers = [signers[1].address, signers[3].address];
    registrar = signers[2].address;
  } else {
    verifiers = (process.env.VERIFIER_ADDRESSES || "").split(",").map((s) => s.trim()).filter(Boolean);
    registrar = process.env.REGISTRAR_ADDRESS || null;
  }
  for (const v of verifiers) { await (await reg.setVerifier(v, true)).wait(); console.log("  verifier role ->", v); }
  if (registrar) { await (await reg.setRegistrar(registrar, true)).wait(); console.log("  registrar role ->", registrar); }

  const artifact = await artifacts.readArtifact("BlueCarbonRegistry");
  const deployTx = reg.deploymentTransaction();
  const deployBlock = deployTx ? (await deployTx.wait()).blockNumber : null;
  // keccak-256 of the deployed runtime bytecode: the API compares it with the code found at the address on startup.
  const codeHash = ethers.keccak256(await ethers.provider.getCode(address));
  const out = {
    contract: "BlueCarbonRegistry",
    address, chainId, network: network.name, deployBlock, codeHash,
    admin: deployer.address, verifiers, registrar,
    deployedAt: new Date().toISOString(),
    abi: artifact.abi,
  };
  const file = process.env.DEPLOYMENT_FILE || path.join(__dirname, "..", "deployments", `${network.name}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log("Deployment file written:", file);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
