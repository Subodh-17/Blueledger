// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * Blue Carbon Registry
 *
 * On-chain half of a hybrid MRV architecture. Detailed monitoring data and evidence files stay
 * off-chain; only identifiers and content hashes are anchored here.
 *
 *   registerProject -> anchorRecord -> recordVerification -> issueCredits -> transfer / retire
 *
 * Credits issued by this contract are registry credits. They are NOT accredited under any external
 * carbon standard and carry no regulatory standing. Whole-tonne quantities only
 * (1 unit = 1 tCO2e of an approved assessment, rounded down by the caller).
 *
 * Roles
 *   admin      - NCCR administrator. Manages roles, approves and issues credits.
 *   verifier   - records verification decisions on anchored records. Cannot issue credits.
 *   registrar  - service account that registers projects and anchors record hashes.
 *
 * Safeguards: only a verifier can verify; only the admin can issue; credits can only be issued
 * for a VERIFIED record; a record can be credited exactly once; the account that verified a
 * record cannot also issue its credits (separation of duties).
 */
contract BlueCarbonRegistry {
    // ───────── types ─────────
    enum RecordStatus { NONE, ANCHORED, VERIFIED, REJECTED, NEEDS_REVISION, CREDITED }
    enum Decision { VERIFIED, REJECTED, NEEDS_REVISION }

    struct ProjectInfo {
        bool    exists;
        bool    active;
        bytes32 metadataHash;
        address registeredBy;
        uint64  registeredAt;
        uint256 totalIssued;
    }

    struct RecordInfo {
        bytes32      projectId;
        bytes32      contentHash;       // hash of the off-chain monitoring record
        bytes32      evidenceRoot;      // hash over the evidence content hashes
        RecordStatus status;
        uint32       revision;
        uint64       anchoredAt;
        address      verifier;
        uint64       verifiedAt;
        bytes32      verificationHash;  // hash of the off-chain verification report
        bytes32      estimateHash;      // hash of the off-chain carbon calculation
        uint256      creditQuantity;
        address      creditHolder;
        uint64       issuedAt;
    }

    // ───────── state ─────────
    string  public constant name     = "Blue Carbon Registry Credit";
    string  public constant symbol   = "BCRC";
    uint8   public constant decimals = 0;

    address public admin;
    mapping(address => bool) public isVerifier;
    mapping(address => bool) public isRegistrar;

    mapping(bytes32 => ProjectInfo) private _projects;
    mapping(bytes32 => RecordInfo)  private _records;

    // credit ledger, tracked per issuance batch (= per verified record) for traceability
    mapping(bytes32 => mapping(address => uint256)) private _batchBalance;
    mapping(bytes32 => uint256) public batchRetired;
    mapping(bytes32 => uint256) public batchCancelled;
    mapping(address => uint256) public balanceOf;
    mapping(bytes32 => bool) public usedRef;   // transfer / retirement references already executed
    mapping(bytes32 => bool) public isBatchFrozen; // contract-level dispute freeze
    address public pendingAdmin;               // two-step administrator hand-over
    uint256 public totalIssued;
    uint256 public totalRetired;
    uint256 public totalCancelled;

    // ───────── events ─────────
    event ProjectRegistered(bytes32 indexed projectId, bytes32 metadataHash, address indexed by);
    event ProjectActiveChanged(bytes32 indexed projectId, bool active);
    event RecordAnchored(bytes32 indexed recordId, bytes32 indexed projectId, bytes32 contentHash, bytes32 evidenceRoot, uint32 revision);
    event RecordVerified(bytes32 indexed recordId, Decision decision, address indexed verifier, bytes32 verificationHash);
    event CreditsIssued(bytes32 indexed recordId, bytes32 indexed projectId, address indexed holder, uint256 quantity, bytes32 estimateHash);
    // `ref` is a caller-supplied unique reference (derived from the registry's idempotency key). It is recorded on-chain and indexed so a
    // recovering service can prove from the event log whether a given transfer or retirement already happened. Each ref can be used once.
    event CreditsTransferred(bytes32 indexed recordId, address indexed from, address to, uint256 amount, bytes32 indexed ref);
    event CreditsRetired(bytes32 indexed recordId, address indexed holder, uint256 amount, string reason, bytes32 indexed ref);
    event CreditsRetiredHashed(bytes32 indexed recordId, address indexed holder, uint256 amount, bytes32 reasonHash, bytes32 indexed ref);
    event BatchFrozen(bytes32 indexed recordId, bool frozen, bytes32 caseHash);
    event CreditsCancelled(bytes32 indexed recordId, address indexed holder, uint256 amount, bytes32 caseHash, bytes32 indexed ref);
    event RoleChanged(string role, address indexed account, bool granted);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event AdminProposed(address indexed currentAdmin, address indexed proposedAdmin);

    // ───────── modifiers ─────────
    modifier onlyAdmin()     { require(msg.sender == admin, "Only NCCR admin"); _; }
    modifier onlyVerifier()  { require(isVerifier[msg.sender], "Only verifier"); _; }
    modifier onlyRegistrar() { require(isRegistrar[msg.sender] || msg.sender == admin, "Only registrar"); _; }

    constructor() {
        admin = msg.sender;
        isRegistrar[msg.sender] = true;
        emit AdminTransferred(address(0), msg.sender);
    }

    // ───────── role management (NCCR admin) ─────────
    function setVerifier(address account, bool granted) external onlyAdmin {
        require(account != address(0), "Zero address");
        isVerifier[account] = granted;
        emit RoleChanged("verifier", account, granted);
    }

    function setRegistrar(address account, bool granted) external onlyAdmin {
        require(account != address(0), "Zero address");
        isRegistrar[account] = granted;
        emit RoleChanged("registrar", account, granted);
    }

    /// Two-step hand-over: the current administrator proposes, the proposed account accepts. Prevents transferring control to an unusable address.
    function proposeAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "Zero address");
        pendingAdmin = newAdmin;
        emit AdminProposed(admin, newAdmin);
    }

    function acceptAdmin() external {
        require(msg.sender == pendingAdmin, "Not the proposed administrator");
        emit AdminTransferred(admin, msg.sender);
        admin = msg.sender;
        pendingAdmin = address(0);
    }

    // ───────── projects ─────────
    function registerProject(bytes32 projectId, bytes32 metadataHash) external onlyRegistrar {
        require(projectId != bytes32(0), "Project id required");
        require(!_projects[projectId].exists, "Project already registered");
        _projects[projectId] = ProjectInfo({
            exists: true, active: true, metadataHash: metadataHash,
            registeredBy: msg.sender, registeredAt: uint64(block.timestamp), totalIssued: 0
        });
        emit ProjectRegistered(projectId, metadataHash, msg.sender);
    }

    function setProjectActive(bytes32 projectId, bool active) external onlyAdmin {
        require(_projects[projectId].exists, "Project not found");
        _projects[projectId].active = active;
        emit ProjectActiveChanged(projectId, active);
    }

    // ───────── monitoring-record anchoring ─────────
    function anchorRecord(bytes32 projectId, bytes32 recordId, bytes32 contentHash, bytes32 evidenceRoot)
        external onlyRegistrar
    {
        ProjectInfo storage p = _projects[projectId];
        require(p.exists, "Project not found");
        require(p.active, "Project not active");
        require(recordId != bytes32(0) && contentHash != bytes32(0), "Record id and hash required");
        RecordInfo storage r = _records[recordId];
        require(r.status == RecordStatus.NONE, "Record already anchored");
        r.projectId    = projectId;
        r.contentHash  = contentHash;
        r.evidenceRoot = evidenceRoot;
        r.status       = RecordStatus.ANCHORED;
        r.revision     = 1;
        r.anchoredAt   = uint64(block.timestamp);
        emit RecordAnchored(recordId, projectId, contentHash, evidenceRoot, 1);
    }

    /// Re-anchor a record after the field team revised it (only from NEEDS_REVISION).
    function reanchorRecord(bytes32 recordId, bytes32 contentHash, bytes32 evidenceRoot) external onlyRegistrar {
        RecordInfo storage r = _records[recordId];
        require(r.status == RecordStatus.NEEDS_REVISION, "Record not awaiting revision");
        require(contentHash != bytes32(0), "Hash required");
        require(_projects[r.projectId].active, "Project not active");
        r.contentHash  = contentHash;
        r.evidenceRoot = evidenceRoot;
        r.status       = RecordStatus.ANCHORED;
        r.revision    += 1;
        r.anchoredAt   = uint64(block.timestamp);
        emit RecordAnchored(recordId, r.projectId, contentHash, evidenceRoot, r.revision);
    }

    // ───────── verification ─────────
    function recordVerification(bytes32 recordId, Decision decision, bytes32 verificationHash) external onlyVerifier {
        RecordInfo storage r = _records[recordId];
        require(r.status == RecordStatus.ANCHORED, "Record not awaiting verification");
        require(verificationHash != bytes32(0), "Verification hash required");
        if (decision == Decision.VERIFIED)            r.status = RecordStatus.VERIFIED;
        else if (decision == Decision.REJECTED)       r.status = RecordStatus.REJECTED;
        else                                          r.status = RecordStatus.NEEDS_REVISION;
        r.verifier         = msg.sender;
        r.verifiedAt       = uint64(block.timestamp);
        r.verificationHash = verificationHash;
        emit RecordVerified(recordId, decision, msg.sender, verificationHash);
    }

    // ───────── NCCR approval + credit issuance ─────────
    function issueCredits(bytes32 recordId, uint256 quantity, bytes32 estimateHash, address holder) external onlyAdmin {
        RecordInfo storage r = _records[recordId];
        require(r.status != RecordStatus.CREDITED, "Credits already issued for record");
        require(r.status == RecordStatus.VERIFIED, "Record not verified");
        require(msg.sender != r.verifier, "Verifier cannot issue own verification");
        require(_projects[r.projectId].active, "Project not active");
        require(quantity > 0, "Quantity must be > 0");
        require(holder != address(0), "Zero address");
        require(estimateHash != bytes32(0), "Estimate hash required");

        r.status         = RecordStatus.CREDITED;
        r.estimateHash   = estimateHash;
        r.creditQuantity = quantity;
        r.creditHolder   = holder;
        r.issuedAt       = uint64(block.timestamp);

        _batchBalance[recordId][holder] += quantity;
        balanceOf[holder]               += quantity;
        totalIssued                     += quantity;
        _projects[r.projectId].totalIssued += quantity;
        emit CreditsIssued(recordId, r.projectId, holder, quantity, estimateHash);
    }

    // ───────── ownership: transfer and retirement ─────────
    function transfer(bytes32 recordId, address to, uint256 amount, bytes32 ref) external {
        require(!isBatchFrozen[recordId], "Batch is frozen under dispute");
        require(ref != bytes32(0), "Reference required");
        require(!usedRef[ref], "Reference already used");
        require(to != address(0), "Zero address");
        require(amount > 0, "Amount must be > 0");
        require(_batchBalance[recordId][msg.sender] >= amount, "Insufficient batch balance");
        _batchBalance[recordId][msg.sender] -= amount;
        _batchBalance[recordId][to]         += amount;
        balanceOf[msg.sender] -= amount;
        balanceOf[to]         += amount;
        usedRef[ref] = true;
        emit CreditsTransferred(recordId, msg.sender, to, amount, ref);
    }

    function retire(bytes32 recordId, uint256 amount, string calldata reason, bytes32 ref) external {
        require(!isBatchFrozen[recordId], "Batch is frozen under dispute");
        require(ref != bytes32(0), "Reference required");
        require(!usedRef[ref], "Reference already used");
        require(amount > 0, "Amount must be > 0");
        require(_batchBalance[recordId][msg.sender] >= amount, "Insufficient batch balance");
        _batchBalance[recordId][msg.sender] -= amount;
        balanceOf[msg.sender] -= amount;
        batchRetired[recordId] += amount;
        totalRetired           += amount;
        usedRef[ref] = true;
        emit CreditsRetired(recordId, msg.sender, amount, reason, ref);
    }

    /// Same accounting as retire(), but the reason is published only as a hash (the text stays in the off-chain registry).
    function retireHashed(bytes32 recordId, uint256 amount, bytes32 reasonHash, bytes32 ref) external {
        require(!isBatchFrozen[recordId], "Batch is frozen under dispute");
        require(ref != bytes32(0), "Reference required");
        require(!usedRef[ref], "Reference already used");
        require(amount > 0, "Amount must be > 0");
        require(_batchBalance[recordId][msg.sender] >= amount, "Insufficient batch balance");
        _batchBalance[recordId][msg.sender] -= amount;
        balanceOf[msg.sender] -= amount;
        batchRetired[recordId] += amount;
        totalRetired           += amount;
        usedRef[ref] = true;
        emit CreditsRetiredHashed(recordId, msg.sender, amount, reasonHash, ref);
    }

    // ───────── credit freezing & cancellation (governance / dispute remedies) ─────────
    /// Freezes or unfreezes a credit batch on-chain. While frozen, transfer and retirement are reverted.
    function setBatchFrozen(bytes32 recordId, bool frozen, bytes32 caseHash) external onlyAdmin {
        RecordInfo storage r = _records[recordId];
        require(r.status == RecordStatus.CREDITED, "Record has no issued credits");
        require(msg.sender != r.verifier, "Verifier cannot freeze own verification");
        require(caseHash != bytes32(0), "Case hash required");
        isBatchFrozen[recordId] = frozen;
        emit BatchFrozen(recordId, frozen, caseHash);
    }

    /// Cancels units held by a holder when a dispute is upheld or determination invalidated.
    function cancelCredits(bytes32 recordId, address holder, uint256 amount, bytes32 caseHash, bytes32 ref) external onlyAdmin {
        RecordInfo storage r = _records[recordId];
        require(r.status == RecordStatus.CREDITED, "Record has no issued credits");
        require(msg.sender != r.verifier, "Verifier cannot cancel own verification");
        require(caseHash != bytes32(0), "Case hash required");
        require(ref != bytes32(0), "Reference required");
        require(!usedRef[ref], "Reference already used");
        require(amount > 0, "Amount must be > 0");
        require(_batchBalance[recordId][holder] >= amount, "Insufficient batch balance");
        _batchBalance[recordId][holder] -= amount;
        balanceOf[holder]               -= amount;
        batchCancelled[recordId]        += amount;
        totalCancelled                  += amount;
        usedRef[ref] = true;
        emit CreditsCancelled(recordId, holder, amount, caseHash, ref);
    }

    // ───────── views ─────────
    function getProject(bytes32 projectId) external view returns (ProjectInfo memory) { return _projects[projectId]; }
    function getRecord(bytes32 recordId)  external view returns (RecordInfo memory)  { return _records[recordId]; }
    function batchBalanceOf(bytes32 recordId, address holder) external view returns (uint256) { return _batchBalance[recordId][holder]; }
    /// Credits issued and neither retired nor cancelled.
    function outstanding() external view returns (uint256) { return totalIssued - totalRetired - totalCancelled; }
}
