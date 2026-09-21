"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import { useEpisode } from "@/components/dock/EpisodeProvider";
import type { EpisodeEvent } from "@/lib/api";
import { CARGO_ICON, COUNTER_KIND_LABEL, stampFor, fmtUsd } from "@/lib/offers";
import "./booking-desk.css";

const KEEPER_BODY = {
  "--c1": "#2e4a3a",
  "--c2": "#1e3028",
  "--skin": "#e0b090",
} as CSSProperties;
const KEEPER_FACE = { "--hair": "#d8d0c0" } as CSSProperties;

const OFFER_LINES: Record<string, string[]> = {
  urgent: ["It has to move. Now.", "Deadline's Friday.", "Whatever it costs."],
  standard: ["What's the rate?", "Care to make a deal?", "For you, a fair price."],
  flexible: ["I'm easy on timing.", "Any window works.", "Cheapest you can do?"],
};
const HAPPY_LINES = ["A pleasure!", "Deal!", "You won't regret it.", "Sold, then!"];
const SAD_LINES = ["Hm. Your loss.", "Perhaps next time.", "I see how it is…", "Oh well."];
const IDLE_LINES = ["Lovely shop…", "Hmm, interesting.", "Just browsing.", "What a place!", "Is that a cat?"];

export function BookingDesk({ onSelect }: { onSelect?: (ev: EpisodeEvent) => void }) {
  const { events, metrics, episode } = useEpisode();
  const liveRef = useRef<HTMLDivElement>(null);
  const slotsRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLDivElement>(null);
  const registerRef = useRef<HTMLDivElement>(null);

  const queueRef = useRef<EpisodeEvent[]>([]);
  const lastSeqRef = useRef(0);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // feed the scene queue from the live event stream
  useEffect(() => {
    for (const ev of events) {
      if (ev.type === "booking.decision" && ev.seq > lastSeqRef.current) {
        lastSeqRef.current = ev.seq;
        queueRef.current.push(ev);
      }
    }
    // bound the backlog — at flat-out speed we sample rather than freeze time
    if (queueRef.current.length > 60) {
      queueRef.current = queueRef.current.filter((_, i) => i % 2 === 0);
    }
  }, [events]);

  // reset when the episode changes
  useEffect(() => {
    queueRef.current = [];
    lastSeqRef.current = 0;
  }, [episode?.id]);

  useEffect(() => {
    const live = liveRef.current;
    const slots = slotsRef.current;
    const bellEl = bellRef.current;
    const registerEl = registerRef.current;
    if (!live || !slots || !bellEl || !registerEl) return;

    const COUNTER_H = 290;
    const MAX_CARDS = 8;
    const CARD_STEP = 284;

    /* ---------- dust motes ---------- */
    for (let i = 0; i < 12; i++) {
      const m = document.createElement("div");
      m.className = "mote";
      m.style.left = 10 + Math.random() * 80 + "%";
      m.style.top = 10 + Math.random() * 50 + "%";
      m.style.setProperty("--dx", Math.random() * 160 - 80 + "px");
      m.style.setProperty("--dy", 60 + Math.random() * 140 + "px");
      m.style.setProperty("--d", 10 + Math.random() * 14 + "s");
      m.style.animationDelay = -Math.random() * 14 + "s";
      live.appendChild(m);
    }

    /* ---------- customers ---------- */
    const rand = (a: number, b: number) => a + Math.random() * (b - a);
    const pick = <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];

    const PALETTES = [
      ["#7a4a6a","#4a2a44","#e8b890","#3a2418"], // plum coat
      ["#3a5a7a","#24344a","#d4a878","#1c140c"], // navy
      ["#6a7a3a","#3f4a24","#c89878","#5a3a1c"], // olive
      ["#8a3a3a","#4a2020","#e0b090","#2a1a12"], // rust
      ["#4a7a6a","#2a4a40","#d8a880","#101010"], // teal
      ["#7a6a3a","#4a3f22","#caa07a","#3a2a14"], // mustard
    ];
    const HATS: [string, string][] = [
      ["#6a3a2a","#3a1e14"],
      ["#2a3a4a","#16202c"],
      ["#4a4a26","#2a2a14"],
      ["#5a2a3a","#30141e"],
    ];

    const width = () => live.clientWidth;
    const height = () => live.clientHeight;

    function wanderTarget() {
      return {
        x: rand(60, width() - 60),
        y: rand(80, height() - COUNTER_H - 50),
      };
    }

    /* ---------- offer card ---------- */
    function dealCard(ev: EpisodeEvent) {
      const seg = String(ev.segment ?? "standard");
      const cargo = String(ev.cargo_type ?? "dry");
      const price = Number(ev.price ?? ev.quoted ?? 0);
      const market = Number(ev.market_rate ?? 0);
      const delta = market > 0 ? ((price - market) / market) * 100 : 0;
      const flex = Number(ev.flex_days ?? 0);
      const kind = String(ev.kind ?? "");
      const counter = COUNTER_KIND_LABEL[kind];

      const card = document.createElement("div");
      card.className = "offer-card";
      card.innerHTML = `
        <span class="corner tl">◆</span><span class="corner br">◆</span>
        ${counter ? `<div class="kind-tag">${counter}</div>` : ""}
        <div><span class="route">${ev.origin} → ${ev.dest}</span></div>
        <div class="teu-line">${ev.teu} TEU · REQ #${ev.request_id}</div>
        <div class="spec-line"><span class="seg seg-${seg}">${seg}</span><span class="sep">·</span><span class="cargo">${CARGO_ICON[cargo] ?? "▣"} ${cargo}</span></div>
        <div class="divider"></div>
        <div class="price"><small>quoted</small>${fmtUsd(price)}<span class="per">/TEU</span></div>
        <div class="market">mkt ${fmtUsd(market)} ·
          <span class="delta ${delta >= 0 ? "above" : "below"}">${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%</span></div>
        <div class="meta">dep d${Math.round(Number(ev.req_dep_day ?? 0))}${flex ? ` ±${flex}d` : ""} · ${ev.n_options ?? 0} voyages · ${Math.round(Number(ev.weight_t ?? 0))}t</div>`;
      card.addEventListener("click", () => onSelectRef.current?.(ev));
      slots!.appendChild(card);
      while (slots!.children.length > 14) slots!.firstElementChild?.remove();
      slots!.scrollTo({ left: slots!.scrollWidth, behavior: "smooth" });

      const stamp = stampFor(ev);
      const won = stamp.cls === "booked" || stamp.cls === "counter";
      const stampDelay = won ? 650 : 850;
      setTimeout(() => {
        const s = document.createElement("span");
        s.className = `stamp ${stamp.cls}`;
        s.textContent = stamp.text;
        card.appendChild(s);
        requestAnimationFrame(() => s.classList.add("show"));
        if (won) {
          bellEl!.classList.remove("ding");
          void bellEl!.offsetWidth;
          bellEl!.classList.add("ding");
          flyCoin(card);
          setTimeout(() => card.classList.add("sold"), 1100);
          setTimeout(() => card.remove(), 1700);
        } else {
          setTimeout(() => card.classList.add("expired"), 5200);
          setTimeout(() => card.remove(), 5900);
        }
      }, stampDelay);
      return won;
    }

    function flyCoin(card: HTMLElement) {
      const r = card.getBoundingClientRect();
      const roomRect = live!.getBoundingClientRect();
      const coin = document.createElement("div");
      coin.className = "coin";
      coin.style.left = r.left + r.width / 2 - roomRect.left + "px";
      coin.style.top = r.top - roomRect.top + "px";
      live!.appendChild(coin);
      requestAnimationFrame(() => {
        const t = registerEl!.getBoundingClientRect();
        coin.style.left = t.left + t.width / 2 - roomRect.left + "px";
        coin.style.top = t.top + t.height / 2 - roomRect.top + "px";
        coin.style.transform = "scale(.5)";
        coin.style.opacity = "0";
      });
      setTimeout(() => coin.remove(), 700);
    }

    class Customer {
      el = document.createElement("div");
      bubble: HTMLElement;
      x: number;
      y = 50;
      mode = "enter";
      target = wanderTarget();
      speed = rand(55, 95);
      restUntil = 0;
      offerCooldown = rand(1, 4);
      private _bt: ReturnType<typeof setTimeout> | undefined;

      constructor() {
        const p = pick(PALETTES);
        this.el.className = "customer idle";
        this.el.innerHTML = `
          <div class="shadow"></div>
          <div class="body" style="--c1:${p[0]};--c2:${p[1]};--skin:${p[2]}"></div>
          <div class="face" style="--hair:${p[3]}"></div>
          <div class="bubble"></div>`;
        this.bubble = this.el.querySelector(".bubble") as HTMLElement;

        if (Math.random() < 0.45) {
          const [hat, hatD] = pick(HATS);
          const h = document.createElement("div");
          h.className = "hat";
          h.style.setProperty("--hat", hat);
          h.style.setProperty("--hat-d", hatD);
          this.el.appendChild(h);
        }
        this.el.style.transform = `scale(${rand(0.88, 1.12).toFixed(2)})`;

        this.x = width() / 2 + rand(-30, 30);
        live!.appendChild(this.el);
        this.render();
      }

      say(text: string, ms = 2200) {
        this.bubble.textContent = text;
        this.bubble.classList.add("show");
        clearTimeout(this._bt);
        this._bt = setTimeout(() => this.bubble.classList.remove("show"), ms);
      }

      update(dt: number, now: number) {
        const q = queueRef.current.length;
        if (this.mode === "wander" && now > this.restUntil) {
          this.target = wanderTarget();
          this.restUntil = now + rand(2, 6);
        }
        if (this.mode === "wander" && Math.random() < dt * 0.012) {
          this.say(pick(IDLE_LINES), 1800);
        }

        // real offers only — walk to the counter when the queue has work
        const effectiveCooldown = this.offerCooldown / (1 + q / 10);
        if (
          this.mode === "wander" &&
          effectiveCooldown <= 0 &&
          q > 0 &&
          slots!.children.length < MAX_CARDS
        ) {
          this.mode = "toCounter";
          const visible = Math.max(1, Math.floor((slots!.clientWidth - 56) / CARD_STEP));
          const idx = Math.min(slots!.children.length, visible - 1);
          this.target = {
            x: width() / 2 + (idx - (visible - 1) / 2) * CARD_STEP + rand(-20, 20),
            y: height() - COUNTER_H - 30,
          };
        }
        this.offerCooldown -= dt;

        const dx = this.target.x - this.x;
        const dy = this.target.y - this.y;
        const dist = Math.hypot(dx, dy);

        if (dist > 4) {
          const step = Math.min(this.speed * dt, dist);
          this.x += (dx / dist) * step;
          this.y += (dy / dist) * step;
          this.el.classList.remove("idle");
        } else {
          this.el.classList.add("idle");
          if (this.mode === "toCounter") {
            this.mode = "wander";
            this.makeOffer();
            this.target = wanderTarget();
            this.offerCooldown = rand(6, 16);
          } else if (this.mode === "enter") {
            this.mode = "wander";
          }
        }
        this.render();
      }

      makeOffer() {
        const ev = queueRef.current.shift();
        if (!ev) return;
        this.say(pick(OFFER_LINES[String(ev.segment)] ?? OFFER_LINES.standard));
        const won = dealCard(ev);
        setTimeout(() => this.say(pick(won ? HAPPY_LINES : SAD_LINES)), 1400);
      }

      render() {
        this.el.style.left = this.x + "px";
        this.el.style.top = this.y + "px";
      }
    }

    /* ---------- burst drain: queue too deep → cards dealt straight to the counter ---------- */
    const drainTimer = setInterval(() => {
      const q = queueRef.current.length;
      if (q > 14 && slots!.children.length < 12) {
        const ev = queueRef.current.shift();
        if (ev) dealCard(ev);
      }
    }, 380);

    /* ---------- spawn & loop ---------- */
    const customers: Customer[] = [];
    const COUNT = Math.max(4, Math.min(8, Math.floor(width() / 220)));
    const spawnTimers: ReturnType<typeof setTimeout>[] = [];
    for (let i = 0; i < COUNT; i++) {
      spawnTimers.push(setTimeout(() => customers.push(new Customer()), i * 900));
    }

    let last = performance.now();
    let raf = 0;
    function tick(now: number) {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const t = now / 1000;
      for (const c of customers) c.update(dt, t);
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(drainTimer);
      spawnTimers.forEach(clearTimeout);
      live.replaceChildren();
      slots.replaceChildren();
    };
  }, []);

  const live = !!episode && (episode.status === "running" || episode.status === "paused");
  const revenue = metrics?.cum_revenue ?? 0;
  const day = Math.floor(episode?.day ?? 0);

  return (
    <div className="booking-desk">
      <div className="room">
        <div className="wall">
          <div className="shelf" />
          <div className="painting p1" />
          <div className="window" />
          <div className="painting p2" />
          <div className="clock"><div className="h hh" /><div className="h mh" /></div>
          <div className="painting p3" />
          <div className="shelf" />
        </div>
        <div className="doorway" />

        <div className="rug" />
        <div className="plant tl" />
        <div className="plant tr" />
        <div className="plant bl" />
        <div className="side-table" />
        <div className="lamp-glow g1" />
        <div className="lamp-glow g2" />
        <div className="fan"><span className="blade b1" /><span className="blade b2" /><span className="blade b3" /><span className="hub" /></div>
        <div className="shaft s1" />
        <div className="shaft s2" />
        <div className="cat"><div className="cat-tail" /><div className="cat-body" /><div className="cat-head" /></div>
        <div className="customer keeper idle">
          <div className="shadow" />
          <div className="body" style={KEEPER_BODY} />
          <div className="face" style={KEEPER_FACE} />
        </div>

        <div className="live" ref={liveRef} />

        <div className="hud">
          <div className="till">{fmtUsd(revenue)}</div>
          <div className="sub">
            {live ? `revenue · day ${day}` : episode ? "closed" : "desk idle"}
          </div>
        </div>

        {!live && (
          <div className="desk-overlay">
            <div className="desk-overlay-chip">
              {episode
                ? "episode finished — the desk is closed"
                : "desk is idle — start an episode above"}
            </div>
          </div>
        )}

        <div className="counter">
          <div className="counter-label">— OFFERS —</div>
          <div className="slots" ref={slotsRef} />
          <div className="counter-props">
            <div className="register" ref={registerRef} />
            <div className="bell" ref={bellRef} />
            <div className="ledger-book" />
          </div>
        </div>
      </div>
    </div>
  );
}
