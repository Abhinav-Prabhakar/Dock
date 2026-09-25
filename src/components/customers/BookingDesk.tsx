"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import "./booking-desk.css";

const KEEPER_BODY = {
  "--c1": "#2e4a3a",
  "--c2": "#1e3028",
  "--skin": "#e0b090",
} as CSSProperties;
const KEEPER_FACE = { "--hair": "#d8d0c0" } as CSSProperties;

export function BookingDesk() {
  const liveRef = useRef<HTMLDivElement>(null);
  const slotsRef = useRef<HTMLDivElement>(null);
  const tillRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLDivElement>(null);
  const registerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const live = liveRef.current;
    const slots = slotsRef.current;
    const tillEl = tillRef.current;
    const bellEl = bellRef.current;
    const registerEl = registerRef.current;
    if (!live || !slots || !tillEl || !bellEl || !registerEl) return;

    const COUNTER_H = 290;
    const MAX_CARDS = 9;
    const CARD_STEP = 284; // card width + slot gap
    let till = 0;

    /* ---------- catalogue ---------- */
    /* route table — mirrors backend/data/calibration.py ROUTES
       (origin, dest, market $/TEU) */
    const ROUTES: [string, string, number][] = [
      ["CNSHA", "NLRTM", 1780], ["CNSHA", "DEHAM", 1820], ["CNSHA", "BEANR", 1720],
      ["CNSHA", "USLAX", 1720], ["CNSHA", "USNYC", 2150], ["NLRTM", "CNSHA", 790],
      ["DEHAM", "CNSHA", 810], ["USLAX", "CNSHA", 760], ["USNYC", "CNSHA", 930],
      ["CNSHA", "SGSIN", 690], ["SGSIN", "CNSHA", 470],
    ];
    const SEGMENTS = ["urgent", "standard", "flexible"];
    const CARGO: [string, string][] = [["📦", "dry"], ["❄️", "reefer"], ["⚠️", "hazmat"]];
    let reqSeq = 100;

    const NAMES = ["Mabel","Cyrus","Ines","Rolf","Priya","Dmitri","Wren","Aldo","Suki","Bram","Nadia","Otis"];
    const PALETTES = [
      ["#7a4a6a","#4a2a44","#e8b890","#3a2418"], // plum coat
      ["#3a5a7a","#24344a","#d4a878","#1c140c"], // navy
      ["#6a7a3a","#3f4a24","#c89878","#5a3a1c"], // olive
      ["#8a3a3a","#4a2020","#e0b090","#2a1a12"], // rust
      ["#4a7a6a","#2a4a40","#d8a880","#101010"], // teal
      ["#7a6a3a","#4a3f22","#caa07a","#3a2a14"], // mustard
    ];
    const OFFER_LINES = ["Care to make a deal?","This one's special…","For you, a fair price.","Rare find, this!","Won't find better."];
    const HAPPY_LINES = ["A pleasure!","Deal!","You won't regret it.","Sold, then!"];
    const SAD_LINES   = ["Hm. Your loss.","Perhaps next time.","I see how it is…","Oh well."];
    const IDLE_LINES  = ["Lovely shop…","Hmm, interesting.","Just browsing.","What a place!","Is that a cat?"];
    const HATS: [string, string][] = [["#6a3a2a","#3a1e14"],["#2a3a4a","#16202c"],["#4a4a26","#2a2a14"],["#5a2a3a","#30141e"]];

    const width = () => live.clientWidth;
    const height = () => live.clientHeight;

    /* ---------- dust motes ---------- */
    for (let i = 0; i < 12; i++) {
      const m = document.createElement("div");
      m.className = "mote";
      m.style.left = 10 + Math.random() * 80 + "vw";
      m.style.top = 10 + Math.random() * 50 + "vh";
      m.style.setProperty("--dx", Math.random() * 160 - 80 + "px");
      m.style.setProperty("--dy", 60 + Math.random() * 140 + "px");
      m.style.setProperty("--d", 10 + Math.random() * 14 + "s");
      m.style.animationDelay = -Math.random() * 14 + "s";
      live.appendChild(m);
    }

    /* ---------- customers ---------- */
    const rand = (a: number, b: number) => a + Math.random() * (b - a);
    const pick = <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];

    function wanderTarget() {
      return {
        x: rand(60, width() - 60),
        y: rand(80, height() - COUNTER_H - 50),
      };
    }

    class Customer {
      el = document.createElement("div");
      bubble: HTMLElement;
      x: number;
      y = 50; // spawn at the door
      name = pick(NAMES);
      mode = "enter";
      target = wanderTarget();
      speed = rand(55, 95); // px per second
      restUntil = 0;
      offerCooldown = rand(1, 4); // seconds before first offer
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

        if (Math.random() < 0.45) {          // some wear hats
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
        // occasionally pick a new wandering target
        if (this.mode === "wander" && now > this.restUntil) {
          this.target = wanderTarget();
          this.restUntil = now + rand(2, 6);
        }

        // rare idle chatter while browsing
        if (this.mode === "wander" && Math.random() < dt * 0.012) {
          this.say(pick(IDLE_LINES), 1800);
        }

        // when ready, walk to the counter to make an offer
        if (this.mode === "wander" && this.offerCooldown <= 0 &&
            slots!.children.length < MAX_CARDS) {
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
            this.offerCooldown = rand(8, 20); // come back later
          } else if (this.mode === "enter") {
            this.mode = "wander";
          }
        }
        this.render();
      }

      makeOffer() {
        const [origin, dest, market] = pick(ROUTES);
        const segment = pick(SEGMENTS);
        const [cargoIcon, cargo] = pick(CARGO);
        const teu = Math.round(rand(4, 40));
        const price = Math.round(market * rand(0.85, 1.3));
        const depDay = Math.round(rand(3, 60));
        const flex = pick([0, 1, 2, 3, 5]);
        const nOptions = Math.round(rand(1, 8));
        const weight = Math.round(teu * rand(8, 14));
        const total = price * teu;
        const delta = ((price - market) / market) * 100;
        this.say(pick(OFFER_LINES));

        const card = document.createElement("div");
        card.className = "offer-card";
        card.innerHTML = `
          <span class="corner tl">◆</span><span class="corner br">◆</span>
          <div><span class="route">${origin} → ${dest}</span></div>
          <div class="teu-line">${teu} TEU · REQ #${reqSeq++}</div>
          <div class="spec-line"><span class="seg seg-${segment}">${segment}</span><span class="sep">·</span><span class="cargo">${cargoIcon} ${cargo}</span></div>
          <div class="divider"></div>
          <div class="price"><small>QUOTED</small>$${price.toLocaleString()}<span class="per">/TEU</span></div>
          <div class="market">mkt $${market.toLocaleString()} ·
            <span class="delta ${delta >= 0 ? "above" : "below"}">${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%</span></div>
          <div class="meta">dep d${depDay}${flex ? ` ±${flex}d` : ""} · ${nOptions} voyages · ${weight}t</div>
          <div class="actions">
            <button class="reject">✕ No</button>
            <button class="accept">✓ Deal</button>
          </div>`;
        slots!.appendChild(card);
        slots!.scrollTo({ left: slots!.scrollWidth, behavior: "smooth" });

        const stamp = (kind: string, text: string) => {
          const s = document.createElement("span");
          s.className = `stamp ${kind}`;
          s.textContent = text;
          card.appendChild(s);
          requestAnimationFrame(() => s.classList.add("show"));
        };
        const ding = () => {
          bellEl!.classList.remove("ding");
          void bellEl!.offsetWidth;      // restart the animation
          bellEl!.classList.add("ding");
        };

        (card.querySelector(".accept") as HTMLButtonElement).onclick = () => {
          card.querySelectorAll("button").forEach(b => (b.disabled = true));
          stamp("booked", "BOOKED");
          ding();
          till += total;
          tillEl!.textContent = "$" + till.toLocaleString();
          this.say(pick(HAPPY_LINES));
          flyCoin(card);
          setTimeout(() => card.classList.add("sold"), 420);
          setTimeout(() => card.remove(), 1000);
        };
        (card.querySelector(".reject") as HTMLButtonElement).onclick = () => {
          card.querySelectorAll("button").forEach(b => (b.disabled = true));
          stamp("passed", "PASSED");
          this.say(pick(SAD_LINES));
          setTimeout(() => card.classList.add("rejected"), 420);
          setTimeout(() => card.remove(), 950);
        };
      }

      render() {
        this.el.style.left = this.x + "px";
        this.el.style.top = this.y + "px";
      }
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
      spawnTimers.forEach(clearTimeout);
      live.replaceChildren();
      slots.replaceChildren();
    };
  }, []);

  return (
    <div className="booking-desk">
      <div className="room">
        {/* wall dressing */}
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

        {/* decor */}
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

        {/* imperative layer — JS appends motes, customers, coins here */}
        <div className="live" ref={liveRef} />

        {/* HUD */}
        <div className="hud">
          <div className="till" ref={tillRef}>$0</div>
          <div className="sub">TILL</div>
        </div>

        {/* counter */}
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
