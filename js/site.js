import { marked } from "https://cdn.jsdelivr.net/npm/marked@12.0.2/lib/marked.esm.js";
import DOMPurify from "https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.es.mjs";
import { startQubit } from "./qubit.js?v=13";

/* --------------------------------- config --------------------------------- */
const REPO = "Cookiebubba/orbit-voice";
const X_HANDLE = "brandynships";
// The main button downloads this beta; the line under it, the latest stable release.
const BETA_TAG = "v1.3.0-beta.4";

// Which installer the button offers: the visitor's own system. (An iPad asks for the desktop site
// as a Mac: a Mac with a touch screen is an iPad, and gets the releases page.)
const OS = (() => {
  const p = (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || "").toLowerCase();
  if (/win/.test(p)) return "windows";
  if (/mac/.test(p) && !(navigator.maxTouchPoints > 1)) return "mac";
  return "other";
})();
const RELEASES = `https://github.com/${REPO}/releases`;
const SYSTEMS = {
  windows: { name: "Windows", label: "Download for Windows", needs: "Windows 10/11", asset: /^Orbit-Setup-.*\.exe$/i },
  mac: { name: "Mac", label: "Download for Mac", needs: "macOS 14+ · Apple silicon", asset: /^Orbit-Native-.*\.dmg$/i },
};

const GITHUB = `https://github.com/${REPO}`;
const RAW = `https://raw.githubusercontent.com/${REPO}/main/`;

// Docs pages render the repo's own markdown, fetched live, so they never drift from GitHub.
const PAGES = {
  docs:      { file: "README.md",    title: "Docs" },
  security:  { file: "SECURITY.md",  title: "Security" },
  changelog: { file: "CHANGELOG.md", title: "Changelog" },
};
// links inside the markdown that point at another docs page stay on the site
const FILE_ROUTES = Object.fromEntries(Object.entries(PAGES).map(([route, p]) => [p.file, route]));

/* ---------------------------------- boot ---------------------------------- */
startQubit(document.getElementById("qubit"));

const handle = document.getElementById("handle");
handle.querySelector("span").textContent = `@${X_HANDLE}`;
handle.href = `https://x.com/${X_HANDLE}`;

const view = document.getElementById("view");
let current = null; // { page, section }
let release = null; // { beta, stable }: each release's installer, once known
const cache = new Map(); // fetched markdown, by page

/* --------------------------------- router --------------------------------- */
// routes: #/  ·  #/about  ·  #/docs  ·  #/docs/how-it-works
const VIEWS = { about: "What is Orbit?" }; // pages that aren't markdown
function parse() {
  const [page = "", section = ""] = location.hash.replace(/^#\/?/, "").split("/");
  return { page: PAGES[page] || VIEWS[page] ? page : "", section };
}

async function route() {
  const next = parse();
  if (current && current.page === next.page) {      // same page: just move to the section
    current = next;
    if (PAGES[next.page]) scrollToSection(next.section, true);
    return;
  }
  const first = !current;
  current = next;
  if (!first) { view.classList.add("leaving"); await wait(180); }
  document.body.dataset.page = next.page || "home";
  document.querySelectorAll(".nav a[data-route]").forEach(a => {
    if (a.dataset.route === next.page) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  document.title = next.page ? `${PAGES[next.page]?.title || VIEWS[next.page]} · Orbit` : "Orbit";
  if (next.page === "about") renderAbout();
  else if (next.page) renderDoc(next.page, next.section);
  else renderHome();
  view.classList.remove("leaving");
}
addEventListener("hashchange", route);
route();

const wait = ms => new Promise(r => setTimeout(r, ms));

/* ---------------------------------- home ---------------------------------- */
function renderHome() {
  view.replaceChildren(document.getElementById("tpl-home").content.cloneNode(true));
  showRelease(); // (this system's button at once; the release list adds sizes and the stable link)
  if (!release) loadRelease();
}

// One call for both: the beta by its tag, and the newest published release that isn't a prerelease,
// each with its installer for Windows and for Mac (when it has one).
async function loadRelease() {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=20`, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) return;
    const list = await res.json();
    const pick = (r, os) => {
      const file = r && (r.assets || []).find(a => SYSTEMS[os].asset.test(a.name));
      return file && { url: file.browser_download_url, version: r.tag_name, mb: Math.round(file.size / 1048576) };
    };
    const beta = list.find(r => r.tag_name === BETA_TAG && !r.draft);
    const stable = list.find(r => !r.draft && !r.prerelease);
    release = {
      beta: { windows: pick(beta, "windows"), mac: pick(beta, "mac") },
      stable: { windows: pick(stable, "windows"), mac: pick(stable, "mac") },
    };
    showRelease();
  } catch { /* offline or rate-limited: the links in the page still point at the installers */ }
}

function showRelease() {
  const btn = document.getElementById("download"), label = document.getElementById("dl-label"), meta = document.getElementById("dl-meta");
  const other = document.getElementById("download-other"), otherLine = document.getElementById("dl-other-line");
  const stable = document.getElementById("download-stable"), stableLine = document.getElementById("dl-stable-line");
  if (!btn) return;
  if (OS === "other") {
    // Linux, a phone, a tablet: Orbit runs on Windows and Mac, so the releases page says which to get.
    btn.href = RELEASES;
    label.textContent = "Get Orbit for Windows or Mac";
    meta.textContent = `${BETA_TAG} · Windows 10/11 · macOS 14+ (Apple silicon)`;
    otherLine.hidden = true;
  } else {
    const otherOS = OS === "mac" ? "windows" : "mac";
    const beta = release?.beta?.[OS], alt = release?.beta?.[otherOS];
    label.textContent = SYSTEMS[OS].label;
    meta.textContent = `${BETA_TAG} · with Qubit · ${SYSTEMS[OS].needs}`;
    // Before the release list arrives (or if it can't), the files' own links, by their names.
    btn.href = beta?.url || fileUrl(OS);
    btn.title = beta ? `Orbit ${beta.version} · ${beta.mb} MB` : "";
    other.textContent = `or download for ${SYSTEMS[otherOS].name}`;
    other.href = alt?.url || fileUrl(otherOS);
    otherLine.hidden = false;
  }
  // The latest stable release: Windows only so far (Orbit for Mac is a beta).
  const st = release?.stable?.[OS === "mac" ? "mac" : "windows"];
  stableLine.hidden = OS === "mac" && !st;
  if (st) {
    stable.href = st.url;
    stable.title = `Orbit ${st.version} · ${st.mb} MB`;
  }
}

/** The beta's installer for `os`, by the name the release workflow and package.sh give it. */
function fileUrl(os) {
  const v = BETA_TAG.slice(1);
  return `${RELEASES}/download/${BETA_TAG}/${os === "mac" ? `Orbit-Native-${v}-arm64.dmg` : `Orbit-Setup-${v}.exe`}`;
}

/* ---------------------------------- about --------------------------------- */
function renderAbout() {
  view.replaceChildren(document.getElementById("tpl-about").content.cloneNode(true));
  view.querySelector("video").play?.().catch(() => {}); // muted autoplay; the poster stands in if a browser refuses
}

/* ---------------------------------- docs ---------------------------------- */
async function renderDoc(page, section) {
  view.replaceChildren(document.getElementById("tpl-doc").content.cloneNode(true));
  const scroller = view.querySelector(".scroller"), doc = view.querySelector(".doc"), toc = view.querySelector(".toc");
  scroller.focus({ preventScroll: true }); // arrow keys and page up/down scroll the doc straight away

  let md = cache.get(page);
  if (!md) {
    try {
      const res = await fetch(RAW + PAGES[page].file);
      if (!res.ok) throw new Error(res.status);
      md = await res.text();
      cache.set(page, md);
    } catch {
      if (current?.page !== page) return;
      doc.innerHTML = `<p class="status">Couldn't load this page. <a href="${GITHUB}/blob/main/${PAGES[page].file}" target="_blank" rel="noopener">Read it on GitHub ↗</a></p>`;
      return;
    }
  }
  if (current?.page !== page) return; // the visitor moved on while it loaded

  doc.innerHTML = DOMPurify.sanitize(marked.parse(tidy(page, md)));
  fixLinks(doc, page);
  buildToc(doc, toc, page, scroller);
  if (section) scrollToSection(section, false);
}

// trim what only makes sense on GitHub
function tidy(page, md) {
  if (page === "docs") {
    md = md.slice(Math.max(0, md.indexOf("\n## ")));          // README's banner, badges and screenshots
    md = md.replace(/```mermaid[\s\S]*?```\n?/g, "");         // diagrams GitHub draws but we can't
    md = "# Docs\n" + md;
  }
  return md;
}

function slug(text) {
  return text.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-");
}

function fixLinks(doc, page) {
  doc.querySelectorAll("h2, h3").forEach(h => { h.id = slug(h.textContent); });
  doc.querySelectorAll("table").forEach(t => { const wrap = document.createElement("div"); wrap.className = "table"; t.replaceWith(wrap); wrap.append(t); });
  doc.querySelectorAll("img").forEach(img => {
    const src = img.getAttribute("src");
    if (src && !/^https?:/.test(src)) img.src = new URL(src, RAW).href;
  });
  doc.querySelectorAll("a[href]").forEach(a => {
    const href = a.getAttribute("href");
    if (href.startsWith("#")) { a.href = `#/${page}/${href.slice(1)}`; return; }
    if (/^(https?:|mailto:)/.test(href)) { a.target = "_blank"; a.rel = "noopener"; return; }
    const [file, hash = ""] = href.split("#");
    if (FILE_ROUTES[file]) { a.href = `#/${FILE_ROUTES[file]}${hash ? "/" + hash : ""}`; return; }
    a.href = new URL(href, `${GITHUB}/blob/main/`).href; // anything else in the repo opens on GitHub
    a.target = "_blank"; a.rel = "noopener";
  });
}

// the side index lists the page's sections and follows along as you scroll
function buildToc(doc, toc, page, scroller) {
  const heads = [...doc.querySelectorAll("h2")];
  toc.replaceChildren(...heads.map(h => {
    const a = document.createElement("a");
    a.href = `#/${page}/${h.id}`;
    a.textContent = h.textContent;
    return a;
  }));
  const links = new Map([...toc.children].map(a => [a.hash.split("/").pop(), a]));
  const mark = () => {
    const top = scroller.getBoundingClientRect().top + 120;
    let on = heads[0];
    for (const h of heads) if (h.getBoundingClientRect().top <= top) on = h;
    links.forEach((a, id) => a.classList.toggle("on", id === on?.id));
  };
  scroller.addEventListener("scroll", mark, { passive: true });
  mark();
}

function scrollToSection(id, smooth) {
  const scroller = view.querySelector(".scroller");
  const target = id && view.querySelector(`.doc [id="${CSS.escape(id)}"]`);
  if (!scroller) return;
  if (!target) { scroller.scrollTo({ top: 0, behavior: smooth ? "smooth" : "auto" }); return; }
  const y = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 40;
  scroller.scrollTo({ top: y, behavior: smooth && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto" });
}
