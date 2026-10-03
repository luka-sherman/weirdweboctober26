// Estimated continuous-burn time for a full Zippo Slim fuel reservoir.
const FULL_TANK_BURN_SECONDS = 15 * 60; // 900s

// Minimum gap between state-changing requests from the same IP.
const MIN_ACTION_INTERVAL_MS = 1000;
// How many times an IP can violate that gap before it gets blocked outright.
const STRIKES_BEFORE_BLOCK = 5;
// How long a block lasts once triggered.
const BLOCK_DURATION_MS = 5 * 60 * 1000;

// Each visitor lights or extinguishes their own lighter independently; they
// all draw from the one shared tank. A visitor counts as "lit" until they
// extinguish, or until we haven't heard from them for this long — lit pages
// re-assert themselves on every 15s poll, so this is comfortably more than
// one missed beat. Lazy and approximate by design.
const LIT_TTL_MS = 40 * 1000;
// Burn rate is how many lighters are lit right now, applied from the last
// checkpoint to now. Capped so a traffic spike can't instantly empty the tank.
const MAX_BURN_MULTIPLIER = 8;
// Between polls, fuel progress is only written to storage this often.
const PERSIST_EVERY_MS = 30 * 1000;

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
    // Which viewers currently have their lighter lit — in-memory only. A DO
    // eviction forgets it, but lit pages re-assert on their next poll.
    this.litViewers = new Map(); // viewerId -> lastSeenAt
    this.checkpointAt = Date.now();
    this.lastPersistAt = 0;
    this.ready = this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get([
        "fuelSeconds",
        "lastRefill",
        "refillCount",
        "blockedIps",
      ]);
      this.fuelSeconds = stored.get("fuelSeconds") ?? FULL_TANK_BURN_SECONDS;
      this.lastRefill = stored.get("lastRefill") ?? null;
      this.refillCount = stored.get("refillCount") ?? 0;

      const now = Date.now();
      const storedBlocks = stored.get("blockedIps") ?? {};
      this.blockedIps = new Map(
        Object.entries(storedBlocks).filter(([, until]) => until > now)
      );
    });
  }

  // Applies burn since the last checkpoint at the current lit count, then
  // moves the checkpoint to now. Must run before the lit set changes so the
  // elapsed interval is charged at the old rate.
  settle(now) {
    const burning = Math.min(this.litViewers.size, MAX_BURN_MULTIPLIER);
    if (burning > 0) {
      this.fuelSeconds = Math.max(0, this.fuelSeconds - ((now - this.checkpointAt) / 1000) * burning);
    }
    this.checkpointAt = now;
    if (this.fuelSeconds <= 0) {
      this.fuelSeconds = 0;
      this.litViewers.clear(); // out of fuel — everyone's flame goes out
    }
  }

  // Drops lit viewers we haven't heard from. Returns true if any dropped.
  pruneLit(now) {
    let dropped = false;
    for (const [id, lastSeen] of this.litViewers) {
      if (now - lastSeen > LIT_TTL_MS) {
        this.litViewers.delete(id);
        dropped = true;
      }
    }
    return dropped;
  }

  async persist() {
    this.lastPersistAt = this.checkpointAt;
    await this.state.storage.put({
      fuelSeconds: this.fuelSeconds,
      lastRefill: this.lastRefill,
      refillCount: this.refillCount,
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

  // Assumes settle() already ran this request, so fuelSeconds is current.
  publicState(now, viewerId) {
    const fuelSeconds = this.fuelSeconds;
    return {
      lit: this.litViewers.has(viewerId),
      litCount: this.litViewers.size,
      fuelSeconds: Math.round(fuelSeconds),
      fuelPercent: Math.round((fuelSeconds / FULL_TANK_BURN_SECONDS) * 10000) / 100,
      fullTankBurnSeconds: FULL_TANK_BURN_SECONDS,
      lastRefill: this.lastRefill,
      refillCount: this.refillCount,
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
    // Client sends a random per-page-load id as ?v=; falls back to IP for
    // stray requests without one.
    const viewerId = url.searchParams.get("v") || ip;

    // Any request from a lit viewer doubles as its heartbeat. Then charge
    // burn at the current rate, and only after that drop stale lit viewers.
    if (this.litViewers.has(viewerId)) this.litViewers.set(viewerId, now);
    this.settle(now);
    let litChanged = this.pruneLit(now);

    if (request.method === "GET" && url.pathname === "/state") {
      // A page that thinks it's lit (?lit=1) re-asserts that, e.g. after the
      // DO restarted and forgot — only if there's fuel left.
      if (url.searchParams.get("lit") === "1" && this.fuelSeconds > 0 && !this.litViewers.has(viewerId)) {
        this.litViewers.set(viewerId, now);
        litChanged = true;
      }
      if (litChanged || now - this.lastPersistAt >= PERSIST_EVERY_MS) await this.persist();
      return json(this.publicState(now, viewerId), 200, this.env);
    }

    if (request.method === "POST" && url.pathname === "/light") {
      const blocked = await this.guard(request, ip, now);
      if (blocked) return blocked;

      if (this.fuelSeconds <= 0) {
        await this.persist();
        return json({ error: "empty", ...this.publicState(now, viewerId) }, 409, this.env);
      }

      this.litViewers.set(viewerId, now);
      await this.persist();
      return json(this.publicState(now, viewerId), 200, this.env);
    }

    if (request.method === "POST" && url.pathname === "/extinguish") {
      const blocked = await this.guard(request, ip, now);
      if (blocked) return blocked;

      this.litViewers.delete(viewerId);
      await this.persist();
      return json(this.publicState(now, viewerId), 200, this.env);
    }

    if (request.method === "POST" && url.pathname === "/refill") {
      const blocked = await this.guard(request, ip, now);
      if (blocked) return blocked;

      // Only when empty (under a second left counts as empty, matching the
      // whole-second fuelSeconds the clients see).
      if (this.fuelSeconds >= 1) {
        return json({ error: "not_empty", ...this.publicState(now, viewerId) }, 409, this.env);
      }

      this.fuelSeconds = FULL_TANK_BURN_SECONDS;
      this.litViewers.clear();
      this.lastRefill = {
        timestamp: now,
        // Coarse, Cloudflare-derived location — not the visitor's raw IP.
        city: request.cf?.city ?? null,
        region: request.cf?.region ?? null,
        country: request.cf?.country ?? null,
      };
      this.refillCount += 1;
      await this.persist();
      return json(this.publicState(now, viewerId), 200, this.env);
    }

    return json({ error: "not_found" }, 404, this.env);
  }
}
