// Estimated continuous-burn time for a full Zippo Slim fuel reservoir.
const FULL_TANK_BURN_SECONDS = 15 * 60; // 900s

// Minimum gap between state-changing requests from the same IP.
const MIN_ACTION_INTERVAL_MS = 1000;
// How many times an IP can violate that gap before it gets blocked outright.
const STRIKES_BEFORE_BLOCK = 5;
// How long a block lasts once triggered.
const BLOCK_DURATION_MS = 5 * 60 * 1000;

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

export class Lighter {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // Per-IP throttle state is kept in memory for speed; only active blocks
    // get written to storage, so a ban survives this DO going idle and
    // restarting, but routine rate-limit bookkeeping doesn't cost a write.
    this.ipActivity = new Map(); // ip -> { lastActionAt, strikes }
    this.ready = this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get([
        "fuelSeconds",
        "lit",
        "litAt",
        "lastRefill",
        "blockedIps",
      ]);
      this.fuelSeconds = stored.get("fuelSeconds") ?? FULL_TANK_BURN_SECONDS;
      this.lit = stored.get("lit") ?? false;
      this.litAt = stored.get("litAt") ?? null;
      this.lastRefill = stored.get("lastRefill") ?? null;

      const now = Date.now();
      const storedBlocks = stored.get("blockedIps") ?? {};
      this.blockedIps = new Map(
        Object.entries(storedBlocks).filter(([, until]) => until > now)
      );
    });
  }

  // Fuel is never decremented on a timer — it's computed on demand from how
  // long the flame has actually been lit, so every visitor sees the same
  // answer regardless of who else is loading the page right now.
  currentFuelSeconds(now) {
    if (!this.lit) return this.fuelSeconds;
    const elapsed = (now - this.litAt) / 1000;
    return Math.max(0, this.fuelSeconds - elapsed);
  }

  async persist() {
    await this.state.storage.put({
      fuelSeconds: this.fuelSeconds,
      lit: this.lit,
      litAt: this.litAt,
      lastRefill: this.lastRefill,
    });
  }

  async persistBlocks() {
    await this.state.storage.put("blockedIps", Object.fromEntries(this.blockedIps));
  }

  // Returns null if the request may proceed, or a Response to send instead.
  async guard(request, ip, now) {
    // Cheap, spoofable-but-free check: a real browser fetch() from the page
    // always sends Origin. Skipped entirely in local dev (ALLOWED_ORIGIN="*").
    if (this.env.ALLOWED_ORIGIN && this.env.ALLOWED_ORIGIN !== "*") {
      const origin = request.headers.get("Origin");
      if (origin !== this.env.ALLOWED_ORIGIN) {
        return json({ error: "bad_origin" }, 403, this.env);
      }
    }

    const blockedUntil = this.blockedIps.get(ip);
    if (blockedUntil && blockedUntil > now) {
      return json({ error: "blocked", retryAfterMs: blockedUntil - now }, 429, this.env);
    }

    const activity = this.ipActivity.get(ip) ?? { lastActionAt: 0, strikes: 0 };
    if (now - activity.lastActionAt < MIN_ACTION_INTERVAL_MS) {
      activity.strikes += 1;
      if (activity.strikes >= STRIKES_BEFORE_BLOCK) {
        const until = now + BLOCK_DURATION_MS;
        this.blockedIps.set(ip, until);
        this.ipActivity.delete(ip);
        await this.persistBlocks();
        return json({ error: "blocked", retryAfterMs: BLOCK_DURATION_MS }, 429, this.env);
      }
      this.ipActivity.set(ip, activity);
      return json({ error: "rate_limited" }, 429, this.env);
    }

    activity.lastActionAt = now;
    activity.strikes = Math.max(0, activity.strikes - 1); // good behavior decays strikes
    this.ipActivity.set(ip, activity);
    return null;
  }

  publicState(now) {
    const fuelSeconds = this.currentFuelSeconds(now);
    return {
      lit: this.lit && fuelSeconds > 0,
      fuelSeconds: Math.round(fuelSeconds),
      fuelPercent: Math.round((fuelSeconds / FULL_TANK_BURN_SECONDS) * 10000) / 100,
      fullTankBurnSeconds: FULL_TANK_BURN_SECONDS,
      lastRefill: this.lastRefill,
      serverTime: now,
    };
  }

  async fetch(request) {
    await this.ready;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(this.env) });
    }

    const url = new URL(request.url);
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const now = Date.now();

    if (request.method === "GET" && url.pathname === "/state") {
      // Opportunistically checkpoint if the tank ran dry since the last write.
      if (this.lit && this.currentFuelSeconds(now) <= 0) {
        this.fuelSeconds = 0;
        this.lit = false;
        this.litAt = null;
        await this.persist();
      }
      return json(this.publicState(now), 200, this.env);
    }

    if (request.method === "POST" && url.pathname === "/light") {
      const blocked = await this.guard(request, ip, now);
      if (blocked) return blocked;

      const fuelSeconds = this.currentFuelSeconds(now);
      if (fuelSeconds <= 0) {
        this.fuelSeconds = 0;
        this.lit = false;
        this.litAt = null;
        await this.persist();
        return json({ error: "empty", ...this.publicState(now) }, 409, this.env);
      }

      if (!this.lit) {
        this.fuelSeconds = fuelSeconds;
        this.lit = true;
        this.litAt = now;
        await this.persist();
      }
      return json(this.publicState(now), 200, this.env);
    }

    if (request.method === "POST" && url.pathname === "/extinguish") {
      const blocked = await this.guard(request, ip, now);
      if (blocked) return blocked;

      if (this.lit) {
        this.fuelSeconds = this.currentFuelSeconds(now);
        this.lit = false;
        this.litAt = null;
        await this.persist();
      }
      return json(this.publicState(now), 200, this.env);
    }

    if (request.method === "POST" && url.pathname === "/refill") {
      const blocked = await this.guard(request, ip, now);
      if (blocked) return blocked;

      const fuelSeconds = this.currentFuelSeconds(now);
      if (fuelSeconds > 0) {
        return json({ error: "not_empty", ...this.publicState(now) }, 409, this.env);
      }

      this.fuelSeconds = FULL_TANK_BURN_SECONDS;
      this.lit = false;
      this.litAt = null;
      this.lastRefill = {
        timestamp: now,
        // Coarse, Cloudflare-derived location — not the visitor's raw IP.
        city: request.cf?.city ?? null,
        region: request.cf?.region ?? null,
        country: request.cf?.country ?? null,
      };
      await this.persist();
      return json(this.publicState(now), 200, this.env);
    }

    return json({ error: "not_found" }, 404, this.env);
  }
}
