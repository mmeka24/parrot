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
