# Suggestions — what would actually win the hackathon

## Where Dock is right now

You have an RL booking policy, a bid-price engine, stowage constraints, counter-offers, a live simulator, an EVM settlement layer, and a procedural 3D ship. That's a real system. The previous suggestions document proposed disruption recovery orchestration, inter-carrier exchanges, parametric guarantees, strategic network design, sim-to-real calibration, and executable stowage. Those are all plausible consulting-deck bullets — but they're also exactly the kind of thing an industry white-paper would list. They don't make a judge *feel* anything, and several of them (network redesign, sim-to-real) are PhD-scale efforts being handwaved into a hackathon build.

Here's what I think would actually make judges lean forward.

---

## 1. Adversarial red-team mode: break your own system live on stage

**The gap:** Dock demos itself by running curated scenarios against itself and winning. Every hackathon project does this. No one ever lets the *audience* try to break the system.

**Build:** A "Red Team" mode where a judge (or second player) controls the world while Dock's policy tries to survive. Give them a budget of disruption tokens they can spend in real time during a running episode:

- **Close a port** (costs 3 tokens) — pick any of the 8 ports, pick duration.
- **Spike fuel** (2 tokens) — VLSFO jumps 60% for N days.
- **Demand shock** (2 tokens) — flood or starve a specific lane.
- **Kill a vessel** (4 tokens) — one ship goes to unscheduled drydock for N days.
- **Corrupt the forecast** (1 token) — inject systematic bias into the demand forecaster for a lane (the RL agent's observation becomes wrong).

The policy plays on. Dock shows: decisions it changed because of the disruption, profit it saved vs a static baseline running in the same adversarial world, and — critically — *where it broke*. A live leaderboard tracks "judge's score" (how much profit they destroyed) vs "Dock's resilience score" (how much it retained vs static). The judge is playing *against* your system.

**Why it wins:** This is interactive in a way demos never are. The judge isn't watching a replay — they're *attacking* your system and discovering its limits. When Dock survives, it's because they personally tried to kill it. When it breaks, you own that honestly. Either outcome is more memorable than a chart.

**Technical work:**
- Add a `POST /episodes/{id}/inject` endpoint that pushes live mid-episode disruption events into the running `Simulator`. The simulator already handles port closures and demand shocks via scenario config; you'd parameterize those to accept mid-run injections.
- The "forecast corruption" token is the novel one: temporarily mutate the `BoundDemandForecaster.daily()` output for a lane by a multiplicative bias. This tests whether the policy is robust to observation noise — something the current eval never probes.
- A small React panel in the Fleet screen with token buttons, a disruption timeline, and the live dual-profit counter.
- Runs two episodes in parallel (PPO + static) on the same injected event sequence. You already support one episode at a time — either lift that limit for a paired run, or run the static baseline as a shadow computation within the same thread.

**Proof:** Report the policy's *regret* — how far its profit fell below the best-possible response to the same disruption sequence (you can compute an upper bound by re-running with the disruption known in advance). This is a stronger claim than "PPO beats static."

---

## 2. Counterfactual explainer: "what if we had said yes?"

**The gap:** Dock explains *why* it priced or rejected a booking (the `explain` block, bid-price decomposition, reason codes). But it never answers the question a shipper or ops manager actually asks: *"What would have happened if you'd taken that booking you rejected?"* or *"Was that counter-offer actually worth it?"*

**Build:** For every rejected or counter-declined booking in a completed episode, simulate an alternate timeline where that single decision was flipped: the booking was accepted at market rate (or the counter was accepted). Run the remainder of the episode forward from that branch point. Report the difference in terminal profit, utilization, and downstream rejections.

This produces a per-decision *counterfactual impact* value: "Rejecting booking #247 (CNSHA→NLRTM, 22 TEU reefer, day 34) saved $18,400 in expected profit because it preserved capacity for 3 higher-value bookings on days 36–38." Or: "Rejecting booking #247 cost $4,100 — the capacity went unsold."

**Why it wins:** This is the single most powerful explainability feature you could build. It turns the RL policy from a black box that says "trust me" into a system that can *prove* each decision was right — or honestly admit when it was wrong. Judges who are skeptical of RL will find this irresistible.

**Technical work:**
- After an episode finishes, iterate over rejected/counter-declined events. For each one, fork the `Simulator` state at that day (you'll need to checkpoint `Simulator` state at each day boundary — serialize `fleet`, `stowage`, `metrics`, `empties`, `demand` RNG state).
- Re-run `sim.apply_decision(req, BookingDecision(kind=accept))` and then continue the episode to completion using the same policy for all subsequent decisions, same demand stream.
- The expensive part is re-running ~50 forked episodes per main episode. But each fork only runs the *remainder* from the branch point, and the simulator runs >1000× real-time. For a 90-day episode with ~30 interesting rejections, forking from the median branch point (day 45) means ~30 × 45-day runs — feasible in <30 seconds total.
- Surface this as a "What-If" rail on the Customers screen: click any rejected card → a drawer shows the counterfactual outcome, with a before/after profit delta and a mini-timeline of what changed downstream.

**Proof:** Aggregate the counterfactual impacts across an episode. If the policy is good, the sum of counterfactual impacts for rejections should be *positive* (rejecting those bookings was, on net, profitable). Report the fraction of rejections that were "correct" (positive impact) — this is a novel metric for RL policy quality that doesn't exist in the current eval.

---

## 3. Customer lifetime value: stop optimizing single voyages

**The gap:** Dock treats every booking request as independent. The RL observation is per-request: route, TEU, segment, departure day, stowage feasibility. There is no notion of a *returning customer*. But in real shipping, 70–80% of volume comes from long-term contracts and repeat shippers. Rejecting a flexible shipper once costs you a booking; rejecting them three times costs you a customer.

**Build:** Give the demand stream a notion of *shipper identity*. Each shipper has a patience counter — every rejection or unfavorable counter-offer decreases it. When patience hits zero, that shipper churns: they stop sending requests on that lane. The RL agent gets a new observation feature: `shipper_patience` (normalized 0–1) and `shipper_historical_volume` (how much this shipper has booked in the past). The agent must now learn that some low-margin bookings are worth accepting to keep a high-volume shipper, while a one-off urgent request from an unknown shipper can be squeezed harder.

Add a shipper leaderboard to the Customers screen: top 10 shippers by lifetime value, their churn risk, and the decisions that affected them. When a shipper churns, flash a notification: "Lost Shipper #42 (CNSHA→NLRTM, 340 TEU/year) — last 3 interactions were rejections."

**Why it wins:** This transforms Dock from a per-voyage optimizer into a *relationship-aware* revenue management system. Airlines figured this out in the 2000s with frequent-flyer tier pricing; shipping hasn't. It's a one-sentence pitch: "Dock knows when saying no costs you a customer, not just a booking."

**Technical work:**
- Modify `DemandStream` to maintain a pool of ~100–200 synthetic shippers with Pareto-distributed volumes (a few large shippers, many small ones). Each request is attributed to a shipper. Shipper patience decays on rejection/counter-decline, recovers slowly on acceptance.
- Add 2–3 shipper features to the RL observation vector (currently 112-dim, becomes ~115-dim). This requires retraining — but the curriculum is automated, and you have the GPU box.
- The reward function gets a churn penalty term: when a shipper churns, subtract their estimated annual contribution from the reward.
- New frontend component: a `ShipperPanel` on the Customers screen showing the shipper portfolio, churn events, and a scatter plot of shipper value vs. churn risk.

**Proof:** Compare PPO with and without shipper features on a 90-day horizon: the shipper-aware policy should accept slightly more low-margin bookings from high-value shippers but reject more from one-off requesters, yielding higher *long-run* profit (measured over the full horizon including lost future demand from churned shippers). Report churn rate and retained shipper value alongside the usual profit metrics.

---

## 4. Carbon budget market: make decarbonization a profit decision, not a compliance checkbox

**The gap:** Dock tracks CO₂/TEU as a reporting metric. The slow-steaming speed decisions reduce emissions. But carbon is treated as a *cost* (EU ETS at €80/tCO₂), never as a *tradable asset* or a *customer-facing product*. The current system can't answer: "Should I sell a 'green voyage' premium? How much is it worth? When should I burn my carbon budget vs. save it?"

**Build:** Give the fleet an explicit **carbon budget** for the episode (e.g., total allowable tonnes CO₂, mimicking the EU ETS cap or a corporate net-zero target). Each booking consumes carbon based on the vessel's fuel curve, speed, and route. The RL agent gets a new observation: `carbon_budget_remaining` (fraction). The policy must now balance profit against carbon — not as a fixed tax, but as a *scarce resource* with an evolving shadow price.

On the customer side, offer a **green premium**: shippers can pay extra for a "verified low-carbon voyage" (vessel runs at ≤14kt on their leg). This is a new counter-offer type alongside flex-window/alt-hub/split. The green premium is priced against the carbon budget's opportunity cost — if the budget is nearly exhausted, the premium is high; if there's slack, it's cheap.

**Why it wins:** Every shipping hackathon project mentions sustainability. None of them make it a *decision variable*. Dock would be the first to show carbon as a scarce resource that the RL agent actively manages — speeding up when carbon is cheap and the booking is valuable, slowing down to sell green premiums when carbon is tight. The demo moment: watch the carbon price evolve endogenously as the policy trades off profit against emissions.

**Technical work:**
- Add a `carbon_budget` field to `SimConfig` and track cumulative emissions in `Simulator`. Add `carbon_remaining` to the RL observation.
- New counter-offer type `green_voyage` with a premium calculated from the carbon shadow price (estimated from the marginal cost of the next unit of carbon, given remaining budget and expected future bookings).
- The RL action space grows by ~3 actions (green_voyage at 5%/10%/15% premium) → `Discrete(47)`. Retrain.
- Extend the `booking.decision` event with a `carbon_cost_kg` field. Add a carbon budget gauge to the Fleet screen and a "green voyage" badge to offer cards.

**Proof:** Show the Pareto frontier: profit vs. total CO₂. The carbon-aware policy should dominate the carbon-unaware one (same profit, less carbon; or more profit at the same carbon level). Report the emergent carbon shadow price over time — it should rise as the budget depletes, which is exactly how a well-designed cap-and-trade system works.

---

## 5. Collaborative human-AI booking desk: the judge *is* the operator

**The gap:** Dock's demo is fully autonomous — the RL policy makes every decision. But the real pitch is "decision *support*", not "decision replacement." Judges see an AI running on autopilot and think "cool tech demo." They see a human-AI team outperforming both the human and the AI alone and think "I'd buy this."

**Build:** A hybrid mode where the RL policy *recommends* but a human operator (the judge) makes the final call. For each incoming booking, the system shows:

- The RL agent's recommendation (accept/reject/counter, with confidence).
- The bid-price decomposition (already built).
- A quick expected-value estimate: "Accepting this booking is worth ~$2,400 in expected profit; rejecting preserves capacity worth ~$3,100 for expected future demand."
- A "risk gauge": how sensitive is this decision? (high-risk = the counterfactual profit gap is large; low-risk = it doesn't matter much either way).

The operator clicks accept/reject/counter. At the end, compare three scores: the operator alone (their decisions with no AI guidance), the AI alone (full autopilot on the same demand), and the human-AI team (what actually happened). The hypothesis: the team beats both.

**Why it wins:** This is the centaur chess argument applied to shipping. It reframes the product from "we replaced the human" to "we made the human better." It's also intensely interactive — the judge is making real decisions under time pressure, with the AI whispering advice. The reveal at the end ("You + AI scored $22.3M; AI alone scored $21.8M; you alone would have scored $19.1M") is a killer demo moment.

**Technical work:**
- Add a `human` policy mode where each booking request pauses the episode and waits for a `POST /episodes/{id}/decide` call from the frontend with the operator's chosen action.
- The frontend shows a decision card with the RL recommendation, confidence score, and expected-value breakdown. A countdown timer (10 seconds?) applies the AI recommendation if the human doesn't act — keeps the demo moving.
- Run three episodes: human-only (no AI info shown, just raw request data), AI-only (PPO autopilot), human-AI team. Same seed, same demand.
- The "human-only" baseline is tricky to get during a live demo — either pre-record it (let the judge play a quick round without AI guidance first) or simulate it by recording only the decisions where the judge *overrode* the AI and estimating what would have happened if they'd overridden everything.

**Proof:** The comparison table. Also report *where* human overrides helped (the AI missed something the human intuited) and where they hurt (the human was too conservative). This is a genuine research result about human-AI complementarity in revenue management.

---

## 6. Explain the RL policy through *attention*: what is the agent actually looking at?

**The gap:** The `explain` block in offers.json explains the *bid-price engine's* reasoning. But the RL agent has its own, separate logic — it's a neural network that takes 112 observations and produces an action. The bid price is one input; the agent might be ignoring it. You have no visibility into *what the RL agent learned*.

**Build:** Add a **policy attention map** to every decision. After the PPO agent selects an action, compute input-gradient saliency (or SHAP values, or simply the magnitude of the first-layer weights connecting each observation feature to the chosen action's logit). Group the 112 observation features into named blocks (market/request, voyage options, port state, vessel state, demand forecast, calendar) and report the relative importance of each block for this specific decision.

Render this as a small heatmap on each offer card: "For this decision, the agent weighted *vessel capacity* (42%), *demand forecast* (28%), *request segment* (18%), *port congestion* (12%)." When the agent relies heavily on the demand forecast, that's a signal that forecast quality matters. When it ignores the forecast and relies on capacity, it's in a regime where scarcity dominates.

**Why it wins:** RL in production is scary because it's a black box. This makes the box transparent — not by explaining the math, but by showing what information the agent *used* for each decision. A judge can look at a rejection and see "the agent rejected this because it expects 3× more demand on this lane next week" — that's an actionable insight, not a neural network weight.

**Technical work:**
- After `model.predict(obs)`, compute `torch.autograd.grad(action_logit, obs)` to get per-feature gradients. Normalize by L1 norm to get fractional attributions. This is ~1ms per decision — negligible.
- Group the 112 features using the block structure already documented (market/request = features 0–17, voyage options = 18–61, ports = 62–85, vessels = 86–101, forecast = 102–109, calendar = 110–111).
- Add an `attribution` field to the `booking.decision` event: `{"market": 0.18, "options": 0.12, "ports": 0.42, "vessels": 0.10, "forecast": 0.15, "calendar": 0.03}`.
- Render as a small horizontal stacked bar on each offer card, color-coded by block.

**Proof:** Sanity-check the attributions: in a port-closure scenario, `ports` attribution should spike for affected routes. In a demand-surge scenario, `forecast` attribution should dominate. If the attributions are random, the policy hasn't learned meaningful features — that's also useful information.

---

## The pitch I'd give

> "Every shipping AI shows you a chart that goes up. Dock lets you *attack* it and see what breaks. It explains not just what it decided, but what would have happened if it decided differently. And when you sit in the operator's chair, you and the AI together beat the AI alone."

**A tight demo sequence:**

1. **Set the stage** (30s): One booking arrives. Show the bid-price explanation *and* the RL attention map — the agent is looking at forecast demand and vessel capacity. Accept it. Show the counterfactual: "If you'd rejected this, you'd lose $2,400."
2. **Break it** (90s): Hand the judge the red-team panel. They close Rotterdam, spike fuel, kill a vessel. Watch the RL policy adapt in real time — rerouting, repricing, slowing down. Show the dual profit counter: PPO is down 12%, static is down 40%.
3. **Play together** (90s): Switch to collaborative mode. The judge makes 10 booking decisions with AI guidance. Show the risk gauge — the first 3 decisions don't matter much, but decision #7 is critical (high counterfactual gap). The judge follows the AI's advice on that one.
4. **The reveal** (30s): Three-way score card. Human+AI: $22.3M. AI alone: $21.8M. Static: $17.0M. The judge made one override that saved $400K the AI would have lost.
5. **The carbon twist** (30s): Same scenario, but with a carbon budget. The policy voluntarily slowed vessels and sold green premiums when carbon got tight. Same profit, 18% less CO₂. The Pareto chart.

**What not to build:** More dashboards. More analytics views. More "insights." The suggestions.md you showed me was full of dashboards and "operational intelligence." Judges don't remember dashboards. They remember the moment they tried to break your system and it survived, or the moment they realized the AI made them better at a job they'd never done before.

---

## Prioritization

| If you have… | Build this |
|---|---|
| 6 hours | **#2 Counterfactual explainer** — it's the most novel, requires no retraining, and plugs into the existing offer cards. Fork the sim at each rejection, run the remainder, report the delta. |
| 12 hours | Add **#6 Attention maps** — another no-retrain addition that makes every offer card richer and more transparent. Together with #2, you have the best *explainability* story at the hackathon. |
| 24 hours | Add **#1 Red-team mode** — this is the demo *moment*. The technical work is moderate (mid-episode injection + paired runs), but the audience impact is enormous. |
| 48 hours | Add **#5 Collaborative desk** — requires the human-in-the-loop episode mode and the decision UI, but the payoff is the centaur comparison that reframes the whole pitch. |
| All in | Add **#3 Shipper CLV** and **#4 Carbon budget** — these require retraining the RL agent, which is the bottleneck, but they fundamentally deepen the decision space from "per-booking optimizer" to "relationship-aware, carbon-constrained fleet intelligence." |
