/**
 * Pre-Market Bias — the gatekeeper (a Cloudflare Worker).
 *
 * What it does:
 *   /            landing page (public): what the app is, log in, buy, open
 *   /login       sends you to Discord to log in
 *   /callback    Discord sends you back here; we add you to the server with the Member role
 *   /recheck     "I already paid": checks your roles again right now
 *   /logout      logs you out
 *   /app/...     the app itself — ONLY for people with an access role in the Discord server
 *
 * Who gets in: anyone whose Discord account has one of ACCESS_ROLE_IDS in your server
 * (the role Whop gives buyers, plus a "Free Access" role you hand out by hand), or whose ID is in OWNER_IDS.
 * The app files and data are read from your PRIVATE GitHub repo with a read-only token, so nobody can
 * get them any other way.
 *
 * Settings (Cloudflare → your Worker → Settings → Variables and Secrets):
 *   DISCORD_CLIENT_ID      (text)    from the Discord Developer Portal → OAuth2
 *   DISCORD_CLIENT_SECRET  (secret)  same page
 *   DISCORD_BOT_TOKEN      (secret)  Developer Portal → Bot → Reset Token
 *   DISCORD_GUILD_ID       (text)    your server's ID
 *   MEMBER_ROLE_ID         (text)    role(s) everyone gets when they log in, comma separated (e.g. Member,Verified)
 *   ACCESS_ROLE_IDS        (text)    roles that unlock the app, comma separated (e.g. Pro role, Free Access role)
 *   OWNER_IDS              (text)    optional: your own Discord user ID, always allowed
 *   SESSION_SECRET         (secret)  any long random string (mash the keyboard, 40+ characters)
 *   GITHUB_TOKEN           (secret)  fine-grained token, read-only "Contents" on the repo
 *   GITHUB_REPO            (text)    crsnlvn/premarket-bias
 *   WHOP_URL               (text)    your Whop checkout link
 *   PRICE_TEXT             (text)    e.g. "$29 / month"
 *   DISCORD_INVITE         (text)    optional: an invite link to show people the server
 *   LIFETIME_ROLE_ID       (text)    role for lifetime members (also list it in ACCESS_ROLE_IDS); never removed by expiry
 *   FREE_ROLE_ID           (text)    the Free Access role (also in ACCESS_ROLE_IDS)
 *   PRO_ROLE_ID            (text)    the role Whop gives monthly/yearly subscribers (shown on /admin, managed by Whop)
 */

const SESSION_DAYS = 30;
const RECHECK_SECONDS = 600;           // re-check Discord roles at most every 10 minutes
const PUBLIC_APP_FILES = /^(sw\.js|manifest\.webmanifest|version\.txt|icons\/[\w.-]+|fonts\/[\w.-]+)$/;
const API = "https://discord.com/api/v10";
const SERVED_DATA = new Set(["data/latest.json", "data/calendar.json", "data/expmove.json", "data/news.json", "data/tools.json"]);

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p === "/") return landing(req, url, env);
      if (p === "/login") return login(url, env);
      if (p === "/callback") return callback(req, url, env);
      if (p === "/recheck") return recheck(req, env);
      if (p === "/admin") return admin(req, url, env);
      if (p === "/logout") return redirect("/", [cookie("sess", "", 0)]);
      if (["/terms", "/privacy", "/refunds", "/disclaimer"].includes(p)) return legalPage(p.slice(1));
      if (p === "/api/layout") return layoutApi(req, env);
      if (p === "/app") return redirect("/app/");
      if (p.startsWith("/app/")) return app(req, url, env, ctx);
      if (p === "/favicon.ico" || p === "/icon.png") return fromGitHub("icons/icon-b-192.png", env, ctx, true);
      return new Response("Not found", { status: 404 });
    } catch (e) {
      console.log(e && e.stack || e);
      return new Response("Something went wrong. Try again in a minute.", { status: 500 });
    }
  },
};

/* ───────────────────────── the app (locked) ───────────────────────── */

async function app(req, url, env, ctx) {
  let path = decodeURIComponent(url.pathname.slice("/app/".length)) || "index.html";
  if (path.includes("..") || path.startsWith("/")) return new Response("Bad path", { status: 400 });
  if (PUBLIC_APP_FILES.test(path)) return fromGitHub(path, env, ctx, true);
  // Only the customer-facing data files are served. The model's history and internals
  // (data/history/, data/internal/, caches) never leave the repo.
  if (path.startsWith("data/") && !SERVED_DATA.has(path)) return new Response("Not found", { status: 404 });

  const isPage = path === "index.html" || path.endsWith(".html");
  const deny = (where) => isPage ? redirect(where)
    : json({ error: "locked", login: where }, 401);

  const s = await getSession(req, env);
  if (!s) return deny("/");
  const { sess, setCookie } = await refreshAccess(s, env, false);
  if (!sess.ok) return deny("/?pay=1");

  const r = await fromGitHub(path, env, ctx, false);
  if (setCookie) r.headers.append("Set-Cookie", setCookie);
  return r;
}

/* ───────────────────────── saved dashboards (per Discord account) ─────────────────────────
   Needs a KV namespace bound to this Worker as LAYOUTS. Without it the app keeps layouts on each device. */
async function layoutApi(req, env) {
  if (!env.LAYOUTS) return json({ error: "not configured" }, 501);
  const s = await getSession(req, env);
  if (!s) return json({ error: "locked", login: "/" }, 401);
  const { sess, setCookie } = await refreshAccess(s, env, false);
  if (!sess.ok) return json({ error: "locked", login: "/?pay=1" }, 401);
  const key = `layout:${sess.id}`;
  let res;
  if (req.method === "GET") {
    const v = await env.LAYOUTS.get(key);
    res = json({ layout: v ? JSON.parse(v) : null });
  } else if (req.method === "PUT") {
    if (!(req.headers.get("content-type") || "").includes("application/json")) return json({ error: "json only" }, 415);
    const body = await req.text();
    if (body.length > 64000) return json({ error: "too large" }, 413);
    let L; try { L = JSON.parse(body); } catch { return json({ error: "bad json" }, 400); }
    if (!L || typeof L !== "object" || !L.desktop || !L.mobile) return json({ error: "bad shape" }, 400);
    await env.LAYOUTS.put(key, JSON.stringify(L));
    res = json({ ok: true });
  } else return json({ error: "method" }, 405);
  if (setCookie) res.headers.append("Set-Cookie", setCookie);
  return res;
}

async function fromGitHub(path, env, ctx, isPublic) {
  const short = path.startsWith("data/") || path === "version.txt" || path === "sw.js";
  const ttl = short ? 60 : path.endsWith(".html") ? 300 : 3600;
  const key = new Request(`https://gh-cache.internal/${env.FILES ? 'r2' : env.GITHUB_REPO}/${path}`);
  const cache = caches.default;
  let hit = await cache.match(key);
  if (!hit && env.FILES) {
    // Cloudflare R2 bucket bound as FILES: the app files and the published reports live here (private, only this worker reads them).
    // files may sit at the bucket root (uploaded without folders) or under their folder path
    const o = (await env.FILES.get(path)) || (path.includes("/") ? await env.FILES.get(path.split("/").pop()) : null);
    if (!o) return new Response("Not found", { status: 404 });
    hit = new Response(await o.arrayBuffer(), { headers: { "Content-Type": typeOf(path), "Cache-Control": `public, max-age=${ttl}` } });
    ctx.waitUntil(cache.put(key, hit.clone()));
  }
  if (!hit) {
    const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/docs/${path.split("/").map(encodeURIComponent).join("/")}?ref=main`, {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github.raw",
        "User-Agent": "bias-gate",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (r.status === 404) return new Response("Not found", { status: 404 });
    if (!r.ok) return new Response(`Could not load ${path} (${r.status})`, { status: 502 });
    hit = new Response(await r.arrayBuffer(), {
      headers: { "Content-Type": typeOf(path), "Cache-Control": `public, max-age=${ttl}` },
    });
    ctx.waitUntil(cache.put(key, hit.clone()));
  }
  const out = new Response(hit.body, hit);
  out.headers.set("Cache-Control", short || !isPublic ? "private, no-cache" : "public, max-age=3600");
  if (path === "sw.js") out.headers.set("Service-Worker-Allowed", "/app/");
  out.headers.set("X-Content-Type-Options", "nosniff");
  return out;
}

function typeOf(p) {
  const ext = p.split(".").pop().toLowerCase();
  return {
    html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", json: "application/json; charset=utf-8",
    css: "text/css; charset=utf-8", txt: "text/plain; charset=utf-8", webmanifest: "application/manifest+json",
    png: "image/png", jpg: "image/jpeg", svg: "image/svg+xml", ico: "image/x-icon", woff2: "font/woff2",
  }[ext] || "application/octet-stream";
}

/* ───────────────────────── Discord login ───────────────────────── */

function login(url, env) {
  const state = randomHex(16);
  const q = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    response_type: "code",
    redirect_uri: `${url.origin}/callback`,
    scope: "identify guilds.join",
    state,
  });
  return redirect(`https://discord.com/oauth2/authorize?${q}`, [cookie("st", state, 600)]);
}

async function callback(req, url, env) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code) return redirect("/?err=cancelled");
  if (!state || state !== readCookie(req, "st")) return redirect("/?err=expired");

  const tok = await fetch(`${API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code", code, redirect_uri: `${url.origin}/callback`,
    }),
  }).then((r) => r.json());
  if (!tok.access_token) return redirect("/?err=login");

  const user = await fetch(`${API}/users/@me`, { headers: { Authorization: `Bearer ${tok.access_token}` } }).then((r) => r.json());
  if (!user.id) return redirect("/?err=login");

  // Put them in the server with the login roles (Member, Verified...), or add the roles if they're already in.
  const loginRoles = (env.MEMBER_ROLE_ID || "").split(",").map((x) => x.trim()).filter(Boolean);
  const body = { access_token: tok.access_token };
  if (loginRoles.length) body.roles = loginRoles;
  const join = await bot(env, "PUT", `/guilds/${env.DISCORD_GUILD_ID}/members/${user.id}`, body);
  if (join.status === 204) {
    for (const r of loginRoles) await bot(env, "PUT", `/guilds/${env.DISCORD_GUILD_ID}/members/${user.id}/roles/${r}`);
  }
  if (!join.ok) console.log("join failed", join.status, await join.text());

  const avatar = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=96`
    : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(user.id) >> 22n) % 6}.png`;
  const fresh = { id: user.id, name: user.global_name || user.username, av: avatar, exp: now() + SESSION_DAYS * 86400, chk: 0, ok: false, srv: false };
  const { sess } = await refreshAccess(fresh, env, true);
  return redirect(sess.ok ? "/?welcome=1" : "/", [await sessionCookie(sess, env), cookie("st", "", 0)]);
}

async function recheck(req, env) {
  const s = await getSession(req, env);
  if (!s) return redirect("/");
  const { sess } = await refreshAccess(s, env, true);
  return redirect(sess.ok ? "/?welcome=1" : "/?pay=1&checked=1", [await sessionCookie(sess, env)]);
}

async function refreshAccess(sess, env, force) {
  if (!force && now() - sess.chk < RECHECK_SECONDS) return { sess, setCookie: null };
  const owners = (env.OWNER_IDS || "").split(",").map((x) => x.trim()).filter(Boolean);
  const access = (env.ACCESS_ROLE_IDS || "").split(",").map((x) => x.trim()).filter(Boolean);
  let ok = owners.includes(sess.id), srv = false;
  const r = await bot(env, "GET", `/guilds/${env.DISCORD_GUILD_ID}/members/${sess.id}`);
  if (r.ok) {
    srv = true;
    const m = await r.json();
    ok = ok || (m.roles || []).some((x) => access.includes(x));
  } else if (r.status !== 404) {
    // Discord hiccup: keep the last answer for up to an hour so a paying user isn't locked out by a blip,
    // but never on a forced re-check, and never forever (that would hide a real setup error).
    console.log("role check failed", r.status, await r.text());
    if (!force && sess.ok && now() - sess.chk < 3600) return { sess, setCookie: null };
    const next = { ...sess, ok: owners.includes(sess.id), srv: false, chk: now(), err: r.status };
    return { sess: next, setCookie: await sessionCookie(next, env) };
  }
  const next = { ...sess, ok, srv, chk: now(), err: 0 };
  return { sess: next, setCookie: await sessionCookie(next, env) };
}

function bot(env, method, path, body) {
  return fetch(API + path, {
    method,
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/* ───────────────────────── sessions (signed cookie) ───────────────────────── */

async function sessionCookie(sess, env) {
  const data = b64u(new TextEncoder().encode(JSON.stringify(sess)));
  return cookie("sess", `${data}.${await sign(data, env)}`, SESSION_DAYS * 86400);
}

async function getSession(req, env) {
  const raw = readCookie(req, "sess");
  if (!raw || !raw.includes(".")) return null;
  const [data, sig] = raw.split(".");
  if (sig !== (await sign(data, env))) return null;
  try {
    const s = JSON.parse(new TextDecoder().decode(unb64u(data)));
    return s.exp > now() ? s : null;
  } catch { return null; }
}

async function sign(data, env) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data))));
}

const now = () => Math.floor(Date.now() / 1000);
const b64u = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const randomHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

function cookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}
function readCookie(req, name) {
  const m = (req.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? m[1] : null;
}
function redirect(to, cookies = []) {
  const h = new Headers({ Location: to, "Cache-Control": "no-store" });
  cookies.forEach((c) => h.append("Set-Cookie", c));
  return new Response(null, { status: 302, headers: h });
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ───────────────────────── landing page ───────────────────────── */

async function landing(req, url, env) {
  const s = await getSession(req, env);
  let sess = s, setCookie = null;
  if (s) ({ sess, setCookie } = await refreshAccess(s, env, false));

  const err = {
    cancelled: "Login was cancelled.",
    expired: "That login link expired. Try again.",
    login: "Discord login didn't go through. Try again.",
  }[url.searchParams.get("err")];
  const checked = url.searchParams.get("checked");
  const price = esc(env.PRICE_TEXT || "");

  let panel;
  if (!sess) {
    panel = `
      <a class="btn primary" href="/login">${DISCORD_SVG}Log in with Discord</a>
      <p class="fine">Logging in adds you to the Bias Discord. That's where your access lives. See our <a href="/privacy" style="color:inherit">Privacy Policy</a>.</p>`;
  } else if (sess.ok) {
    panel = `
      <div class="who"><img src="${esc(sess.av)}" alt=""><div><b>${esc(sess.name)}</b><span class="ok">Access active</span></div></div>
      <a class="btn primary" href="/app/">Open the app</a>
      <p class="fine">On iPhone: open it in Safari, tap Share, then <b>Add to Home Screen</b>. On Android: Chrome menu, <b>Install app</b>.</p>
      <a class="link" href="/logout">Log out</a>`;
  } else {
    panel = `
      <div class="who"><img src="${esc(sess.av)}" alt=""><div><b>${esc(sess.name)}</b><span class="muted">${sess.srv ? "In the Discord · no access yet" : "Not in the Discord yet"}</span></div></div>
      ${env.WHOP_URL ? `<a class="btn primary" href="${esc(env.WHOP_URL)}">Get access${price ? ` · ${price}` : ""}</a>` : ""}
      <p class="fine">Check out on Whop with the <b>same Discord account</b>. Whop gives you the role, and the app unlocks. By subscribing you agree to the <a href="/terms" style="color:inherit">Terms</a>, <a href="/refunds" style="color:inherit">Refund Policy</a> and <a href="/disclaimer" style="color:inherit">Risk Disclaimer</a>.</p>
      <a class="btn ghost" href="/recheck">I already paid · check again</a>
      ${sess.err ? `<p class="warn">Couldn't read your Discord roles (error ${esc(sess.err)}). The site owner needs to check the bot setup.</p>` : ""}
      ${checked ? `<p class="warn">Still no access role on your account. Whop can take a minute. If it's been longer, make sure you linked the same Discord on Whop.</p>` : ""}
      ${!sess.srv ? `<a class="btn ghost" href="/login">Join the Discord</a>` : env.DISCORD_INVITE ? `<a class="link" href="${esc(env.DISCORD_INVITE)}">Open the Discord</a>` : ""}
      <a class="link" href="/logout">Log out</a>`;
  }

  const html = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Pre-Market Bias</title>
<meta name="description" content="A bullish or bearish read on NQ and ES before every session, built from macro data, options positioning and the news.">
<meta name="theme-color" content="#05070d"><link rel="icon" href="/icon.png"><link rel="apple-touch-icon" href="/app/icons/icon-b-180.png">
<style>
:root{--bg:#05070d;--text:#f4f6fb;--sub:rgba(235,240,250,.74);--dim:rgba(235,240,250,.52);--glass:rgba(255,255,255,.07);--edge:rgba(255,255,255,.15);--hi:rgba(255,255,255,.22);
--up:#5ef2b0;--down:#ff6b8b;--amber:#ffc35a;--disc:#5865F2;--sans:-apple-system,"SF Pro Display","SF Pro Text",system-ui,"Segoe UI",Roboto,sans-serif}
*{box-sizing:border-box;margin:0;padding:0}
html{background:var(--bg)}
body{color:var(--text);font-family:var(--sans);font-size:16px;line-height:1.5;letter-spacing:-.01em;-webkit-font-smoothing:antialiased;min-height:100vh;
  padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom);position:relative;isolation:isolate;overflow-x:hidden}
body::before{content:"";position:fixed;inset:-20%;z-index:-1;pointer-events:none;
  background:radial-gradient(42% 32% at 12% 22%,rgba(255,31,90,.55),transparent 70%),radial-gradient(48% 36% at 95% 2%,rgba(42,75,255,.55),transparent 70%),
  radial-gradient(40% 30% at 88% 70%,rgba(0,196,154,.22),transparent 70%),radial-gradient(34% 26% at 30% 60%,rgba(194,27,214,.2),transparent 70%)}
.wrap{max-width:980px;margin:0 auto;padding:0 16px}
nav{display:flex;align-items:center;justify-content:space-between;padding:18px 0}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:-.02em}
.brand img{width:30px;height:30px;border-radius:8px}
.glass{background:var(--glass);-webkit-backdrop-filter:blur(28px) saturate(180%);backdrop-filter:blur(28px) saturate(180%);border:1px solid var(--edge);box-shadow:inset 0 1px 0 var(--hi),0 12px 40px rgba(0,0,0,.35)}
.hero{display:grid;grid-template-columns:1.15fr .85fr;grid-template-areas:"text panel" "demo panel";column-gap:28px;row-gap:0;align-items:center;padding:36px 0 30px}.hero .text{grid-area:text}.hero .demo{grid-area:demo}.hero .panel{grid-area:panel}
h1{font-size:clamp(40px,7vw,68px);line-height:1;letter-spacing:-.045em;font-weight:800}
h1 em{font-style:normal;background:linear-gradient(92deg,#ff6b8b,#b88cff 55%,#6aa0ff);-webkit-background-clip:text;background-clip:text;color:transparent}
.lede{color:var(--sub);font-size:18px;margin-top:16px;max-width:30em}
.panel{border-radius:28px;padding:24px;display:flex;flex-direction:column;gap:12px}
.panel h2{font-size:15px;color:var(--dim);font-weight:600}
.btn{display:flex;align-items:center;justify-content:center;gap:10px;min-height:52px;border-radius:999px;font-weight:650;text-decoration:none;color:var(--text);font-size:16px;padding:0 20px}
.btn.primary{background:#fff;color:#05070d}
.btn.primary svg{fill:var(--disc)}
.btn.ghost{border:1px solid var(--edge);background:rgba(255,255,255,.04)}
.btn:active{transform:scale(.98)}
.fine{color:var(--dim);font-size:13.5px}
.warn{color:var(--amber);font-size:13.5px}
.err{color:var(--down);font-size:14px;border:1px solid rgba(255,107,139,.4);border-radius:14px;padding:10px 14px}
.link{color:var(--dim);font-size:14px;text-align:center;text-decoration:none}
.who{display:flex;align-items:center;gap:12px}
.who img{width:44px;height:44px;border-radius:50%}
.who div{display:flex;flex-direction:column}
.who span{font-size:13.5px}.ok{color:var(--up)}.muted{color:var(--dim)}
.demo{border-radius:24px;padding:18px 20px;margin-top:26px;max-width:420px}
.demo .k{color:var(--dim);font-size:13px;font-weight:600}
.demo .call{font-size:44px;font-weight:800;letter-spacing:-.04em;line-height:1.1;margin-top:4px}
.demo .row{display:flex;justify-content:space-between;color:var(--sub);font-size:14px;padding-top:10px;margin-top:10px;border-top:1px solid rgba(255,255,255,.08)}
.chip{font-size:12.5px;font-weight:600;border:1px solid var(--edge);border-radius:999px;padding:3px 10px;color:var(--sub)}
section{padding:34px 0}
section h3{font-size:28px;letter-spacing:-.03em;font-weight:750;margin-bottom:6px}
section > p.s{color:var(--sub);margin-bottom:20px;max-width:36em}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.f{border-radius:22px;padding:18px}
.f b{display:block;font-size:16.5px;margin-bottom:4px}
.f p{color:var(--sub);font-size:14.5px}
.f i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px;vertical-align:1px}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;counter-reset:s}
.steps div{border-radius:22px;padding:18px;counter-increment:s}
.steps div::before{content:counter(s);display:inline-grid;place-items:center;width:28px;height:28px;border-radius:50%;background:#fff;color:#05070d;font-weight:800;font-size:14px;margin-bottom:10px}
.steps b{display:block;margin-bottom:2px}.steps p{color:var(--sub);font-size:14.5px}
footer{color:var(--dim);font-size:13px;padding:30px 0 40px;border-top:1px solid rgba(255,255,255,.08);margin-top:20px}
.legal{display:flex;flex-wrap:wrap;gap:6px 18px;margin-bottom:12px}.legal a{color:var(--sub);text-decoration:none;font-size:14px}.legal a:hover{color:var(--text)}footer p+p{margin-top:6px}
@media (max-width:780px){.hero{grid-template-columns:1fr;grid-template-areas:"text" "panel" "demo";row-gap:22px;padding-top:16px}.demo{margin-top:0}.grid,.steps{grid-template-columns:1fr}.demo{max-width:none}}
</style></head><body>
<div class="wrap">
  <nav><div class="brand"><img src="/icon.png" alt="">Pre-Market Bias</div>${sess ? `<a class="link" href="/logout">Log out</a>` : `<a class="link" href="/login">Log in</a>`}</nav>

  <div class="hero">
    <div class="text">
      <h1>Know the <em>bias</em> before the bell.</h1>
      <p class="lede">A bullish or bearish read on NQ and ES before every session, built from macro data, options positioning and the news. One call, the reasons behind it, and how it graded.</p>
    </div>
      <div class="demo glass" aria-label="Example of a call">
        <div class="k">Example · NQ · New York open</div>
        <div class="call" style="color:var(--up)">Bullish</div>
        <div style="display:flex;gap:8px;margin-top:6px"><span class="chip">Medium conviction</span><span class="chip">8:30–11 AM CT</span></div>
        <div class="row"><span>Macro</span><span style="color:var(--up)">Bullish</span></div>
        <div class="row"><span>Gamma &amp; options flow</span><span style="color:var(--up)">Bullish</span></div>
        <div class="row"><span>News tone</span><span style="color:var(--down)">Bearish</span></div>
      </div>
    <div class="panel glass">
      <h2>${sess ? "Your account" : "Get in"}</h2>
      ${err ? `<div class="err">${err}</div>` : ""}
      ${panel}
    </div>
  </div>

  <section>
    <h3>What's inside</h3>
    <p class="s">Everything is a directional bias for the whole session, so you can find your own entries. It isn't a trade signal.</p>
    <div class="grid">
      <div class="f glass"><b><i style="background:var(--up)"></i>Three calls a day</b><p>Pre-open for the New York morning, the overnight Asia and London move, and a live "Now" read for whichever session is trading.</p></div>
      <div class="f glass"><b><i style="background:#6aa0ff"></i>Macro first</b><p>The ten indicators the Fed watches, rates, the dollar and VIX, scored into one lean, with the reason behind every vote.</p></div>
      <div class="f glass"><b><i style="background:#b88cff"></i>Gamma and options flow</b><p>Dealer positioning, put and call walls, and the options market's expected move in futures points.</p></div>
      <div class="f glass"><b><i style="background:var(--down)"></i>Red folder previews</b><p>Every high-impact release on its day, CPI, jobs, FOMC and more, with a bullish or bearish preview.</p></div>
      <div class="f glass"><b><i style="background:var(--amber)"></i>Sunday gap</b><p>Where NQ and ES should reopen Sunday night, from Bitcoin, the Saudi market, weekend headlines and Friday's read.</p></div>
      <div class="f glass"><b><i style="background:#00c49a"></i>Graded in public</b><p>Every call is scored against what the market actually did, so you can see the hit rate before you trust it.</p></div>
    </div>
  </section>

  <section>
    <h3>How to get it</h3>
    <div class="steps">
      <div class="glass"><b>Log in with Discord</b><p>You join the Bias server automatically.</p></div>
      <div class="glass"><b>Get access${price ? ` · ${price}` : ""}</b><p>Check out on Whop with the same Discord account.</p></div>
      <div class="glass"><b>Add it to your home screen</b><p>It opens like an app and updates through the day.</p></div>
    </div>
  </section>

  <footer><div class="legal"><a href="/terms">Terms of Service</a><a href="/privacy">Privacy Policy</a><a href="/refunds">Refund Policy</a><a href="/disclaimer">Risk Disclaimer</a></div>
  <p>Pre-Market Bias is a research tool, not financial advice. Trading futures and options involves substantial risk of loss. Past results don't guarantee future results.</p>
  <p>© ${new Date().getFullYear()} Pre-Market Bias</p></footer>
</div>
</body></html>`;
  const h = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  if (setCookie) h.append("Set-Cookie", setCookie);
  return new Response(html, { headers: h });
}

const DISCORD_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.3 4.4A19.8 19.8 0 0 0 15.4 3l-.6 1.3a18.4 18.4 0 0 0-5.6 0L8.6 3a19.7 19.7 0 0 0-4.9 1.4C.6 9 -.3 13.6.1 18.1a19.9 19.9 0 0 0 6 3l1.3-2a12.9 12.9 0 0 1-2-1l.5-.4a14.2 14.2 0 0 0 12.2 0l.5.4c-.6.4-1.3.7-2 1l1.3 2a19.8 19.8 0 0 0 6-3c.5-5.2-.9-9.7-3.6-13.7ZM8 15.3c-1.2 0-2.2-1.1-2.2-2.4S6.8 10.5 8 10.5s2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Zm8 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Z"/></svg>`;

/* ───────────────────────── legal pages ───────────────────────── */
// Plain-English policies. Written as a starting point, not legal advice: have them reviewed before relying on them.
const LEGAL_UPDATED = "November 2, 2026";
const LEGAL = {
  terms: { title: "Terms of Service", body: `
<p>These terms are an agreement between you and Pre-Market Bias ("we", "us"), operated by Carson Falleur, covering your use of biasapp.net, the Pre-Market Bias app and the Bias Discord server (together, "the Service"). By logging in, subscribing or using the Service, you agree to these terms. If you don't agree, don't use the Service.</p>
<h2>1. What the Service is</h2>
<p>Pre-Market Bias publishes a research tool: a daily bullish or bearish bias for stock index futures, built from macro data, options positioning, news and other market data, with the reasons behind each read. It is general market commentary for educational and informational purposes. It is <b>not</b> investment, financial, trading, tax or legal advice, and it is not a recommendation to buy or sell anything. See the <a href="/disclaimer">Risk Disclaimer</a>, which is part of these terms.</p>
<h2>2. Eligibility</h2>
<p>You must be at least 18 years old and able to form a binding contract where you live. You are responsible for following the laws that apply to you, including any rules about trading.</p>
<h2>3. Accounts and access</h2>
<p>You log in with Discord. Access to the app is tied to your Discord account and to a role in our Discord server. You are responsible for your Discord account and everything done with it. Access is personal: don't share, resell, screenshot-and-redistribute at scale, or otherwise give others access to paid content.</p>
<h2>4. Subscriptions and payment</h2>
<p>Paid access is sold as a recurring subscription through Whop, our payment provider. The price and billing period are shown at checkout. Your subscription renews automatically until you cancel. Payments are processed by Whop and its partners under their own terms; we never see or store your full card details. We may change prices for future billing periods; we'll tell you before a change applies to you, and you can cancel before it does.</p>
<h2>5. Cancellations and refunds</h2>
<p>You can cancel any time from your Whop account. Refunds are covered by our <a href="/refunds">Refund Policy</a>.</p>
<h2>6. Acceptable use</h2>
<p>Don't: copy, scrape, resell or republish the Service or its data; try to get around the login or access checks; reverse engineer the Service; use it to break any law; harass other members of the Discord server; or interfere with how the Service runs. We may suspend or end your access if you do, without a refund.</p>
<h2>7. Intellectual property</h2>
<p>The Service, its reads, text, design, code and branding belong to us or our licensors. Your subscription gives you a personal, non-transferable, revocable license to use the Service for your own trading research while your access is active. Market data comes from third parties and remains theirs.</p>
<h2>8. Availability and data</h2>
<p>We work to keep the Service accurate and online, but we rely on third-party data and infrastructure. Reads can be late, wrong, missing or changed, data can be delayed, and the Service can be interrupted. We may change, add or remove features at any time.</p>
<h2>9. No warranty</h2>
<p>The Service is provided "as is" and "as available", without warranties of any kind, express or implied, including accuracy, fitness for a particular purpose and non-infringement. We don't promise any result, profit or level of accuracy.</p>
<h2>10. Limitation of liability</h2>
<p>To the fullest extent the law allows, we are not liable for any trading losses or for any indirect, incidental, special, consequential or punitive damages arising from your use of, or reliance on, the Service. Our total liability for any claim is limited to the amount you paid us in the three months before the claim.</p>
<h2>11. Indemnity</h2>
<p>You agree to cover us against claims, losses and costs arising from your misuse of the Service or your breach of these terms.</p>
<h2>12. Ending access</h2>
<p>You can stop using the Service and cancel at any time. We may suspend or end access for a breach of these terms or if we stop offering the Service. If we discontinue the Service entirely, we'll stop future billing.</p>
<h2>13. Changes to these terms</h2>
<p>We may update these terms. The date at the top shows the latest version. If a change is significant, we'll post it in the Discord server. Continuing to use the Service after a change means you accept it.</p>
<h2>14. Governing law</h2>
<p>These terms are governed by the laws of the United States and of the state where the operator resides, without regard to conflict-of-law rules. Where the law allows, disputes will be handled individually, not as part of a class action.</p>
<h2>15. Contact</h2>
<p>Questions about these terms: message us in the Bias Discord server or through Whop support on your membership.</p>` },

  privacy: { title: "Privacy Policy", body: `
<p>This policy explains what information Pre-Market Bias ("we") collects when you use biasapp.net, the app and the Bias Discord server, and what we do with it. We keep it to the minimum the Service needs.</p>
<h2>What we collect</h2>
<ul>
<li><b>From Discord, when you log in:</b> your Discord user ID, username, display name and avatar. We ask Discord for the "identify" and "join servers" permissions only: we can't read your messages, email or friends list.</li>
<li><b>Your server roles:</b> we check which roles you have in our Discord server to decide whether you have access.</li>
<li><b>Cookies:</b> a signed login cookie that keeps you logged in (up to 30 days) and a short-lived security cookie used during login. We don't use advertising or tracking cookies.</li>
<li><b>App settings:</b> preferences like your theme are stored in your own browser, not on our servers.</li>
<li><b>Technical logs:</b> our hosting provider (Cloudflare) processes basic request data, such as IP address and browser type, to deliver and protect the site.</li>
</ul>
<h2>Payments</h2>
<p>Payments are handled by Whop. Whop collects your payment details and billing information under its own privacy policy. We receive membership details from Whop (such as whether your membership is active and which Discord account is linked) but never your full card number.</p>
<h2>How we use it</h2>
<ul>
<li>To log you in, add you to the Discord server, and give or remove access.</li>
<li>To run, secure and improve the Service.</li>
<li>To contact you about your account or important changes, through Discord or Whop.</li>
</ul>
<h2>What we don't do</h2>
<p>We don't sell your personal information, and we don't share it with advertisers.</p>
<h2>Who processes data for us</h2>
<p>Discord (login and community), Whop (payments and memberships), Cloudflare (hosting) and GitHub (where the app and its market data are stored). Each handles data under its own terms and privacy policy.</p>
<h2>How long we keep it</h2>
<p>Login cookies expire after 30 days or when you log out. We don't keep a separate database of users; your access lives in your Discord roles and your Whop membership. Hosting logs are kept by Cloudflare for its standard periods.</p>
<h2>Your choices and rights</h2>
<p>You can log out at any time, leave the Discord server, cancel your membership on Whop, and remove our app from your Discord account under Discord's Settings → Authorized Apps. Depending on where you live, you may have rights to access, correct or delete your information; contact us and we'll help.</p>
<h2>Children</h2>
<p>The Service is for adults 18 and over. We don't knowingly collect information from anyone under 18.</p>
<h2>Changes</h2>
<p>We may update this policy; the date at the top shows the latest version.</p>
<h2>Contact</h2>
<p>Privacy questions: message us in the Bias Discord server or through Whop support on your membership.</p>` },

  refunds: { title: "Refund Policy", body: `
<p>Pre-Market Bias is a digital subscription that you can use immediately after purchase. Because of that, payments are generally final. Here is exactly how it works.</p>
<h2>Cancel any time</h2>
<p>You can cancel your subscription whenever you want from your Whop account. Cancelling stops future renewals. You keep access until the end of the billing period you already paid for, and then access ends.</p>
<h2>No refunds for partial periods</h2>
<p>We don't refund the unused part of a billing period, renewals you forgot to cancel, or periods where you didn't use the Service.</p>
<h2>When we do refund</h2>
<ul>
<li><b>Duplicate or mistaken charges:</b> if you were charged twice for the same period, we'll refund the extra charge.</li>
<li><b>Access we failed to deliver:</b> if you paid but couldn't get into the app because of a problem on our side, and we couldn't fix it within a reasonable time after you told us, we'll refund that period.</li>
<li>Any other refund is at our discretion.</li>
</ul>
<h2>Market results are not grounds for a refund</h2>
<p>The Service provides research, not guaranteed outcomes. Reads that turn out wrong, or trading losses, are not grounds for a refund. See the <a href="/disclaimer">Risk Disclaimer</a>.</p>
<h2>Chargebacks</h2>
<p>Please contact us before disputing a charge with your bank; most problems are fixed quickly. Access may be suspended while a dispute is open.</p>
<h2>How to ask</h2>
<p>Message us in the Bias Discord server or through Whop support on your membership, with the Discord account and the date of the charge. Approved refunds go back to the original payment method through Whop.</p>` },

  disclaimer: { title: "Risk Disclaimer", body: `
<p><b>Pre-Market Bias is a research and education tool. Nothing on biasapp.net, in the app or in the Bias Discord is financial, investment, trading, tax or legal advice, or a recommendation to buy or sell any security, future, option or other instrument.</b></p>
<h2>Not an adviser</h2>
<p>We are not a registered investment adviser, commodity trading advisor, broker-dealer or financial planner. The reads are general and impersonal: they don't consider your finances, goals or risk tolerance. Talk to a licensed professional before making financial decisions.</p>
<h2>Trading is risky</h2>
<p>Trading futures, options and other leveraged products involves substantial risk of loss and is not suitable for everyone. You can lose more than you put in. Only trade money you can afford to lose. You alone are responsible for your trades and their results.</p>
<h2>Bias, not signals</h2>
<p>Each read is a directional lean for a session, with a conviction level. It is not an entry, exit, stop or position size. A lean can be wrong, and even a correct lean can lose money depending on how and when you trade it.</p>
<h2>Past and hypothetical results</h2>
<p>Hit rates, records and grades shown in the app describe how past reads compared with later market moves. Past performance does not guarantee future results.</p>
<p>Hypothetical or simulated performance results have certain limitations. Unlike an actual performance record, simulated results do not represent actual trading. Also, since the trades have not been executed, the results may have under- or over-compensated for the impact, if any, of certain market factors, such as lack of liquidity. Simulated trading programs in general are also subject to the fact that they are designed with the benefit of hindsight. No representation is being made that any account will or is likely to achieve profit or losses similar to those shown.</p>
<h2>Data</h2>
<p>Market data, options data, economic releases and news come from third-party sources and may be delayed, incomplete or wrong. We don't guarantee their accuracy or timeliness, and reads built on them can be affected.</p>
<h2>Your responsibility</h2>
<p>By using the Service, you accept that you trade at your own risk and that we are not liable for any losses from your use of, or reliance on, the Service.</p>` },
};

function legalPage(key) {
  const d = LEGAL[key];
  const links = Object.entries(LEGAL).map(([k, v]) => `<a href="/${k}"${k === key ? ' class="on"' : ""}>${v.title}</a>`).join("");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${d.title} · Pre-Market Bias</title><meta name="theme-color" content="#05070d"><link rel="icon" href="/icon.png">
<style>
:root{--text:#f4f6fb;--sub:rgba(235,240,250,.78);--dim:rgba(235,240,250,.52);--edge:rgba(255,255,255,.15);--sans:-apple-system,"SF Pro Text",system-ui,"Segoe UI",Roboto,sans-serif}
*{box-sizing:border-box;margin:0;padding:0}html{background:#05070d}
body{color:var(--text);font-family:var(--sans);font-size:16px;line-height:1.6;-webkit-font-smoothing:antialiased;position:relative;isolation:isolate;overflow-x:hidden;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)}
body::before{content:"";position:fixed;inset:-20%;z-index:-1;background:radial-gradient(40% 30% at 10% 10%,rgba(255,31,90,.35),transparent 70%),radial-gradient(45% 30% at 95% 0%,rgba(42,75,255,.4),transparent 70%)}
.wrap{max-width:760px;margin:0 auto;padding:0 16px}
nav{display:flex;align-items:center;justify-content:space-between;padding:18px 0}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;color:var(--text);text-decoration:none}.brand img{width:30px;height:30px;border-radius:8px}
.tabs{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 26px}.tabs a{font-size:14px;color:var(--dim);text-decoration:none;border:1px solid var(--edge);border-radius:999px;padding:6px 12px}
.tabs a.on{color:#05070d;background:#fff;border-color:#fff}
h1{font-size:clamp(32px,6vw,46px);letter-spacing:-.035em;line-height:1.1}
.upd{color:var(--dim);font-size:14px;margin:8px 0 26px}
h2{font-size:19px;letter-spacing:-.01em;margin:28px 0 8px}
p,li{color:var(--sub)}p+p{margin-top:12px}ul{padding-left:20px;display:grid;gap:8px}
a{color:#9db8ff}b{color:var(--text)}
footer{color:var(--dim);font-size:13px;padding:30px 0 40px;margin-top:40px;border-top:1px solid rgba(255,255,255,.08)}
</style></head><body><div class="wrap">
<nav><a class="brand" href="/"><img src="/icon.png" alt="">Pre-Market Bias</a><a href="/" style="color:var(--dim);font-size:14px;text-decoration:none">← Back</a></nav>
<div class="tabs">${links}</div>
<h1>${d.title}</h1><div class="upd">Last updated ${LEGAL_UPDATED}</div>
${d.body}
<footer>© ${new Date().getFullYear()} Pre-Market Bias. A research tool, not financial advice.</footer>
</div></body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=600" } });
}


/* ───────────────────────── admin (owner only) ───────────────────────── */
// biasapp.net/admin: look up a member, grant or remove Lifetime / Free Access, see system status.
// Monthly and yearly subscriptions, coupons, refunds and failed payments are run by Whop, which adds
// and removes the Pro role on its own; this page never touches Pro, and nothing here expires Lifetime.

async function admin(req, url, env) {
  const s = await getSession(req, env);
  const owners = (env.OWNER_IDS || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!s || !owners.includes(s.id)) return new Response("Not found", { status: 404 });
  const csrf = (await sign("csrf:" + s.id, env)).slice(0, 24);
  let msg = "", err = "";
  const roles = { lifetime: env.LIFETIME_ROLE_ID, free: env.FREE_ROLE_ID };

  if (req.method === "POST") {
    const f = await req.formData();
    if (f.get("csrf") !== csrf) return new Response("Bad request", { status: 400 });
    const uid = String(f.get("uid") || "").trim(), act = String(f.get("act") || ""), kind = String(f.get("kind") || "");
    if (!/^\d{15,21}$/.test(uid)) err = "That isn't a Discord user ID.";
    else if (!roles[kind]) err = `Set ${kind === "lifetime" ? "LIFETIME_ROLE_ID" : "FREE_ROLE_ID"} in Cloudflare first.`;
    else {
      const r = await bot(env, act === "grant" ? "PUT" : "DELETE", `/guilds/${env.DISCORD_GUILD_ID}/members/${uid}/roles/${roles[kind]}`);
      if (r.ok) msg = `${act === "grant" ? "Gave" : "Removed"} ${kind === "lifetime" ? "Lifetime" : "Free Access"} ${act === "grant" ? "to" : "from"} ${uid}.`;
      else err = r.status === 404 ? "That person isn't in the server yet: they need to log in on the site once." :
        r.status === 403 ? "The bot can't manage that role: drag the bot's role above it in Server Settings → Roles." : `Discord said ${r.status}.`;
    }
    url.searchParams.set("q", uid);
  }

  // look up by ID, or search by name (needs the Server Members Intent on the bot)
  const q = (url.searchParams.get("q") || "").trim();
  let found = [], lookupNote = "";
  if (q) {
    if (/^\d{15,21}$/.test(q)) {
      const r = await bot(env, "GET", `/guilds/${env.DISCORD_GUILD_ID}/members/${q}`);
      if (r.ok) found = [await r.json()]; else lookupNote = r.status === 404 ? "Not in the server." : `Discord said ${r.status}.`;
    } else {
      const r = await bot(env, "GET", `/guilds/${env.DISCORD_GUILD_ID}/members/search?query=${encodeURIComponent(q)}&limit=10`);
      if (r.ok) found = await r.json();
      else lookupNote = r.status === 403 ? "Name search needs the Server Members Intent (Developer Portal → Bot). Search by user ID meanwhile." : `Discord said ${r.status}.`;
      if (r.ok && !found.length) lookupNote = "No one by that name.";
    }
  }

  // system status
  const checks = [];
  const g = await bot(env, "GET", `/guilds/${env.DISCORD_GUILD_ID}`);
  checks.push(["Discord bot", g.ok, g.ok ? "connected to the server" : `error ${g.status}`]);
  let built = null;
  if (env.FILES) {
    const o = (await env.FILES.get("data/latest.json")) || (await env.FILES.get("latest.json"));
    checks.push(["Report storage (R2)", !!o, o ? "reading the app data" : "data/latest.json missing in the bucket"]);
    if (o) { try { built = JSON.parse(await o.text()).generated; } catch {} }
  } else try {
    const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/docs/data/latest.json?ref=main`, {
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github.raw", "User-Agent": "bias-gate" } });
    checks.push(["GitHub data key", r.ok, r.ok ? "reading the app data" : `error ${r.status} (key expired or wrong?)`]);
    if (r.ok) built = (await r.json()).generated;
  } catch (e) { checks.push(["GitHub data key", false, "unreachable"]); }
  if (built) {
    const age = (Date.now() - Date.parse(built)) / 60000;
    checks.push(["Latest report", age < 120, `built ${Math.round(age)} min ago`]);
  }
  checks.push(["Saved dashboards (LAYOUTS)", !!env.LAYOUTS, env.LAYOUTS ? "pages save to each account" : "not bound: pages save on each device only"]);
  for (const [k, v] of [["PRO_ROLE_ID", env.PRO_ROLE_ID], ["LIFETIME_ROLE_ID", env.LIFETIME_ROLE_ID], ["FREE_ROLE_ID", env.FREE_ROLE_ID], ["WHOP_URL", env.WHOP_URL]]) {
    const inAccess = !k.endsWith("ROLE_ID") || k === "PRO_ROLE_ID" && !v || (env.ACCESS_ROLE_IDS || "").split(",").map((x) => x.trim()).includes(v);
    checks.push([k, !!v && inAccess, !v ? "not set" : inAccess ? "set" : "set, but missing from ACCESS_ROLE_IDS"]);
  }

  const roleName = (id) => id === env.LIFETIME_ROLE_ID ? "Lifetime" : id === env.FREE_ROLE_ID ? "Free Access" :
    id === env.PRO_ROLE_ID ? "Pro (Whop)" : id === env.MEMBER_ROLE_ID?.split(",")[0] ? "Member" : null;
  const access = (env.ACCESS_ROLE_IDS || "").split(",").map((x) => x.trim()).filter(Boolean);
  const card = (m) => {
    const u = m.user || {}, rs = m.roles || [];
    const has = (id) => id && rs.includes(id);
    const btn = (kind, on) => `<form method="post"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="uid" value="${esc(u.id)}">
      <input type="hidden" name="kind" value="${kind}"><input type="hidden" name="act" value="${on ? "revoke" : "grant"}">
      <button class="${on ? "ghost" : "pri"}">${on ? "Remove" : "Give"} ${kind === "lifetime" ? "Lifetime" : "Free Access"}</button></form>`;
    return `<div class="m"><div class="mh"><b>${esc(u.global_name || u.username || u.id)}</b><small>@${esc(u.username || "")} · ${esc(u.id)}</small></div>
      <div class="tags">${rs.map(roleName).filter(Boolean).map((n) => `<span>${n}</span>`).join("") || "<span>No paid role</span>"}
      <span class="${rs.some((r) => access.includes(r)) || owners.includes(u.id) ? "ok" : "no"}">${rs.some((r) => access.includes(r)) || owners.includes(u.id) ? "Has access" : "No access"}</span></div>
      <div class="acts">${btn("lifetime", has(env.LIFETIME_ROLE_ID))}${btn("free", has(env.FREE_ROLE_ID))}</div></div>`;
  };

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin · Pre-Market Bias</title><meta name="robots" content="noindex"><link rel="icon" href="/icon.png">
<style>
*{box-sizing:border-box;margin:0;padding:0}body{background:#05070d;color:#f4f6fb;font-family:-apple-system,system-ui,"Segoe UI",Roboto,sans-serif;font-size:15px;line-height:1.5;padding:20px 16px 60px}
.wrap{max-width:760px;margin:0 auto}h1{font-size:28px;letter-spacing:-.03em}h2{font-size:16px;margin:26px 0 10px;color:rgba(235,240,250,.7)}
.card{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:14px 16px}
.row{display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.06)}.row:last-child{border:0}
.ok{color:#5ef2b0}.no{color:#ff6b8b}small{color:rgba(235,240,250,.5);display:block}
input[type=search]{width:100%;padding:12px 14px;border-radius:12px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:#fff;font-size:16px}
button{font:inherit;border-radius:999px;padding:8px 14px;border:1px solid rgba(255,255,255,.2);cursor:pointer}.pri{background:#fff;color:#05070d;border-color:#fff}.ghost{background:transparent;color:#fff}
.m{padding:12px 0;border-bottom:1px solid rgba(255,255,255,.08)}.m:last-child{border:0}.tags{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}.tags span{font-size:12.5px;border:1px solid rgba(255,255,255,.18);border-radius:999px;padding:2px 9px}
.acts{display:flex;gap:8px;flex-wrap:wrap}.msg{margin-top:12px;padding:10px 14px;border-radius:12px;background:rgba(94,242,176,.12);color:#5ef2b0}.err{background:rgba(255,107,139,.12);color:#ff6b8b}
a{color:#9db8ff}
</style></head><body><div class="wrap">
<div style="display:flex;justify-content:space-between;align-items:center"><h1>Admin</h1><a href="/">← Site</a></div>
${msg ? `<div class="msg">${esc(msg)}</div>` : ""}${err ? `<div class="msg err">${esc(err)}</div>` : ""}
<h2>Members</h2><div class="card">
<form method="get"><input type="search" name="q" value="${esc(q)}" placeholder="Discord user ID or name"></form>
${lookupNote ? `<p style="margin-top:10px;color:rgba(235,240,250,.6)">${esc(lookupNote)}</p>` : ""}
${found.map(card).join("")}
<p style="margin-top:12px;font-size:13px;color:rgba(235,240,250,.55)">Lifetime and Free Access are permanent until you remove them here. Monthly and yearly subscribers get Pro from Whop, which also removes it on cancellation, refund or a failed payment.</p></div>
<h2>Subscriptions, coupons and refunds</h2><div class="card">
<div class="row"><span>Plans, coupons, refunds, failed payments</span><a href="https://whop.com/dashboard" target="_blank" rel="noopener">Whop dashboard ↗</a></div>
<div class="row"><span>Discord roles and permissions</span><span>Discord → Server Settings → Roles</span></div></div>
<h2>System status</h2><div class="card">${checks.map(([k, ok, d]) => `<div class="row"><span>${esc(k)}</span><span class="${ok ? "ok" : "no"}">${esc(d)}</span></div>`).join("")}</div>
</div></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}
