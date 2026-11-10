// Builds the site into _site/ (run automatically by .github/workflows/gallery.yml):
//  - thumbs/<slug>.webp   small thumbnails for the main page (382px wide, sharp on retina at 191px)
//  - large/<slug>.webp    lighter full-screen versions for the viewer
//  - og/<slug>.jpg        1200px JPEG used for chat-app link previews
//  - p/<slug>/            one preview page per photo (Slack, WhatsApp, iMessage…)
//  - photos.json          list of photos with sizes, albums and tags
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const FOLDER = "photos";
const OUT = "_site";
const SITE = (process.env.SITE_URL || "").replace(/\/$/, "");
if (!SITE) { console.error("SITE_URL is not set"); process.exit(1); }

const IMG = /\.(jpe?g|png|webp|gif|avif|tiff?)$/i;
const slugify = s => s.toLowerCase().replace(/\.[^.\/]+$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const pretty = s => s.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").replace(/^./, c => c.toUpperCase());
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const url = p => p.split(/[\\/]/).map(encodeURIComponent).join("/");

// 1. Copy the repo into _site (minus git and build files)
fs.rmSync(OUT, { recursive: true, force: true });
const skip = /^(\.git|\.github|_site|node_modules)(\/|$)/;
fs.cpSync(".", OUT, { recursive: true, filter: src => !skip.test(path.relative(".", src).split(path.sep).join("/")) });
for (const d of ["thumbs", "large", "og", "p"]) fs.mkdirSync(path.join(OUT, d), { recursive: true });

// 2. Site name and tags
const index = fs.readFileSync("index.html", "utf8");
const siteName = (index.match(/<title>([^<]*)<\/title>/i) || [, "Photographs"])[1].trim();
const tags = {};
const tagFile = path.join(FOLDER, "tags.txt");
if (fs.existsSync(tagFile)) {
  fs.readFileSync(tagFile, "utf8").split(/\r?\n/).forEach(line => {
    const i = line.indexOf(":");
    if (i < 0 || line.trim().startsWith("#")) return;
    tags[line.slice(0, i).trim().toLowerCase()] =
      line.slice(i + 1).split(",").map(t => t.trim().toLowerCase()).filter(Boolean);
  });
}

// 3. Process photos
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : IMG.test(e.name) ? [p] : [];
});
const files = fs.existsSync(FOLDER) ? walk(FOLDER).sort() : [];

async function processOne(file) {
  const rel = path.relative(FOLDER, file).split(path.sep).join("/");
  const parts = rel.split("/"), name = parts.pop(), album = parts.join("/");
  const slug = slugify((album ? album + "-" : "") + name);
  const fit = n => ({ width: n, height: n, fit: "inside", withoutEnlargement: true });

  const thumb = await sharp(file).rotate().resize({ width: 382, withoutEnlargement: true })
    .webp({ quality: 72 }).toFile(path.join(OUT, "thumbs", slug + ".webp"));
  await sharp(file).rotate().resize(fit(2000)).webp({ quality: 82 }).toFile(path.join(OUT, "large", slug + ".webp"));
  // Link-preview card: always 1200x630 (the wide shape chat apps show large),
  // with the whole photo centered on a blurred, darkened copy of itself.
  const W = 1200, H = 630;
  const backdrop = await sharp(file).rotate().resize(W, H, { fit: "cover" })
    .blur(40).modulate({ brightness: 0.55 }).toBuffer();
  const front = await sharp(file).rotate().resize(W, H, { fit: "inside", withoutEnlargement: false }).toBuffer();
  const og = await sharp(backdrop).composite([{ input: front, gravity: "center" }])
    .jpeg({ quality: 84, mozjpeg: true }).toFile(path.join(OUT, "og", slug + ".jpg"));

  // Preview page for chat apps
  const ogImg = `${SITE}/og/${slug}.jpg`, page = `${SITE}/p/${slug}/`, gallery = `${SITE}/#${slug}`;
  const title = pretty(name);
  // No description on purpose: fewer text lines in the preview, so the photo dominates.
  // A favicon.png at the top level of the repo shows as a small icon beside your name.
  const icon = fs.existsSync("favicon.png") ? `<link rel="icon" href="${SITE}/favicon.png">\n` : "";
  fs.mkdirSync(path.join(OUT, "p", slug), { recursive: true });
  fs.writeFileSync(path.join(OUT, "p", slug, "index.html"), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | ${esc(siteName)}</title>
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(siteName)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:image" content="${esc(ogImg)}">
<meta property="og:image:width" content="${og.width}">
<meta property="og:image:height" content="${og.height}">
<meta property="og:image:alt" content="${esc(title)}">
${icon}
<meta property="og:url" content="${esc(page)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${esc(ogImg)}">
<link rel="canonical" href="${esc(page)}">
<meta http-equiv="refresh" content="0; url=${esc(gallery)}">
</head>
<body>
<script>location.replace(${JSON.stringify(gallery)});</script>
<a href="${esc(gallery)}"><img src="${esc(ogImg)}" alt="${esc(title)}" style="max-width:100%"></a>
</body>
</html>
`);

  return {
    slug, album,
    tags: tags[rel.toLowerCase()] || tags[name.toLowerCase()] || [],
    src: url(file), thumb: `thumbs/${slug}.webp`, large: `large/${slug}.webp`,
    w: thumb.width, h: thumb.height
  };
}

(async () => {
  const out = [];
  const queue = [...files];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const f = queue.shift();
      try { out.push(await processOne(f)); }
      catch (e) { console.warn(`Skipped ${f}: ${e.message}`); }
    }
  }));
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  fs.writeFileSync(path.join(OUT, "photos.json"), JSON.stringify(out));
  console.log(`Built ${out.length} photos for ${SITE}`);
})();
