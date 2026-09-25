# How Dock could become a hackathon winner

## The honest starting point

Dock is **not** merely a binary booking classifier. The documented build already has demand forecasting, network bid prices, physical stowage checks, flexible/alternate-hub/split offers, a 44-action PPO policy that also controls speed and empty repositioning, a simulation, live events, a shock replay, an audit ledger, and local-EVM conditional settlement. The `/customers` and `/fleet` screens are different lenses on those decisions. Another screen, another chart, generic AI chat, or a prettier ship will not change the substance of the pitch.

The stronger story is: **Dock is an operating system for profitable promises in ocean freight.** It decides what to promise, finds a feasible way to fulfill that promise when reality changes, and prices or compensates the consequences. The current booking policy becomes one engine inside a larger closed loop, rather than the whole product.

**My recommendation:** build **#1 as the hero**, connect it to **#2** for a genuinely new business model, and use **#5** as the credibility layer. If the hackathon is very short, ship one deep, interactive workflow from #1 instead of six shallow tabs.

| Rank | New capability | Decision Dock does **not** make today | Judge-visible moment |
|---|---|---|---|
| **1** | Disruption rescue orchestrator | Reassign *already committed* cargo across ships, partner slots, ports, and inland legs after a disruption | Close a port; watch committed shipments get rerouted or compensated |
| **2** | Inter-carrier capacity exchange | Buy/sell or swap capacity and empties with another carrier, not just optimize our own four ships | Two competing fleets trade slots to save both a customer and margin |
| **3** | Promise underwriting | Sell a delivery guarantee with a risk-priced fee, reserve, and automatic payout | A delayed container triggers a real contractual consequence |
| **4** | Strategic fleet/network designer | Redesign sailing loops, vessel assignments, chartering, and weekly frequency over months | Show the best *new service network*, not just a better choice on the old one |
| **5** | Sim-to-real evidence loop | Learn from external observations, quantify uncertainty, and reject unsafe-to-trust recommendations | Change an observed port-delay feed; the model recalibrates and admits uncertainty |
| **6** | Executable stowage and terminal plan | Schedule crane moves/rehandles at each port, not just check whether a box fits | A proposed rescue route visibly fails or succeeds on crane time and ship stability |

## 1. The hero: disruption rescue orchestrator

**The problem:** Dock's current shock replay demonstrates repricing and policy divergence, but it does not operate a recovery plan for the bookings that were *already sold*. A carrier's most expensive moment is when a port closes and promised deliveries become infeasible. The real question is not “what would the booking policy have done?” It is “which actual customers do we save, how, and who pays?”

**Build:** Maintain a commitment graph: containers → booked vessel legs → transshipment calls → destination → delivery deadline → SLA/penalty. When a disruption arrives, generate candidate recovery itineraries across own vessels, partner slots, alternate discharge ports, rail/truck legs, and storage. Solve a time-expanded, capacity-constrained assignment with hard stowage/reefer/hazmat and cutoff constraints. Optimize **net retained profit** (revenue minus partner lift, fuel, handling, compensation, and missed-delivery costs), with explicit fairness/service floors. Keep a human approval gate before changing real commitments.

**What judges do:** They pick a port and closure duration, then click **Disrupt**. The screen turns from a map of ships into a list of endangered commitments. For one reefer booking, Dock offers: (A) wait and miss the SLA, (B) divert via Antwerp plus rail, (C) buy a partner slot. Each option shows arrival probability, incremental cost, carbon, physical feasibility, and the shipper's revised terms. Approve one; the itinerary changes, the customer receives a simulated amendment, and the contract/ledger records the consequence. A “do nothing” twin runs with the same disrupted world and initial bookings.

**Technical challenge:** This is a new **recovery optimization** problem, not a larger PPO action space or a replay skin. Use column generation or constrained min-cost flow for routing, a mixed-integer/CP solver for scarce resources, and Monte Carlo for uncertain port reopening and travel times. Reuse Dock's existing booking, stowage, event, and settlement primitives. A deliberately small but complete 8-port scenario is more convincing than a decorative global map.

**Proof:** Report promised TEU delivered on time, at-risk TEU rescued, incremental contribution margin, total compensation, and solver runtime against “wait” and greedy reroute on the same already-booked shipments. Show cases the solver declines because no safe route exists. Do not call the existing shock replay “recovery orchestration”; it does not yet do this.

## 2. Inter-carrier capacity and empty-equipment exchange

**The problem:** A carrier cannot solve every shortage within its own fleet. One line may have an empty slot where another has a stranded customer, while the second has empty boxes where the first needs them. Today's simulator mentions partner lift, but Dock does not negotiate a scarce partner slot or clear a multi-party market.

**Build:** Add a second carrier with its own schedule, capacities, reserve prices, and private costs. Expose sell/buy offers for slots, containers, and optionally reefer plugs. Match complementary imbalances via a double auction or combinatorial exchange, subject to feasible itineraries, contractual cutoffs, and no double-selling. Price a transaction so both parties do better than their no-trade counterfactual; reserve a human-approvable agreement and settle after execution. The existing on-chain demo can record a trade, but **the market-clearing algorithm and cross-carrier feasibility are the invention**, not the chain.

**What judges do:** Carrier A has a premium shipment it cannot carry. Carrier B has capacity on the right leg but lacks empty equipment at origin. Dock proposes a slot-for-equipment swap with a cash adjustment, and both profit projections improve. Toggle either carrier's reserve price to watch the trade vanish or change counterparties.

**Proof:** More fulfilled profitable demand, lower empty TEU-miles, individual rationality for *each* carrier, and no capacity conflicts versus no exchange and naive first-match trading. This is a path from one fleet's decision support to a network marketplace, not just a new booking offer.

## 3. Promise underwriting and parametric service guarantees

**The problem:** A reason-coded quote does not tell a shipper whether the carrier will stand behind the ETA. Dock's present settlement covers conditional booking terms on a local EVM; it is **not** an actuarially priced guarantee or an independent proof of physical delivery.

**Build:** Offer optional tiers such as standard, guaranteed-by-date, and carbon-budget delivery. Predict the distribution of arrival delay under congestion, weather, transshipment, and recovery options; quote a fee and reserve for each guarantee. If a verified milestone misses the contracted threshold, trigger a pre-agreed credit or payout. Price against expected claims plus capital at risk, not just against the mean ETA. Track exposure across correlated bookings on the same ship/port so one closure cannot bankrupt the guarantee pool.

**What judges do:** Buy a guaranteed reefer delivery. Trigger a port closure. The recovery optimizer tries to save it; if it fails, a transparent payout is calculated from the signed terms. The judge can see why a higher-risk route costs more and why some promises are refused.

**Proof:** Calibration of predicted delay probabilities, expected margin *after claims*, tail-loss/CVaR, fraction of guarantees honored, and comparison with flat-fee guarantees. In a demo, use simulator-generated or explicitly simulated attestations; a carrier-written oracle plus a local EVM is not independently verified real-world delivery. This extends the existing deal rail with a new risk decision rather than just adding another contract type.

## 4. Strategic fleet and service-network designer

**The problem:** The current four vessels run fixed loops. That is fine for per-booking revenue management, but an operator also decides **where ships should sail in the first place**. The docs themselves note that four disjoint loops cannot provide realistic weekly service on all routes. Repricing an insufficient network is not the same as designing a better one.

**Build:** Given OD demand distributions, berth windows, vessel specs, canal transits, fuel/carbon costs, and service-frequency commitments, choose loops, phased sailings, vessel assignments, and charter/buy-slot options. Run an outer optimization over candidate networks and an inner simulation of Dock's existing booking policy. Penalize brittle schedules and low-frequency service, not only operating cost. Present a Pareto frontier of profit, punctuality, and CO₂ rather than one magic route.

**What judges do:** Reassign vessels to a phased transpacific string, or add charters at a visible cost to achieve weekly frequency. Dock recomputes the schedule and then reruns booking performance on the *new* network. A seemingly expensive charter wins because it enables repeat premium bookings and fewer broken promises—or loses because it cannibalizes existing lift.

**Proof:** Out-of-sample profit, coverage/frequency, missed demand, fleet utilization, and carbon against the fixed-loop baseline. This is distinct from the already shipped speed and empty-reposition decisions. The plan lists buy/charter/sell as future vision; a working network-search loop would turn that slide into a second substantial optimization engine.

## 5. Sim-to-real evidence and uncertainty engine

**The problem:** The strongest current result is measured in Dock's own synthetic world. The docs are candid: demand data and willingness-to-pay are simulator-generated; the models can recover generator parameters, but that is not external validation. The PPO wins on aggregate holdout and the volatile-shock scenario, yet trails a heuristic in depressed demand. Judges may reasonably ask whether the learned strategy survives a different world.

**Build:** Ingest a small, licensed/public sample of actual vessel calls, port waits, schedules, weather, bunker prices, and market-rate indices with provenance. Recalibrate delay and demand ranges; reserve a **separate external or shifted-regime test** that is not used to train or tune the new components. Build ensembles of plausible worlds rather than one calibrated simulator. Use distribution-shift detection and uncertainty bounds to flag decisions requiring a human, then test the old and new policies across those worlds. If booking-level outcome labels are unavailable, say so: evaluate observable ETA/port behaviors separately and keep commercial uplift as a simulation-only claim.

**What judges do:** Switch from the synthetic baseline to an observed high-congestion week. Dock shows changed delay probabilities, a wider profit interval, a recovered recommendation—or “insufficient evidence; manual approval required.” The trust moment is the system refusing to overclaim.

**Proof:** Forecast calibration, interval coverage, stress-test regret, robustness across parameter ranges, and an explicit provenance card for every number. Do **not** report the existing +164% simulated profit lift as a real-world outcome. The original holdout is useful, but an independently sourced shift test is a much harder credibility win.

## 6. Executable stowage and terminal choreography

**The problem:** The existing deterministic stowage plan is a bays × height feasibility model. The separate vessel design document imagines a detailed ship and crane timeline, but that visual design is not evidence that Dock has optimized actual terminal operations. A cargo plan that fits in the hold may still fail a tight connection if it needs too many rehandles or crane hours.

**Build:** Turn a proposed itinerary into an executable load/discharge sequence at each port: bay/row/tier placement, hatch access, crane assignment, rehandle count, crane interference, reefer power handoff, and vessel stability envelopes. Use constraint programming to jointly minimize turnaround time and disruption cost while respecting safety rules. Feed true port-time and handling costs back into the rescue planner; never ask an LLM to decide legal placement.

**What judges do:** In the recovery demo, a tempting alternate vessel appears to have room. The executable planner rejects it because an early-discharge reefer is trapped below later-port cargo—or finds a safe restow with a measured crane-hour penalty. The vessel view animates *the computed move list*, not a scripted cinematic.

**Proof:** Zero hard-rule violations, feasible completion before berth cutoff, crane hours, rehandles, and avoided delay against a capacity-only planner. Make clear this is a new terminal-execution model, not a claim that the present stowage mask already provides bay/row/tier naval-architecture certification.

## The pitch I would actually give

> “Carriers don't merely sell slots. They sell promises that can break. Dock prices each promise against modeled ship constraints, then—when a port shuts—finds the least-cost physically possible way to keep it, buys capacity from other carriers when necessary, and automatically accounts for customers it cannot save.”

**A tight live sequence:**

1. **Establish the business:** Show one profitable booking and its existing stowage-aware bid price. Spend seconds, not minutes, on PPO architecture.
2. **Break the world:** Close Rotterdam while real committed cargo is en route. Freeze the initial state and seed so “before/after” uses identical obligations.
3. **Make a new decision:** Reveal three feasible recovery plans, one unsafe/infeasible plan, the solver's recommended choice, and the margin/SLA/carbon trade-off. Let a judge change the closure duration.
4. **Close the loop:** Approve a rescue. Show a partner capacity trade or a guaranteed-delivery payout, plus the event trail and changed customer terms.
5. **Prove it:** Compare delivered-on-time TEU and net retained profit against do-nothing and greedy recovery, with uncertainty and data provenance visible. Admit the synthetic-world boundary.

**What not to spend the last build cycle on:** another fleet map, a generic AI copilot, more LLM prose for existing reason codes, a blockchain-first pitch, unsupported industry-wide savings extrapolations, or six half-built features. The existing ledger and local-EVM demo are supporting evidence; they are not a substitute for a second genuinely difficult decision problem.

## Practical cut line

- **If you can build only one thing:** implement the recovery orchestrator for a fixed closure, a handful of committed shipments, two own vessels, one partner slot, and one inland alternative. Produce a real optimization result and an interactive counterfactual.
- **If you can build two:** add a second carrier with economically meaningful trade offers; the recovery planner can now buy a solution it could not create alone.
- **If you can go all in:** add guarantee underwriting, executable crane moves, network redesign, and independent data calibration. Keep the mathematical models separate, but connect them through one promise/commitment state and one auditable event trail.

A winning demo is not “our RL policy makes more money in its simulator.” It is **“we can make, rescue, trade, and honor a cargo delivery promise—and show exactly when we cannot.”**
