// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title DockSettlement — conditional booking settlement for Dock deals.
/// One contract instance per episode; the Dock backend acts as the oracle
/// that writes departure/delivery confirmations. settle() is a pure
/// function of the recorded event timings — deterministic, replayable.
contract DockSettlement {
    enum Status {
        Registered,   // deal terms locked at booking
        Departed,     // cargo aboard, vessel sailed
        Delivered,    // cargo discharged at destination
        SettledFull,  // settled at agreed price
        SettledPenalty, // carrier breached window -> reduced payout
        Refunded      // never delivered by deadline -> full refund
    }

    struct Deal {
        bytes32 requestHash;       // opaque request/deal reference
        uint64  registerDay;       // sim day the deal was registered
        uint64  windowLo;          // earliest acceptable departure day
        uint64  windowHi;          // latest acceptable departure day
        uint64  deliveryDeadline;  // refund if not delivered by this day
        uint256 priceCents;        // final (post-discount) price per TEU
        uint32  teu;
        uint16  penaltyBps;        // carrier-late penalty, basis points
        Status  status;
        uint64  actualDeparture;
        uint64  actualDelivery;
        uint256 settledAmountCents;
    }

    mapping(bytes32 => Deal) public deals;
    bytes32[] public dealIds;
    address public oracle;

    event DealRegistered(bytes32 indexed dealId, bytes32 requestHash,
                         uint64 windowLo, uint64 windowHi,
                         uint64 deliveryDeadline, uint256 priceCents,
                         uint32 teu, uint16 penaltyBps);
    event DepartureConfirmed(bytes32 indexed dealId, uint64 actualDay);
    event DeliveryConfirmed(bytes32 indexed dealId, uint64 actualDay);
    event Settled(bytes32 indexed dealId, uint8 outcome,
                  uint256 amountCents);

    constructor() { oracle = msg.sender; }

    modifier onlyOracle() {
        require(msg.sender == oracle, "DockSettlement: not oracle");
        _;
    }

    function registerDeal(
        bytes32 dealId,
        bytes32 requestHash,
        uint64  registerDay,
        uint64  windowLo,
        uint64  windowHi,
        uint64  deliveryDeadline,
        uint256 priceCents,
        uint32  teu,
        uint16  penaltyBps
    ) external onlyOracle {
        require(deals[dealId].registerDay == 0 && registerDay > 0,
                "DockSettlement: deal exists or bad day");
        require(windowHi >= windowLo, "DockSettlement: bad window");
        deals[dealId] = Deal({
            requestHash: requestHash,
            registerDay: registerDay,
            windowLo: windowLo,
            windowHi: windowHi,
            deliveryDeadline: deliveryDeadline,
            priceCents: priceCents,
            teu: teu,
            penaltyBps: penaltyBps,
            status: Status.Registered,
            actualDeparture: 0,
            actualDelivery: 0,
            settledAmountCents: 0
        });
        dealIds.push(dealId);
        emit DealRegistered(dealId, requestHash, windowLo, windowHi,
                            deliveryDeadline, priceCents, teu, penaltyBps);
    }

    function confirmDeparture(bytes32 dealId, uint64 actualDay)
        external onlyOracle
    {
        Deal storage d = deals[dealId];
        require(d.status == Status.Registered,
                "DockSettlement: not registered");
        d.status = Status.Departed;
        d.actualDeparture = actualDay;
        emit DepartureConfirmed(dealId, actualDay);
    }

    function confirmDelivery(bytes32 dealId, uint64 actualDay)
        external onlyOracle
    {
        Deal storage d = deals[dealId];
        require(d.status == Status.Departed, "DockSettlement: not departed");
        d.status = Status.Delivered;
        d.actualDelivery = actualDay;
        emit DeliveryConfirmed(dealId, actualDay);
    }

    /// @dev outcome: 0 settled-full, 1 settled-penalty, 2 refunded.
    function settle(bytes32 dealId, uint64 currentDay)
        external onlyOracle returns (uint8 outcome, uint256 amountCents)
    {
        Deal storage d = deals[dealId];
        require(d.status == Status.Delivered ||
                (d.status <= Status.Departed &&
                 currentDay > d.deliveryDeadline),
                "DockSettlement: not settleable");

        if (d.status == Status.Delivered) {
            if (d.actualDeparture <= d.windowHi) {
                outcome = 0;
                amountCents = d.priceCents * d.teu;
                d.status = Status.SettledFull;
            } else {
                outcome = 1;
                amountCents =
                    d.priceCents * d.teu * (10_000 - d.penaltyBps) / 10_000;
                d.status = Status.SettledPenalty;
            }
        } else {
            outcome = 2;                       // refund — never delivered
            amountCents = 0;
            d.status = Status.Refunded;
        }
        d.settledAmountCents = amountCents;
        emit Settled(dealId, outcome, amountCents);
    }

    function dealCount() external view returns (uint256) {
        return dealIds.length;
    }
}
