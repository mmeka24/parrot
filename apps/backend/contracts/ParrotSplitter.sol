// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/**
 * ParrotSplitter - the on-chain half of Parrot.
 *
 * 1. recordAuction: the operator (Parrot's backend) writes each auction's
 *    outcome on-chain - who won, at what share, and a keccak256 hash of every
 *    agent's full decision record, so anyone can check a published decision log
 *    was not edited afterwards.
 * 2. unlock: a viewer's payment is split by THIS CONTRACT, in one transaction,
 *    straight to the creator and the winning agent, at the share the auction
 *    set. Nobody holds the money in between, and the split cannot be changed
 *    after the auction (terms are write-once).
 * 3. recordQc: the independent quality check's verdict on the winning agent's
 *    dub, once per job. Each agent's passed / failed count is public and can
 *    never be edited - an on-chain reputation.
 */
contract ParrotSplitter {
    IERC20 public immutable usdc;
    address public immutable operator;

    struct Terms {
        address creator;
        address agent;
        uint16 agentBps;
    }

    mapping(bytes32 => Terms) public terms;
    mapping(bytes32 => bool) public unlockPaid;

    struct Reputation {
        uint32 passed;
        uint32 failed;
    }

    /// Every agent's QC track record, keyed by the wallet the auction recorded.
    mapping(address => Reputation) public reputation;
    mapping(bytes32 => bool) public qcRecorded;

    event AuctionRecorded(
        bytes32 indexed jobId,
        address indexed agent,
        address creator,
        uint16 agentBps,
        uint8 bidders,
        bytes32 decisionsHash
    );
    event UnlockSplit(
        bytes32 indexed jobId,
        bytes32 indexed unlockId,
        address indexed payer,
        uint256 creatorAmount,
        uint256 agentAmount
    );

    /// meaningScore is 0-100 from the back-translation check, 255 if not measured.
    event QcRecorded(
        bytes32 indexed jobId,
        address indexed agent,
        bool passed,
        uint8 meaningScore,
        bytes32 reportHash
    );

    constructor(IERC20 usdc_) {
        usdc = usdc_;
        operator = msg.sender;
    }

    function recordAuction(
        bytes32 jobId,
        address creator,
        address agent,
        uint16 agentBps,
        uint8 bidders,
        bytes32 decisionsHash
    ) external {
        require(msg.sender == operator, "not operator");
        require(terms[jobId].creator == address(0), "terms are final");
        require(creator != address(0) && agent != address(0), "zero address");
        require(agentBps <= 10_000, "bps");
        terms[jobId] = Terms(creator, agent, agentBps);
        emit AuctionRecorded(jobId, agent, creator, agentBps, bidders, decisionsHash);
    }

    function recordQc(bytes32 jobId, bool passed, uint8 meaningScore, bytes32 reportHash) external {
        require(msg.sender == operator, "not operator");
        Terms memory t = terms[jobId];
        require(t.creator != address(0), "no auction for job");
        require(!qcRecorded[jobId], "qc is final");
        require(meaningScore <= 100 || meaningScore == 255, "score");
        qcRecorded[jobId] = true;
        if (passed) reputation[t.agent].passed += 1;
        else reputation[t.agent].failed += 1;
        emit QcRecorded(jobId, t.agent, passed, meaningScore, reportHash);
    }

    function unlock(bytes32 jobId, bytes32 unlockId, uint256 amount) external {
        Terms memory t = terms[jobId];
        require(t.creator != address(0), "no auction for job");
        require(!unlockPaid[unlockId], "already paid");
        unlockPaid[unlockId] = true;

        uint256 agentAmount = (amount * t.agentBps) / 10_000;
        uint256 creatorAmount = amount - agentAmount;
        if (agentAmount > 0) require(usdc.transferFrom(msg.sender, t.agent, agentAmount), "agent leg");
        if (creatorAmount > 0) require(usdc.transferFrom(msg.sender, t.creator, creatorAmount), "creator leg");
        emit UnlockSplit(jobId, unlockId, msg.sender, creatorAmount, agentAmount);
    }
}
