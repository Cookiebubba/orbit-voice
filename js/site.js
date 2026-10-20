import { marked } from "https://cdn.jsdelivr.net/npm/marked@12.0.2/lib/marked.esm.js";
import DOMPurify from "https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.es.mjs";
import { startBackground } from "./background.js?v=3";

/* --------------------------------- config --------------------------------- */
const REPO = "Cookiebubba/orbit-voice";
const X_HANDLE = "brandynships";

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
startBackground(document.getElementById("bg"));

const handle = document.getElementById("handle");
handle.querySelector("span").textContent = `@${X_HANDLE}`;
handle.href = `https://x.com/${X_HANDLE}`;

const view = document.getElementById("view");
let current = null; // { page, section }
let release = null; // the latest release's installer, once known
const cache = new Map(); // fetched markdown, by page

/* --------------------------------- router --------------------------------- */
// routes: #/  ·  #/docs  ·  #/docs/how-it-works
function parse() {
  const [page = "", section = ""] = location.hash.replace(/^#\/?/, "").split("/");
  return { page: PAGES[page] ? page : "", section };
}

async function route() {
  const next = parse();
  if (current && current.page === next.page) {      // same page: just move to the section
    current = next;
    if (next.page) scrollToSection(next.section, true);
    return;
  }
  const first = !current;
  current = next;
  if (!first) { view.classList.add("leaving"); await wait(180); }
  document.body.dataset.page = next.page || "home";
  document.querySelectorAll(".nav a[data-route]").forEach(a => {
    if (a.dataset.route === next.page) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  document.title = next.page ? `${PAGES[next.page].title} · Orbit` : "Orbit";
  if (next.page) renderDoc(next.page, next.section); else renderHome();
  view.classList.remove("leaving");
}
addEventListener("hashchange", route);
route();

const wait = ms => new Promise(r => setTimeout(r, ms));

/* ---------------------------------- home ---------------------------------- */
function renderHome() {
  view.replaceChildren(document.getElementById("tpl-home").content.cloneNode(true));
  if (release) showRelease(); else loadRelease();
}

async function loadRelease() {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) return;
    const data = await res.json();
    const exe = (data.assets || []).find(a => /\.exe$/i.test(a.name));
    if (!exe) return;
    release = { url: exe.browser_download_url, version: data.tag_name, mb: Math.round(exe.size / 1048576) };
    showRelease();
  } catch { /* offline or rate-limited: the button still opens the releases page */ }
}

function showRelease() {
  const btn = document.getElementById("download"), meta = document.getElementById("dl-meta");
  if (!btn || !release) return;
  btn.href = release.url;
  meta.textContent = `${release.version} · ${release.mb} MB · Windows 10 / 11`;
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
