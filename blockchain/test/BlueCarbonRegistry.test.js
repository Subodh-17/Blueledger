// blockchain/test/BlueCarbonRegistry.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");

const id = (s) => ethers.id(s); // keccak256(utf8) -> bytes32
const H = (s) => ethers.id("hash:" + s);
const REF = (s) => ethers.id("ref:" + s);
const Decision = { VERIFIED: 0, REJECTED: 1, NEEDS_REVISION: 2 };
const Status = { NONE: 0, ANCHORED: 1, VERIFIED: 2, REJECTED: 3, NEEDS_REVISION: 4, CREDITED: 5 };

describe("BlueCarbonRegistry", function () {
  let reg, admin, verifier, registrar, holder, buyer, outsider;
  const P = id("project:TEST-1");
  const R = id("record:TEST-1-R1");

  beforeEach(async () => {
    [admin, verifier, registrar, holder, buyer, outsider] = await ethers.getSigners();
    reg = await (await ethers.getContractFactory("BlueCarbonRegistry")).deploy();
    await reg.waitForDeployment();
    await reg.setVerifier(verifier.address, true);
    await reg.setRegistrar(registrar.address, true);
  });

  async function anchored() {
    await reg.connect(registrar).registerProject(P, H("meta"));
    await reg.connect(registrar).anchorRecord(P, R, H("content"), H("evidence"));
  }
  async function verified() {
    await anchored();
    await reg.connect(verifier).recordVerification(R, Decision.VERIFIED, H("verification"));
  }
  async function issued(qty = 100) {
    await verified();
    await reg.issueCredits(R, qty, H("estimate"), holder.address);
  }

  it("exposes neutral registry-credit metadata", async () => {
    expect(await reg.name()).to.equal("Blue Carbon Registry Credit");
    expect(await reg.symbol()).to.equal("BCRC");
    expect(await reg.decimals()).to.equal(0);
  });

  describe("roles", () => {
    it("deployer is NCCR admin and registrar", async () => {
      expect(await reg.admin()).to.equal(admin.address);
      expect(await reg.isRegistrar(admin.address)).to.equal(true);
    });
    it("only admin manages roles", async () => {
      await expect(reg.connect(outsider).setVerifier(outsider.address, true)).to.be.revertedWith("Only NCCR admin");
      await expect(reg.connect(verifier).setRegistrar(outsider.address, true)).to.be.revertedWith("Only NCCR admin");
      await expect(reg.setVerifier(ethers.ZeroAddress, true)).to.be.revertedWith("Zero address");
    });
    it("administrator hand-over is two-step and only the proposed account can accept", async () => {
      await expect(reg.connect(outsider).proposeAdmin(buyer.address)).to.be.revertedWith("Only NCCR admin");
      await expect(reg.proposeAdmin(ethers.ZeroAddress)).to.be.revertedWith("Zero address");
      await expect(reg.proposeAdmin(buyer.address)).to.emit(reg, "AdminProposed").withArgs(admin.address, buyer.address);
      expect(await reg.admin()).to.equal(admin.address, "no change until accepted");
      await expect(reg.connect(outsider).acceptAdmin()).to.be.revertedWith("Not the proposed administrator");
      await expect(reg.connect(buyer).acceptAdmin()).to.emit(reg, "AdminTransferred").withArgs(admin.address, buyer.address);
      expect(await reg.admin()).to.equal(buyer.address);
      expect(await reg.pendingAdmin()).to.equal(ethers.ZeroAddress);
      await expect(reg.setVerifier(outsider.address, true)).to.be.revertedWith("Only NCCR admin");
      await expect(reg.connect(buyer).acceptAdmin()).to.be.revertedWith("Not the proposed administrator");
    });
    it("revoked roles lose their permissions immediately", async () => {
      await reg.connect(registrar).registerProject(P, H("m"));
      await reg.connect(registrar).anchorRecord(P, R, H("c"), H("e"));
      await reg.setVerifier(verifier.address, false);
      await expect(reg.connect(verifier).recordVerification(R, Decision.VERIFIED, H("v"))).to.be.revertedWith("Only verifier");
      await reg.setRegistrar(registrar.address, false);
      await expect(reg.connect(registrar).registerProject(id("project:other"), H("m"))).to.be.revertedWith("Only registrar");
      await expect(reg.connect(registrar).anchorRecord(P, id("record:x"), H("c"), H("e"))).to.be.revertedWith("Only registrar");
    });
  });

  describe("project + record anchoring", () => {
    it("registers a project once", async () => {
      await expect(reg.connect(registrar).registerProject(P, H("meta"))).to.emit(reg, "ProjectRegistered");
      await expect(reg.connect(registrar).registerProject(P, H("meta"))).to.be.revertedWith("Project already registered");
      expect((await reg.getProject(P)).exists).to.equal(true);
    });
    it("rejects unauthorised registration and anchoring", async () => {
      await expect(reg.connect(outsider).registerProject(P, H("m"))).to.be.revertedWith("Only registrar");
      await reg.connect(registrar).registerProject(P, H("m"));
      await expect(reg.connect(outsider).anchorRecord(P, R, H("c"), H("e"))).to.be.revertedWith("Only registrar");
    });
    it("anchors a record and refuses duplicates / unknown projects", async () => {
      await reg.connect(registrar).registerProject(P, H("m"));
      await expect(reg.connect(registrar).anchorRecord(P, R, H("c"), H("e")))
        .to.emit(reg, "RecordAnchored").withArgs(R, P, H("c"), H("e"), 1);
      await expect(reg.connect(registrar).anchorRecord(P, R, H("c2"), H("e")))
        .to.be.revertedWith("Record already anchored");
      await expect(reg.connect(registrar).anchorRecord(id("project:none"), id("record:x"), H("c"), H("e")))
        .to.be.revertedWith("Project not found");
    });
    it("cannot anchor into an inactive project", async () => {
      await reg.connect(registrar).registerProject(P, H("m"));
      await reg.setProjectActive(P, false);
      await expect(reg.connect(registrar).anchorRecord(P, R, H("c"), H("e"))).to.be.revertedWith("Project not active");
    });
  });

  describe("verification", () => {
    it("only verifiers can verify, and only anchored records", async () => {
      await anchored();
      await expect(reg.connect(outsider).recordVerification(R, Decision.VERIFIED, H("v"))).to.be.revertedWith("Only verifier");
      await expect(reg.connect(registrar).recordVerification(R, Decision.VERIFIED, H("v"))).to.be.revertedWith("Only verifier");
      await reg.connect(verifier).recordVerification(R, Decision.VERIFIED, H("v"));
      expect((await reg.getRecord(R)).status).to.equal(Status.VERIFIED);
      await expect(reg.connect(verifier).recordVerification(R, Decision.REJECTED, H("v2")))
        .to.be.revertedWith("Record not awaiting verification");
    });
    it("rejected is terminal", async () => {
      await anchored();
      await reg.connect(verifier).recordVerification(R, Decision.REJECTED, H("v"));
      expect((await reg.getRecord(R)).status).to.equal(Status.REJECTED);
      await expect(reg.connect(registrar).reanchorRecord(R, H("c2"), H("e2"))).to.be.revertedWith("Record not awaiting revision");
      await expect(reg.issueCredits(R, 10, H("est"), holder.address)).to.be.revertedWith("Record not verified");
    });
    it("needs-revision allows re-anchoring and a second verification", async () => {
      await anchored();
      await reg.connect(verifier).recordVerification(R, Decision.NEEDS_REVISION, H("v"));
      await expect(reg.connect(registrar).reanchorRecord(R, H("c2"), H("e2")))
        .to.emit(reg, "RecordAnchored").withArgs(R, P, H("c2"), H("e2"), 2);
      await reg.connect(verifier).recordVerification(R, Decision.VERIFIED, H("v2"));
      expect((await reg.getRecord(R)).status).to.equal(Status.VERIFIED);
      expect((await reg.getRecord(R)).revision).to.equal(2);
    });
  });

  describe("credit issuance", () => {
    it("cannot issue before verification", async () => {
      await anchored();
      await expect(reg.issueCredits(R, 10, H("est"), holder.address)).to.be.revertedWith("Record not verified");
    });
    it("only NCCR admin can issue (verifier and registrar cannot)", async () => {
      await verified();
      await expect(reg.connect(verifier).issueCredits(R, 10, H("est"), holder.address)).to.be.revertedWith("Only NCCR admin");
      await expect(reg.connect(registrar).issueCredits(R, 10, H("est"), holder.address)).to.be.revertedWith("Only NCCR admin");
    });
    it("issues to the holder and updates supply", async () => {
      await verified();
      await expect(reg.issueCredits(R, 120, H("est"), holder.address))
        .to.emit(reg, "CreditsIssued").withArgs(R, P, holder.address, 120, H("est"));
      expect(await reg.balanceOf(holder.address)).to.equal(120);
      expect(await reg.batchBalanceOf(R, holder.address)).to.equal(120);
      expect(await reg.totalIssued()).to.equal(120);
      expect((await reg.getProject(P)).totalIssued).to.equal(120);
      expect((await reg.getRecord(R)).status).to.equal(Status.CREDITED);
    });
    it("prevents duplicate issuance for the same record", async () => {
      await issued(50);
      await expect(reg.issueCredits(R, 50, H("est"), holder.address)).to.be.revertedWith("Credits already issued for record");
      expect(await reg.totalIssued()).to.equal(50);
    });
    it("separation of duties: verifier-admin cannot issue own verification", async () => {
      await anchored();
      await reg.setVerifier(admin.address, true);
      await reg.recordVerification(R, Decision.VERIFIED, H("v"));
      await expect(reg.issueCredits(R, 10, H("est"), holder.address)).to.be.revertedWith("Verifier cannot issue own verification");
    });
    it("validates quantity, holder and estimate hash", async () => {
      await verified();
      await expect(reg.issueCredits(R, 0, H("est"), holder.address)).to.be.revertedWith("Quantity must be > 0");
      await expect(reg.issueCredits(R, 5, H("est"), ethers.ZeroAddress)).to.be.revertedWith("Zero address");
      await expect(reg.issueCredits(R, 5, ethers.ZeroHash, holder.address)).to.be.revertedWith("Estimate hash required");
    });
    it("cannot issue after the project is deactivated", async () => {
      await verified();
      await reg.setProjectActive(P, false);
      await expect(reg.issueCredits(R, 5, H("est"), holder.address)).to.be.revertedWith("Project not active");
    });
  });

  describe("transfer and retirement", () => {
    it("transfers per batch and guards balances", async () => {
      await issued(100);
      await expect(reg.connect(holder).transfer(R, buyer.address, 40, REF("t1")))
        .to.emit(reg, "CreditsTransferred").withArgs(R, holder.address, buyer.address, 40, REF("t1"));
      expect(await reg.batchBalanceOf(R, holder.address)).to.equal(60);
      expect(await reg.batchBalanceOf(R, buyer.address)).to.equal(40);
      await expect(reg.connect(holder).transfer(R, buyer.address, 61, REF("t2"))).to.be.revertedWith("Insufficient batch balance");
      await expect(reg.connect(outsider).transfer(R, buyer.address, 1, REF("t3"))).to.be.revertedWith("Insufficient batch balance");
      await expect(reg.connect(holder).transfer(R, ethers.ZeroAddress, 1, REF("t4"))).to.be.revertedWith("Zero address");
    });
    it("retires credits permanently", async () => {
      await issued(100);
      await expect(reg.connect(holder).retire(R, 30, "test retirement", REF("r1")))
        .to.emit(reg, "CreditsRetired").withArgs(R, holder.address, 30, "test retirement", REF("r1"));
      expect(await reg.balanceOf(holder.address)).to.equal(70);
      expect(await reg.totalRetired()).to.equal(30);
      expect(await reg.batchRetired(R)).to.equal(30);
      expect(await reg.outstanding()).to.equal(70);
      await expect(reg.connect(holder).retire(R, 71, "x", REF("r2"))).to.be.revertedWith("Insufficient batch balance");
      await expect(reg.connect(holder).transfer(R, buyer.address, 71, REF("t5"))).to.be.revertedWith("Insufficient batch balance");
    });
  });

  describe("idempotent references and accounting invariants", () => {
    it("a transfer or retirement reference can be used only once, across both operations", async () => {
      await issued(100);
      await reg.connect(holder).transfer(R, buyer.address, 10, REF("dup"));
      expect(await reg.usedRef(REF("dup"))).to.equal(true);
      await expect(reg.connect(holder).transfer(R, buyer.address, 10, REF("dup"))).to.be.revertedWith("Reference already used");
      await expect(reg.connect(holder).retire(R, 10, "same ref", REF("dup"))).to.be.revertedWith("Reference already used");
      expect(await reg.balanceOf(holder.address)).to.equal(90, "the replayed call changed nothing");
      await expect(reg.connect(holder).transfer(R, buyer.address, 1, ethers.ZeroHash)).to.be.revertedWith("Reference required");
      await expect(reg.connect(holder).retire(R, 1, "x", ethers.ZeroHash)).to.be.revertedWith("Reference required");
    });
    it("a reverted call does not consume its reference", async () => {
      await issued(100);
      await expect(reg.connect(holder).transfer(R, buyer.address, 500, REF("retryable"))).to.be.revertedWith("Insufficient batch balance");
      expect(await reg.usedRef(REF("retryable"))).to.equal(false);
      await reg.connect(holder).transfer(R, buyer.address, 5, REF("retryable"));
    });
    it("events carry the reference so a recovering service can find the exact transaction", async () => {
      await issued(100);
      const tx = await reg.connect(holder).transfer(R, buyer.address, 7, REF("find-me"));
      const logs = await reg.queryFilter(reg.filters.CreditsTransferred(null, null, null, null, REF("find-me")));
      expect(logs.length).to.equal(1);
      expect(logs[0].transactionHash).to.equal(tx.hash);
      expect(logs[0].args.amount).to.equal(7);
      expect((await reg.queryFilter(reg.filters.CreditsTransferred(null, null, null, null, REF("absent")))).length).to.equal(0);
    });
    it("supply accounting holds across mixed operations: issued = outstanding + retired = sum of holder balances", async () => {
      await issued(100);
      await reg.connect(holder).transfer(R, buyer.address, 40, REF("a"));
      await reg.connect(buyer).transfer(R, outsider.address, 15, REF("b"));
      await reg.connect(outsider).retire(R, 5, "offset", REF("c"));
      await reg.connect(holder).retire(R, 20, "offset", REF("d"));
      const sum = (await reg.balanceOf(holder.address)) + (await reg.balanceOf(buyer.address)) + (await reg.balanceOf(outsider.address));
      expect(sum).to.equal(await reg.outstanding());
      expect(await reg.totalIssued()).to.equal((await reg.outstanding()) + (await reg.totalRetired()));
      expect(await reg.batchRetired(R)).to.equal(25);
    });
    it("only the NCCR administrator can issue; a second issuance for the same record is impossible under any role", async () => {
      await issued(10);
      await expect(reg.connect(registrar).issueCredits(R, 10, H("est2"), holder.address)).to.be.revertedWith("Only NCCR admin");
      await expect(reg.issueCredits(R, 10, H("est2"), holder.address)).to.be.revertedWith("Credits already issued for record");
    });
  });

  describe("contract-level credit freezing & dispute remedies", () => {
    it("admin can freeze and unfreeze an issued batch, emitting BatchFrozen", async () => {
      await issued(100);
      expect(await reg.isBatchFrozen(R)).to.equal(false);
      await expect(reg.setBatchFrozen(R, true, H("dispute-case-1")))
        .to.emit(reg, "BatchFrozen").withArgs(R, true, H("dispute-case-1"));
      expect(await reg.isBatchFrozen(R)).to.equal(true);

      await expect(reg.setBatchFrozen(R, false, H("dispute-case-1-resolved")))
        .to.emit(reg, "BatchFrozen").withArgs(R, false, H("dispute-case-1-resolved"));
      expect(await reg.isBatchFrozen(R)).to.equal(false);
    });

    it("direct blockchain transfer is reverted while the batch is frozen under dispute", async () => {
      await issued(100);
      await reg.setBatchFrozen(R, true, H("dispute-1"));
      await expect(reg.connect(holder).transfer(R, buyer.address, 10, REF("bypass-attempt")))
        .to.be.revertedWith("Batch is frozen under dispute");
      expect(await reg.batchBalanceOf(R, holder.address)).to.equal(100);
      expect(await reg.batchBalanceOf(R, buyer.address)).to.equal(0);
    });

    it("direct blockchain retirement is reverted while the batch is frozen under dispute", async () => {
      await issued(100);
      await reg.setBatchFrozen(R, true, H("dispute-2"));
      await expect(reg.connect(holder).retire(R, 10, "offset attempt", REF("retire-bypass-attempt")))
        .to.be.revertedWith("Batch is frozen under dispute");
      await expect(reg.connect(holder).retireHashed(R, 10, H("reason"), REF("retire-hashed-bypass")))
        .to.be.revertedWith("Batch is frozen under dispute");
      expect(await reg.batchRetired(R)).to.equal(0);
      expect(await reg.outstanding()).to.equal(100);
    });

    it("unfreezing allows direct transfers and retirements to resume safely", async () => {
      await issued(100);
      await reg.setBatchFrozen(R, true, H("dispute-3"));
      await reg.setBatchFrozen(R, false, H("dispute-3-dismissed"));
      await expect(reg.connect(holder).transfer(R, buyer.address, 25, REF("transfer-resumed")))
        .to.emit(reg, "CreditsTransferred");
      expect(await reg.batchBalanceOf(R, buyer.address)).to.equal(25);
    });

    it("freezing applies separation of duties: verifier cannot freeze own verified record", async () => {
      await anchored();
      await reg.connect(verifier).recordVerification(R, Decision.VERIFIED, H("v"));
      await reg.issueCredits(R, 50, H("est"), holder.address);
      await reg.proposeAdmin(verifier.address);
      await reg.connect(verifier).acceptAdmin();
      await expect(reg.connect(verifier).setBatchFrozen(R, true, H("disp")))
        .to.be.revertedWith("Verifier cannot freeze own verification");
    });

    it("cancelCredits burns holder units, increments totalCancelled and preserves the supply invariant", async () => {
      await issued(100);
      await reg.cancelCredits(R, holder.address, 30, H("upheld-decision"), REF("cancel-1"));
      expect(await reg.batchBalanceOf(R, holder.address)).to.equal(70);
      expect(await reg.batchCancelled(R)).to.equal(30);
      expect(await reg.totalCancelled()).to.equal(30);
      expect(await reg.outstanding()).to.equal(70);
      expect(await reg.totalIssued()).to.equal(100);
      expect(await reg.totalIssued()).to.equal((await reg.outstanding()) + (await reg.totalRetired()) + (await reg.totalCancelled()));
    });

    it("adversarial: rejects unauthorized cancellation attempt from non-admin", async () => {
      await issued(100);
      await expect(reg.connect(outsider).cancelCredits(R, holder.address, 10, H("case"), REF("unauth-cancel")))
        .to.be.revertedWith("Only NCCR admin");
      await expect(reg.connect(holder).cancelCredits(R, holder.address, 10, H("case"), REF("holder-cancel")))
        .to.be.revertedWith("Only NCCR admin");
    });

    it("adversarial: rejects cancellation with zero amount or invalid parameters", async () => {
      await issued(100);
      await expect(reg.cancelCredits(R, holder.address, 0, H("case"), REF("zero-cancel")))
        .to.be.revertedWith("Amount must be > 0");
      await expect(reg.cancelCredits(R, holder.address, 10, ethers.ZeroHash, REF("no-case")))
        .to.be.revertedWith("Case hash required");
      await expect(reg.cancelCredits(R, holder.address, 10, H("case"), ethers.ZeroHash))
        .to.be.revertedWith("Reference required");
      await expect(reg.cancelCredits(id("record:unissued"), holder.address, 10, H("case"), REF("bad-rec")))
        .to.be.revertedWith("Record has no issued credits");
    });

    it("adversarial: rejects cancellation exceeding available holder balance", async () => {
      await issued(100);
      await expect(reg.cancelCredits(R, holder.address, 101, H("case"), REF("excess-cancel")))
        .to.be.revertedWith("Insufficient batch balance");
    });

    it("adversarial: rejects cancellation replay with previously consumed reference", async () => {
      await issued(100);
      await reg.cancelCredits(R, holder.address, 10, H("case"), REF("dup-ref"));
      await expect(reg.cancelCredits(R, holder.address, 10, H("case"), REF("dup-ref")))
        .to.be.revertedWith("Reference already used");
    });

    it("adversarial: verifier cannot cancel credits for own verified record even after becoming admin", async () => {
      await anchored();
      await reg.connect(verifier).recordVerification(R, Decision.VERIFIED, H("v"));
      await reg.issueCredits(R, 50, H("est"), holder.address);
      await reg.proposeAdmin(verifier.address);
      await reg.connect(verifier).acceptAdmin();
      await expect(reg.connect(verifier).cancelCredits(R, holder.address, 10, H("c"), REF("ver-cancel")))
        .to.be.revertedWith("Verifier cannot cancel own verification");
    });

    it("lifecycle: partial cancellation followed by valid transfer of remaining units", async () => {
      await issued(100);
      await reg.cancelCredits(R, holder.address, 40, H("dispute-partial"), REF("c-part"));
      expect(await reg.batchBalanceOf(R, holder.address)).to.equal(60);
      await reg.connect(holder).transfer(R, buyer.address, 60, REF("t-remain"));
      expect(await reg.batchBalanceOf(R, holder.address)).to.equal(0);
      expect(await reg.batchBalanceOf(R, buyer.address)).to.equal(60);
      expect(await reg.totalIssued()).to.equal((await reg.outstanding()) + (await reg.totalRetired()) + (await reg.totalCancelled()));
    });

    it("lifecycle: cancellation of units held by a secondary buyer after transfer", async () => {
      await issued(100);
      await reg.connect(holder).transfer(R, buyer.address, 50, REF("t-buyer"));
      expect(await reg.batchBalanceOf(R, buyer.address)).to.equal(50);
      await reg.cancelCredits(R, buyer.address, 20, H("case-buyer"), REF("c-buyer"));
      expect(await reg.batchBalanceOf(R, buyer.address)).to.equal(30);
      expect(await reg.batchCancelled(R)).to.equal(20);
      expect(await reg.outstanding()).to.equal(80);
      expect(await reg.totalIssued()).to.equal((await reg.outstanding()) + (await reg.totalRetired()) + (await reg.totalCancelled()));
    });
  });
});
