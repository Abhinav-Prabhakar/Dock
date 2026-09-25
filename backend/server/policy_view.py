"""Read-only introspection of the live MaskablePPO policy, for the operator's
decision-engine view: action probabilities, V(s), hidden activations and
gradient x input attributions for one decision, plus a fixed slice of the
real weights to draw the network.

The trained policy is 112 -> 256 -> 256 (tanh) -> pi(44), with a separate
value head (see runs/ppo_c*/model.zip). Drawing 256 units per layer is
unreadable, so the view shows K units per layer — the ones that carry the
most weight into the action head — and every number here is sliced from the
real network, never synthesised.
"""

from __future__ import annotations

import numpy as np

from env.fleet_env import (ALT_TIERS, FLEX_TIERS, N_ACTIONS, REPO_TIERS,
                           SPEED_TIERS, SPLIT_TIERS, obs_labels)

K = 28   # units shown per hidden layer

_LABELS = obs_labels()


def action_labels(repo_pairs: list[tuple[str, str]] | None = None) -> list[str]:
    """Name of each of the N_ACTIONS actions. Reposition pairs are chosen per
    fleet step (env._repo_pairs), so they're named when known."""
    out = ["Reject", "Accept at quote"]
    out += [f"Counter · flex window −{int(d * 100)}%" for d in FLEX_TIERS]
    out += [f"Counter · alt hub −{int(d * 100)}%" for d in ALT_TIERS]
    out += [f"Counter · split {int(f * 100)}/{100 - int(f * 100)}"
            for f in SPLIT_TIERS]
    for i in range(4):
        out += [f"VES{i + 1} → {int(kt)} kn" for kt in SPEED_TIERS]
    for i in range(8):
        pair = (repo_pairs[i] if repo_pairs and i < len(repo_pairs)
                else None)
        for teu in REPO_TIERS:
            out.append(f"Reposition {teu} TEU {pair[0]} → {pair[1]}"
                       if pair else f"Reposition #{i + 1} · {teu} TEU")
    assert len(out) == N_ACTIONS
    return out


def _layers(policy):
    net = policy.mlp_extractor.policy_net      # Linear, Tanh, Linear, Tanh
    return net[0], net[2], policy.action_net


def units(policy) -> tuple[list[int], list[int]]:
    """The K layer-2 units with the largest total weight into the action
    head, and the K layer-1 units feeding those most strongly. Cached on the
    policy object (fixed for a given checkpoint)."""
    cached = getattr(policy, "_dock_units", None)
    if cached is not None:
        return cached
    import torch
    l1, l2, head = _layers(policy)
    with torch.no_grad():
        u2 = head.weight.abs().sum(0).topk(K).indices
        u1 = l2.weight[u2].abs().sum(0).topk(K).indices
    policy._dock_units = (sorted(u1.tolist()), sorted(u2.tolist()))
    return policy._dock_units


def network(model) -> dict:
    """Static weight slice for drawing the network (same units as
    evaluate()'s activations)."""
    import torch
    policy = model.policy
    l1, l2, head = _layers(policy)
    u1, u2 = units(policy)
    with torch.no_grad():
        w1 = l1.weight[u1]                        # K x 112
        w2 = l2.weight[u2][:, u1]                 # K x K
        w3 = head.weight[:, u2]                   # 44 x K
    r = lambda t: np.round(t.numpy(), 3).tolist()  # noqa: E731
    return {"obs_labels": _LABELS, "action_labels": action_labels(),
            "units": {"h1": u1, "h2": u2},
            "layers": [l1.in_features, l1.out_features, l2.out_features,
                       head.out_features],
            "w1": r(w1), "w2": r(w2), "w3": r(w3)}


def evaluate(model, obs: np.ndarray, mask: np.ndarray, top_k: int = 8) -> dict:
    """One masked forward pass of the real policy (+ a backward pass for
    attributions). The chosen action is argmax of the masked distribution —
    exactly what model.predict(..., deterministic=True) returns."""
    import torch
    policy = model.policy
    l1, l2, head = _layers(policy)
    u1, u2 = units(policy)
    x = torch.as_tensor(np.asarray(obs, dtype=np.float32)).unsqueeze(0)
    x.requires_grad_(True)
    h1 = torch.tanh(l1(x))
    h2 = torch.tanh(l2(h1))
    logits = head(h2)[0]
    m = torch.as_tensor(np.asarray(mask, dtype=bool))
    probs = torch.softmax(logits.masked_fill(~m, float("-inf")), dim=0)
    action = int(torch.argmax(probs))
    logits[action].backward()
    grad_x = (x.grad[0] * x[0]).detach().numpy()        # gradient x input
    with torch.no_grad():
        value = float(policy.predict_values(x.detach())[0, 0])

    order = np.argsort(-np.abs(grad_x))[:top_k]
    peak = float(np.abs(grad_x[order[0]])) or 1.0
    attribution = [{"idx": int(i), "label": _LABELS[i],
                    "w": round(float(grad_x[i]) / peak, 3),
                    "x": round(float(obs[i]), 3)} for i in order
                   if grad_x[i] != 0.0]
    lg = logits.detach().numpy()
    p = probs.detach().numpy()
    return {
        "action": action,
        "probs": [round(float(v), 4) for v in p],
        "logits": [round(float(v), 3) if ok else None
                   for v, ok in zip(lg, np.asarray(mask, dtype=bool))],
        "mask": [bool(v) for v in mask],
        "value": round(value, 2),
        "entropy": round(float(-(p[p > 0] * np.log(p[p > 0])).sum()), 3),
        "h1": [round(float(v), 3) for v in h1[0, u1].detach().numpy()],
        "h2": [round(float(v), 3) for v in h2[0, u2].detach().numpy()],
        "obs": [round(float(v), 3) for v in obs],
        "attribution": attribution,
    }
