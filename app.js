// ALKHIDMAT PRINT — browser PWA.
// Behaviour mirrors the Flutter app (android/lib/backend.dart):
// same Supabase project, same storage-path convention (<uid>/<uuid>-<name>),
// same jobs/job_files rows, same shop search + computer picking, same
// print settings {paper, copies, mode, orientation}.
// Public values only (publishable key) — identical to the app config.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm";

const SUPABASE_URL = "https://aqucbptusdjomfernoqg.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_Jqi76Rwl6CxUL_Erie_YrA_1xPS-yyt";
const BUCKET = "job-files";
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const LAST_SHOP_KEY = "alkh.lastShopId";
const PENDING_DROP_KEY = "alkh.pendingDrop";

const sb = createClient(SUPABASE_URL, PUBLISHABLE_KEY);

// ---------------------------------------------------------------- utils
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function toast(msg, ms = 4200) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._h);
  toast._h = setTimeout(() => (t.hidden = true), ms);
}
function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
function safeName(name) {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length > 120 ? cleaned.slice(-120) : cleaned;
}
function contentTypeFor(name) {
  const l = name.toLowerCase();
  if (l.endsWith(".pdf")) return "application/pdf";
  if (l.endsWith(".png")) return "image/png";
  if (l.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}
function kindFor(name) {
  return name.toLowerCase().endsWith(".pdf") ? "pdf" : "image";
}
async function sha256Hex(buf) {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** Segmented control helper: returns { get(), set(v) }. */
function wireSeg(id, initial) {
  const el = $(id);
  let value = initial;
  const paint = () =>
    el.querySelectorAll("button").forEach((b) =>
      b.classList.toggle("on", b.dataset.v === value));
  el.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => { value = b.dataset.v; paint(); }));
  paint();
  return { get: () => value, set: (v) => { value = v; paint(); } };
}
function wireStepper(minusId, plusId, valId) {
  let n = 1;
  const paint = () => ($(valId).textContent = String(n));
  $(minusId).addEventListener("click", () => { if (n > 1) { n--; paint(); } });
  $(plusId).addEventListener("click", () => { if (n < 10) { n++; paint(); } });
  paint();
  return { get: () => n };
}

// ---------------------------------------------------------------- state
let currentUser = null;
let computersByShop = null; // Map<shopId, computer[]> | null = status unknown
let statusKnown = false;

// ------------------------------------------------------- backend (mirror)
// [shop-search-match:begin] — pure matcher, unit-tested by shop-search.test.mjs
/** Lowercase + strip everything that is not a-z/0-9, so "ALK-6169",
 *  "alk 6169" and "alk6169" all normalize to "alk6169". */
function normalizeSearchText(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
/**
 * Forgiving shop match: the normalized query is a substring of the
 * normalized shop_code or of the normalized name, OR every word of the
 * query appears somewhere in the (lowercased) name. An empty query
 * matches every shop, preserving the list-all behaviour.
 */
function shopMatchesQuery(shop, query) {
  const raw = String(query ?? "").trim().toLowerCase();
  if (!raw) return true;
  const nq = normalizeSearchText(raw);
  if (nq &&
      (normalizeSearchText(shop?.shop_code).includes(nq) ||
       normalizeSearchText(shop?.name).includes(nq))) {
    return true;
  }
  const name = String(shop?.name ?? "").toLowerCase();
  const words = raw.split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => name.includes(w));
}
// [shop-search-match:end]

async function searchShops(query) {
  // The shop directory is small: fetch every active shop and filter
  // client-side with shopMatchesQuery, which tolerates a missing
  // hyphen/space in the code (alk6169 finds ALK-6169). The old
  // server-side ilike substring match could not do that.
  const { data, error } = await sb.from("shops")
    .select("id,name,shop_code,address,phone,active")
    .eq("active", true)
    .order("name");
  if (error) throw error;
  return (data ?? []).filter((s) => shopMatchesQuery(s, query));
}
async function fetchComputersByShop() {
  const { data, error } = await sb.rpc("shop_computers_public");
  if (error) throw error; // PGRST202 etc. -> status unknown (honest state)
  const map = new Map();
  for (const c of data ?? []) {
    if (!map.has(c.shop_id)) map.set(c.shop_id, []);
    map.get(c.shop_id).push({
      computerId: c.computer_id,
      name: c.computer_name ?? "",
      lastSeenAt: c.last_seen_at ? new Date(c.last_seen_at) : null,
      isOnline: !!c.is_online,
    });
  }
  return map;
}
function pickComputer(list) {
  if (!list || list.length === 0) return null;
  const sorted = [...list].sort((a, b) => {
    if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
    if (!a.lastSeenAt && !b.lastSeenAt) return 0;
    if (!a.lastSeenAt) return 1;
    if (!b.lastSeenAt) return -1;
    return b.lastSeenAt - a.lastSeenAt;
  });
  return sorted[0];
}
async function createMultiFileJob({ shop, computer, files, settings }) {
  const userId = currentUser.id;
  const uploaded = [];
  try {
    const fileRows = [];
    for (const f of files) {
      const buf = await f.arrayBuffer();
      const digest = await sha256Hex(buf);
      const path = `${userId}/${crypto.randomUUID()}-${safeName(f.name)}`;
      const { error } = await sb.storage.from(BUCKET).upload(path, buf, {
        contentType: contentTypeFor(f.name),
      });
      if (error) throw error;
      uploaded.push(path);
      fileRows.push({
        storage_path: path,
        orig_name: f.name,
        kind: kindFor(f.name),
        size_bytes: f.size,
        sha256: digest,
      });
    }
    const { data: job, error: jobErr } = await sb.from("jobs").insert({
      customer_id: userId,
      shop_id: shop.id,
      computer_id: computer.computerId,
      type: "file",
      status: "queued",
      settings,
    }).select("id").single();
    if (jobErr) throw jobErr;
    for (const row of fileRows) {
      const { error } = await sb.from("job_files")
        .insert({ job_id: job.id, ...row });
      if (error) throw error;
    }
    return job.id;
  } catch (e) {
    if (uploaded.length) {
      try { await sb.storage.from(BUCKET).remove(uploaded); } catch (_) {}
    }
    throw e;
  }
}
async function fetchMyJobs() {
  const { data: jobs, error } = await sb.from("jobs")
    .select()
    .eq("customer_id", currentUser.id)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  if (!jobs || jobs.length === 0) return [];
  const ids = jobs.map((j) => j.id);
  const { data: files } = await sb.from("job_files")
    .select("job_id,orig_name").in("job_id", ids);
  const names = new Map();
  for (const f of files ?? []) {
    if (!names.has(f.job_id)) names.set(f.job_id, f.orig_name);
  }
  return jobs.map((j) => ({ ...j, fileName: names.get(j.id) ?? "" }));
}

// ------------------------------------------------------------ shop picker
function makeShopPicker({ searchId, listId, selectedId, onPick }) {
  let selected = null;
  let shops = [];
  const listEl = $(listId), selEl = $(selectedId);
  function shopOnline(shop) {
    if (!statusKnown || !computersByShop) return null;
    const cs = computersByShop.get(shop.id) ?? [];
    return cs.some((c) => c.isOnline);
  }
  function render() {
    listEl.innerHTML = shops.map((s) => {
      const on = shopOnline(s);
      const dot = on === null ? "" :
        `<span class="dot ${on ? "on" : "off"}"></span>`;
      return `<button type="button" class="shop-item" data-id="${s.id}">
        ${dot}<span class="meta"><span class="name">${esc(s.name)}</span><br>
        <span class="sub">${esc(s.shop_code)}${s.address ? " · " + esc(s.address) : ""}</span></span>
      </button>`;
    }).join("");
    listEl.querySelectorAll(".shop-item").forEach((b) =>
      b.addEventListener("click", () => pick(b.dataset.id)));
  }
  function pick(id) {
    selected = shops.find((s) => s.id === id) ?? null;
    if (selected) {
      localStorage.setItem(LAST_SHOP_KEY, selected.id);
      selEl.hidden = false;
      selEl.textContent = `Shop: ${selected.name} (${selected.shop_code})`;
      onPick?.(selected);
    }
  }
  async function refresh(query = "") {
    try {
      shops = await searchShops(query);
      render();
      const lastId = localStorage.getItem(LAST_SHOP_KEY);
      if (!selected && lastId && shops.some((s) => s.id === lastId)) pick(lastId);
    } catch (_) {
      listEl.innerHTML = `<p class="hint">Shops could not be loaded. Check your connection.</p>`;
    }
  }
  let debounce;
  $(searchId).addEventListener("input", (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => refresh(e.target.value), 300);
  });
  return {
    refresh,
    render,
    get selected() { return selected; },
    targetComputer() {
      if (!statusKnown || !computersByShop || !selected) return null;
      return pickComputer(computersByShop.get(selected.id) ?? []);
    },
    blockReason() {
      if (!selected) return "Please choose a shop first.";
      if (!statusKnown) {
        return "Shop availability could not be checked right now, so jobs cannot be sent yet. Please try again later.";
      }
      if ((computersByShop.get(selected.id) ?? []).length === 0) {
        return "This shop has no registered computer yet, so it cannot receive jobs.";
      }
      return null;
    },
  };
}

// ------------------------------------------------------------------- auth
const authMode = wireSeg("auth-mode", "login");
function paintAuthMode() {
  const signup = authMode.get() === "signup";
  $("auth-name-wrap").hidden = !signup;
  $("auth-password").autocomplete = signup ? "new-password" : "current-password";
  $("auth-submit").textContent = signup ? "Sign up" : "Login";
}
$("auth-mode").addEventListener("click", paintAuthMode);
$("auth-submit").addEventListener("click", async () => {
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  const name = $("auth-name").value.trim();
  const errEl = $("auth-error");
  errEl.hidden = true;
  if (!email || !password) {
    errEl.textContent = "Email and password are required.";
    errEl.hidden = false;
    return;
  }
  $("auth-submit").disabled = true;
  try {
    if (authMode.get() === "signup") {
      const { error } = await sb.auth.signUp({
        email, password, options: { data: { full_name: name } },
      });
      if (error) throw error;
      toast("Account created. If email confirmation is on, confirm from your inbox, then login.");
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch (e) {
    errEl.textContent = e.message ?? "Login failed.";
    errEl.hidden = false;
  } finally {
    $("auth-submit").disabled = false;
  }
});
$("btn-logout").addEventListener("click", () => sb.auth.signOut());

// --------------------------------------------------------------- new job
const jobPicker = makeShopPicker({
  searchId: "shop-search", listId: "shop-list", selectedId: "shop-selected",
});
const optPaper = wireSeg("opt-paper", "A4");
const optMode = wireSeg("opt-mode", "color");
const optOrientation = wireSeg("opt-orientation", "portrait");
const copies = wireStepper("copies-minus", "copies-plus", "copies-val");

const pickedFiles = [];
function renderPickedFiles() {
  $("file-list").innerHTML = pickedFiles.map((f, i) =>
    `<li><span>${esc(f.name)}</span><span class="sz">${fmtSize(f.size)}</span>
     <button type="button" class="ghost" data-rm="${i}">Remove</button></li>`).join("");
  $("file-list").querySelectorAll("[data-rm]").forEach((b) =>
    b.addEventListener("click", () => {
      pickedFiles.splice(Number(b.dataset.rm), 1);
      renderPickedFiles();
    }));
}
$("file-input").addEventListener("change", (e) => {
  const allowed = ["jpg", "jpeg", "png", "webp", "pdf"];
  for (const f of e.target.files) {
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    if (!allowed.includes(ext)) { toast(`Skipped (type not supported): ${f.name}`); continue; }
    if (f.size > MAX_FILE_BYTES) { toast(`Skipped (over 25 MB): ${f.name}`); continue; }
    pickedFiles.push(f);
  }
  e.target.value = "";
  renderPickedFiles();
});
$("btn-send-job").addEventListener("click", async () => {
  const errEl = $("job-error"), okEl = $("job-ok");
  errEl.hidden = true; okEl.hidden = true;
  const block = jobPicker.blockReason();
  if (block) { errEl.textContent = block; errEl.hidden = false; return; }
  if (pickedFiles.length === 0) {
    errEl.textContent = "Please choose at least one file.";
    errEl.hidden = false;
    return;
  }
  const btn = $("btn-send-job");
  btn.disabled = true;
  try {
    const jobId = await createMultiFileJob({
      shop: jobPicker.selected,
      computer: jobPicker.targetComputer(),
      files: [...pickedFiles],
      settings: {
        paper: optPaper.get(),
        copies: copies.get(),
        mode: optMode.get(),
        orientation: optOrientation.get(),
      },
    });
    pickedFiles.length = 0;
    renderPickedFiles();
    okEl.textContent = `Job sent! (${jobId.slice(0, 8)}) — see My Jobs for live status.`;
    okEl.hidden = false;
    refreshJobs();
  } catch (_) {
    errEl.textContent = "Could not send the job. Please try again.";
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

// --------------------------------------------------------------- my jobs
const tabs = wireSeg("main-tabs", "new");
function paintTabs() {
  const jobs = tabs.get() === "jobs";
  $("panel-new").hidden = jobs;
  $("panel-jobs").hidden = !jobs;
  if (jobs) refreshJobs();
}
$("main-tabs").addEventListener("click", paintTabs);
async function refreshJobs() {
  if (!currentUser) return;
  try {
    const jobs = await fetchMyJobs();
    $("jobs-empty").hidden = jobs.length > 0;
    $("jobs-list").innerHTML = jobs.map((j) => {
      const st = String(j.status ?? "queued").toLowerCase();
      const when = new Date(j.created_at).toLocaleString();
      return `<div class="job-item">
        <div class="top"><span class="fname">${esc(j.fileName || "Print job")}</span>
        <span class="chip ${st}">${esc(st)}</span></div>
        <div class="sub">${when}${j.fail_reason ? " · " + esc(j.fail_reason) : ""}</div>
      </div>`;
    }).join("");
  } catch (_) { /* keep the last good list on screen */ }
}
$("btn-refresh-jobs").addEventListener("click", refreshJobs);
let jobsTimer = null;
let jobsChannel = null;
function startJobWatching() {
  stopJobWatching();
  jobsTimer = setInterval(refreshJobs, 20000); // polling fallback (as in app)
  try {
    jobsChannel = sb.channel(`my-jobs-${currentUser.id}`)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "jobs",
          filter: `customer_id=eq.${currentUser.id}` },
        () => refreshJobs())
      .subscribe();
  } catch (_) { /* polling still runs */ }
}
function stopJobWatching() {
  if (jobsTimer) clearInterval(jobsTimer);
  jobsTimer = null;
  if (jobsChannel) { try { sb.removeChannel(jobsChannel); } catch (_) {} }
  jobsChannel = null;
}

// ------------------------------------------------------------------ claim
const claimPicker = makeShopPicker({
  searchId: "claim-shop-search", listId: "claim-shop-list",
  selectedId: "claim-shop-selected",
});
const claimPaper = wireSeg("claim-paper", "A4");
const claimMode = wireSeg("claim-mode", "color");
const claimOrientation = wireSeg("claim-orientation", "portrait");
const claimCopies = wireStepper("claim-copies-minus", "claim-copies-plus", "claim-copies-val");
// Claim mode (v57 WhatsApp Inbox): "job" = direct print job (original),
// "inbox" = files land in the shop's Print Suite Inbox, no print options.
const claimSendMode = wireSeg("claim-send-mode", "job");
function paintClaimMode() {
  const inbox = claimSendMode.get() === "inbox";
  $("claim-options").hidden = inbox;
  $("claim-send").textContent = inbox ? "Shop Inbox mein bhejo" : "Print job bhejo";
}
$("claim-send-mode").addEventListener("click", paintClaimMode);
let claimGroupId = null;

async function claimCall(body) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error("unauthorized");
  const res = await fetch(`${SUPABASE_URL}/functions/v1/share-claim`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: PUBLISHABLE_KEY,
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ?? `http_${res.status}`);
    err.code = data.error;
    throw err;
  }
  return data;
}
const CLAIM_ERRORS = {
  not_found: "This shared-file link is not valid. Please share the file again from WhatsApp.",
  already_claimed: "These shared files were already sent.",
  expired: "This shared file has expired (shares stay valid for 24 hours). Please share it again from WhatsApp.",
  unauthorized: "Please login first, then this shared file will open here.",
};
async function loadClaim(groupId) {
  claimGroupId = groupId;
  $("claim-card").hidden = false;
  paintClaimMode();
  const errEl = $("claim-error");
  errEl.hidden = true;
  try {
    const preview = await claimCall({ action: "preview", group_id: groupId });
    $("claim-files").innerHTML = preview.files.map((f) =>
      `<li><span>${esc(f.original_name)}</span><span class="sz">${fmtSize(f.size_bytes)}</span></li>`).join("");
    $("claim-expires").textContent =
      `Valid until ${new Date(preview.expires_at).toLocaleString()}`;
    await claimPicker.refresh();
  } catch (e) {
    $("claim-files").innerHTML = "";
    $("claim-expires").textContent = "";
    errEl.textContent = CLAIM_ERRORS[e.code] ?? "These shared files could not be loaded.";
    errEl.hidden = false;
    if (e.code === "already_claimed" || e.code === "expired" || e.code === "not_found") {
      sessionStorage.removeItem(PENDING_DROP_KEY);
      claimGroupId = null;
    }
  }
}
$("claim-send").addEventListener("click", async () => {
  const errEl = $("claim-error");
  errEl.hidden = true;
  if (!claimGroupId) return;
  const block = claimPicker.blockReason();
  if (block) { errEl.textContent = block; errEl.hidden = false; return; }
  const btn = $("claim-send");
  btn.disabled = true;
  const inbox = claimSendMode.get() === "inbox";
  try {
    if (inbox) {
      await claimCall({
        action: "claim",
        mode: "inbox",
        group_id: claimGroupId,
        shop_id: claimPicker.selected.id,
        computer_id: claimPicker.targetComputer().computerId,
      });
      sessionStorage.removeItem(PENDING_DROP_KEY);
      claimGroupId = null;
      $("claim-card").hidden = true;
      toast("Files shop ke Inbox mein bhej di gayi hain — operator software mein khol kar print karega.", 6000);
      return;
    }
    const out = await claimCall({
      action: "claim",
      group_id: claimGroupId,
      shop_id: claimPicker.selected.id,
      computer_id: claimPicker.targetComputer().computerId,
      settings: {
        paper: claimPaper.get(),
        copies: claimCopies.get(),
        mode: claimMode.get(),
        orientation: claimOrientation.get(),
      },
    });
    sessionStorage.removeItem(PENDING_DROP_KEY);
    claimGroupId = null;
    $("claim-card").hidden = true;
    toast(`Shared files sent as job ${String(out.job_id).slice(0, 8)} — watch My Jobs for status.`, 6000);
    tabs.set("jobs");
    paintTabs();
  } catch (e) {
    errEl.textContent = CLAIM_ERRORS[e.code] ?? "Could not send these files. Please try again.";
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
});
$("claim-dismiss").addEventListener("click", () => {
  sessionStorage.removeItem(PENDING_DROP_KEY);
  claimGroupId = null;
  $("claim-card").hidden = true;
});

// ------------------------------------------------------------- app wiring
async function loadComputers() {
  try {
    computersByShop = await fetchComputersByShop();
    statusKnown = true;
  } catch (_) {
    computersByShop = null;
    statusKnown = false;
  }
  jobPicker.render();
  claimPicker.render();
}
async function onSignedIn(user) {
  currentUser = user;
  $("auth-view").hidden = true;
  $("main-view").hidden = false;
  $("user-email").textContent = user.email ?? "";
  const standalone = window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;
  $("install-hint").hidden = standalone;
  await loadComputers();
  await jobPicker.refresh();
  refreshJobs();
  startJobWatching();
  const pending = sessionStorage.getItem(PENDING_DROP_KEY);
  if (pending) loadClaim(pending);
}
function onSignedOut() {
  currentUser = null;
  stopJobWatching();
  $("main-view").hidden = true;
  $("auth-view").hidden = false;
  paintAuthMode();
}

// Share-target landing: ?drop=<group> or ?drop_error=<code>
(function handleLanding() {
  const params = new URLSearchParams(window.location.search);
  const drop = params.get("drop");
  const dropError = params.get("drop_error");
  if (drop) sessionStorage.setItem(PENDING_DROP_KEY, drop);
  if (drop || dropError) {
    history.replaceState(null, "", window.location.pathname);
  }
  if (dropError) {
    const messages = {
      no_files: "No file was received from the share. Please try sharing again.",
      too_many: "Too many files in one share (max 10). Please share fewer files.",
      too_big: "A shared file was over the 25 MB limit, so nothing was sent.",
      bad_type: "That file type cannot be printed. Please share a photo, PDF or document.",
      server: "The shared file could not be saved. Please try sharing again.",
    };
    setTimeout(() => toast(messages[dropError] ?? "The share did not work. Please try again.", 6000), 400);
  }
})();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

sb.auth.onAuthStateChange((_event, session) => {
  if (session?.user) onSignedIn(session.user);
  else onSignedOut();
});
sb.auth.getSession().then(({ data }) => {
  if (data.session?.user) onSignedIn(data.session.user);
  else onSignedOut();
});
