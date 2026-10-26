// Tests for the PROPOSED BlueCarbonRegistryCancellation contract (not deployed, not used by the backend).
const { expect } = require("chai");
const { ethers } = require("hardhat");

const id = (s) => ethers.id(s), H = (s) => ethers.id("hash:" + s), REF = (s) => ethers.id("ref:" + s);
const Decision = { VERIFIED: 0 };
const ZERO = ethers.ZeroHash;

describe("BlueCarbonRegistryCancellation (proposal)", function () {
  let reg, admin, verifier, registrar, holder, buyer, outsider;
  const P = id("project:TEST-1"), R = id("record:TEST-1-R1"), R2 = id("record:TEST-1-R2");

  beforeEach(async () => {
    [admin, verifier, registrar, holder, buyer, outsider] = await ethers.getSigners();
    reg = await (await ethers.getContractFactory("BlueCarbonRegistryCancellation")).deploy();
    await reg.waitForDeployment();
    await reg.setVerifier(verifier.address, true);
    await reg.setRegistrar(registrar.address, true);
  });
  async function verified(rec = R) {
    if ((await reg.getProject(P)).registeredBy === ethers.ZeroAddress) await reg.connect(registrar).registerProject(P, H("meta"));
    await reg.connect(registrar).anchorRecord(P, rec, H("content" + rec), H("evidence"));
    await reg.connect(verifier).recordVerification(rec, Decision.VERIFIED, H("verification"));
  }
  async function issued(qty = 100, rec = R) { await verified(rec); await reg.issueCredits(rec, qty, H("estimate"), holder.address); }
  const supplyInvariant = async (records = [R]) => {
    let balances = 0n; for (const rec of records) for (const a of [holder, buyer, admin, outsider]) balances += await reg.batchBalanceOf(rec, a.address);
    expect(await reg.totalIssued()).to.equal(balances + (await reg.totalRetired()) + (await reg.totalCancelled()));
  };

  describe("backward compatibility", () => {
    it("keeps every original function and event signature", async () => {
      const original = (await ethers.getContractFactory("BlueCarbonRegistry")).interface, proposal = reg.interface;
      const sig = (i) => new Set([...i.fragments].filter((f) => ["function", "event"].includes(f.type)).map((f) => f.format("sighash")));
      const have = sig(proposal);
      for (const s of sig(original)) expect(have.has(s), `missing ${s}`).to.equal(true);
      const added = [...have].filter((s) => !sig(original).has(s)).sort();
      expect(added).to.deep.equal([]);
    });
    it("behaves like the original until something is cancelled", async () => {
      await issued(100);
      await reg.connect(holder).transfer(R, buyer.address, 30, REF("t1"));
      await reg.connect(buyer).retire(R, 10, "Voluntary retirement", REF("r1"));
      expect(await reg.outstanding()).to.equal(90n); expect(await reg.totalCancelled()).to.equal(0n);
      expect(await reg.balanceOf(holder.address)).to.equal(70n); expect(await reg.batchRetired(R)).to.equal(10n);
      await supplyInvariant();
    });
  });

  describe("cancelCredits", () => {
    it("removes outstanding units from the holder, updates every counter and emits an event with the case hash and reference", async () => {
      await issued(100);
      await expect(reg.cancelCredits(R, holder.address, 20, H("case-1"), REF("c1"))).to.emit(reg, "CreditsCancelled").withArgs(R, holder.address, 20, H("case-1"), REF("c1"));
      expect(await reg.batchBalanceOf(R, holder.address)).to.equal(80n); expect(await reg.balanceOf(holder.address)).to.equal(80n);
      expect(await reg.batchCancelled(R)).to.equal(20n); expect(await reg.totalCancelled()).to.equal(20n);
      expect(await reg.totalIssued()).to.equal(100n, "issuance history is not rewritten");
      expect(await reg.outstanding()).to.equal(80n); expect(await reg.usedRef(REF("c1"))).to.equal(true);
      await supplyInvariant();
    });
    it("can cancel units held by a buyer after a transfer, but not units that were retired", async () => {
      await issued(100);
      await reg.connect(holder).transfer(R, buyer.address, 40, REF("t1"));
      await reg.connect(buyer).retire(R, 25, "retire", REF("r1"));
      await reg.cancelCredits(R, buyer.address, 15, H("case"), REF("c1"));
      expect(await reg.batchBalanceOf(R, buyer.address)).to.equal(0n);
      await expect(reg.cancelCredits(R, buyer.address, 1, H("case"), REF("c2"))).to.be.revertedWith("Insufficient batch balance");
      expect(await reg.batchRetired(R)).to.equal(25n, "retirement stays final");
      expect(await reg.outstanding()).to.equal(60n); // 100 issued - 25 retired - 15 cancelled
      await supplyInvariant();
    });
    it("is restricted to the administrator", async () => {
      await issued(100);
      for (const who of [verifier, registrar, holder, outsider]) await expect(reg.connect(who).cancelCredits(R, holder.address, 1, H("c"), REF("x" + who.address))).to.be.revertedWith("Only NCCR admin");
      expect(await reg.totalCancelled()).to.equal(0n);
    });
    it("applies separation of duties: the verifier of a record cannot cancel its credits even after becoming administrator", async () => {
      await issued(100);
      await reg.proposeAdmin(verifier.address); await reg.connect(verifier).acceptAdmin();
      await expect(reg.connect(verifier).cancelCredits(R, holder.address, 1, H("c"), REF("c1"))).to.be.revertedWith("Verifier cannot cancel own verification");
      await expect(reg.cancelCredits(R, holder.address, 1, H("c"), REF("c1"))).to.be.revertedWith("Only NCCR admin", "the former admin lost the role");
    });
    it("rejects invalid states and inputs without changing anything", async () => {
      await verified(R);
      await expect(reg.cancelCredits(R, holder.address, 1, H("c"), REF("c1"))).to.be.revertedWith("Record has no issued credits");
      await reg.issueCredits(R, 100, H("estimate"), holder.address);
      await expect(reg.cancelCredits(R2, holder.address, 1, H("c"), REF("c1"))).to.be.revertedWith("Record has no issued credits");
      await expect(reg.cancelCredits(R, holder.address, 0, H("c"), REF("c1"))).to.be.revertedWith("Amount must be > 0");
      await expect(reg.cancelCredits(R, holder.address, 1, ZERO, REF("c1"))).to.be.revertedWith("Case hash required");
      await expect(reg.cancelCredits(R, holder.address, 1, H("c"), ZERO)).to.be.revertedWith("Reference required");
      await expect(reg.cancelCredits(R, holder.address, 101, H("c"), REF("c1"))).to.be.revertedWith("Insufficient batch balance");
      await expect(reg.cancelCredits(R, outsider.address, 1, H("c"), REF("c1"))).to.be.revertedWith("Insufficient batch balance");
      expect(await reg.totalCancelled()).to.equal(0n); expect(await reg.outstanding()).to.equal(100n);
    });
    it("cannot be replayed, and a failed attempt does not consume its reference", async () => {
      await issued(100);
      await expect(reg.cancelCredits(R, holder.address, 500, H("c"), REF("c1"))).to.be.reverted;
      expect(await reg.usedRef(REF("c1"))).to.equal(false, "a reverted call leaves no trace");
      await reg.cancelCredits(R, holder.address, 10, H("c"), REF("c1"));
      await expect(reg.cancelCredits(R, holder.address, 10, H("c"), REF("c1"))).to.be.revertedWith("Reference already used");
      await reg.connect(holder).transfer(R, buyer.address, 1, REF("t1"));
      await expect(reg.cancelCredits(R, holder.address, 1, H("c"), REF("t1"))).to.be.revertedWith("Reference already used", "references are shared with transfers");
      await expect(reg.connect(holder).transfer(R, buyer.address, 1, REF("c1"))).to.be.revertedWith("Reference already used", "and with retirements");
      expect(await reg.totalCancelled()).to.equal(10n);
    });
    it("holds the supply invariant across a mixed sequence on two batches", async () => {
      await issued(100, R); await issued(50, R2);
      await reg.connect(holder).transfer(R, buyer.address, 30, REF("t1"));
      await reg.connect(holder).transfer(R2, buyer.address, 10, REF("t2"));
      await reg.connect(buyer).retire(R, 5, "r", REF("r1"));
      await reg.cancelCredits(R, buyer.address, 7, H("c1"), REF("c1"));
      await reg.cancelCredits(R2, holder.address, 40, H("c2"), REF("c2"));
      await reg.connect(holder).retireHashed(R, 3, H("why"), REF("rh1"));
      await supplyInvariant([R, R2]);
      expect(await reg.outstanding()).to.equal(150n - 5n - 3n - 7n - 40n);
      expect(await reg.batchCancelled(R)).to.equal(7n); expect(await reg.batchCancelled(R2)).to.equal(40n);
    });
  });

  describe("retireHashed", () => {
    it("retires with the same accounting as retire() and publishes only a hash of the reason", async () => {
      await issued(100);
      const tx = await reg.connect(holder).retireHashed(R, 10, H("reason-text-held-off-chain"), REF("rh1"));
      await expect(tx).to.emit(reg, "CreditsRetiredHashed").withArgs(R, holder.address, 10, H("reason-text-held-off-chain"), REF("rh1"));
      const receipt = await tx.wait(); expect(receipt.logs.length).to.equal(1);
      expect(await reg.balanceOf(holder.address)).to.equal(90n); expect(await reg.batchRetired(R)).to.equal(10n); expect(await reg.totalRetired()).to.equal(10n);
      expect(ethers.hexlify(receipt.logs[0].data)).to.not.include(ethers.hexlify(ethers.toUtf8Bytes("reason")).slice(2), "no free text in the log data");
      await supplyInvariant();
    });
    it("enforces balance, reference and amount rules and cannot be replayed", async () => {
      await issued(100);
      await expect(reg.connect(outsider).retireHashed(R, 1, H("x"), REF("a"))).to.be.revertedWith("Insufficient batch balance");
      await expect(reg.connect(holder).retireHashed(R, 0, H("x"), REF("a"))).to.be.revertedWith("Amount must be > 0");
      await expect(reg.connect(holder).retireHashed(R, 1, H("x"), ZERO)).to.be.revertedWith("Reference required");
      await expect(reg.connect(holder).retireHashed(R, 101, H("x"), REF("a"))).to.be.revertedWith("Insufficient batch balance");
      await reg.connect(holder).retireHashed(R, 1, H("x"), REF("a"));
      await expect(reg.connect(holder).retireHashed(R, 1, H("x"), REF("a"))).to.be.revertedWith("Reference already used");
    });
  });
});
