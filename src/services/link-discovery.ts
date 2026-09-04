/**
 * Finds links on an institution's own homepage that likely lead to a
 * dedicated courses/subjects page ("Kurslar", "Yo'nalishlar", "Fanlar",
 * "Курсы", "Направления", "Courses", "Programs", ...).
 *
 * Real production gap: the user asked directly why the pipeline doesn't
 * open an institution's own site and read its pages the way a human would
 * — e.g. rgn.uz has a "Kurslar" nav link to rgn.uz/kurslar/, a page listing
 * every real course with its own name, features, and price. The
 * supplementary scrape (agents/researcher.ts) only ever visited URLs
 * already known in advance (the homepage itself, cited search-result
 * URLs) — it never looked AT the homepage's own markup for a link to a
 * page like this, so a course-listing page one click away was read only
 * when the primary web-search call happened to cite it directly, which is
 * not guaranteed.
 *
 * Follow-up: the user specifically asked that this look at the HEADER
 * navigation buttons a human would click, not just any link anywhere on
 * the page — a body paragraph mentioning "kurslar" in passing is not the
 * same signal as a top-nav menu item labeled "Kurslar". `findCoursePageLinks`
 * now scopes its keyword match to `<header>`/`<nav>` regions first (where a
 * real site's primary navigation actually lives), and only falls back to
 * scanning the whole page when no `<header>`/`<nav>` region matched —
 * keeping compatibility with sites that don't use those semantic tags at
 * all, while preferring the real navigation over an incidental in-content
 * mention when both exist.
 *
 * Deliberately generic (keyword-matches ANY site's nav) rather than
 * site-specific parsing like services/kursi24.ts, since — unlike
 * kursi24.ts, which can afford exact class-name matches because it
 * targets exactly ONE known site — this runs against an unknown
 * institution's arbitrarily-structured own website. Pure regex-based (no
 * HTML parser dependency, matching this codebase's existing style), so
 * it's fully unit-testable offline; a site whose markup doesn't match
 * simply yields no extra links, never an error.
 *
 * Known limit (documented honestly, not overclaimed): this is a
 * keyword-matching heuristic, not semantic understanding — a nav button
 * labeled with a term genuinely outside `COURSE_PAGE_KEYWORDS` (in a
 * language/phrasing this list doesn't anticipate), or a header rendered
 * only via client-side JavaScript (so it never appears in the fetched
 * HTML at all), won't be recognized. Actually judging an unfamiliar
 * button label's meaning is exactly what the LLM research call is better
 * suited for — see llm-client.ts::researchInstitutionViaWebSearch's
 * "check the site's own top navigation" instruction, which asks the model
 * to use judgment on ambiguous/unfamiliar labels rather than fixed
 * keywords. This function is the deterministic, no-LLM-call backstop for
 * the common, recognizable cases.
 */
const COURSE_PAGE_KEYWORDS = [
  "kurslar", "kurs", "yo'nalish", "yo‘nalish", "yonalish", "fanlar", "dasturlar",
  "courses", "course", "programs", "programmes",
  "курсы", "курс", "направлени", "программы",
];

function absolutize(href: string, baseUrl: string): string | null {
  try {
    const url = new URL(href, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Concatenates the contents of every `<header>`/`<nav>` region in `html`
 * (real sites often nest a `<nav>` inside a `<header>`, or use either
 * alone) — pure and exported so the header/nav scoping is independently
 * testable. Returns "" when neither tag appears anywhere in the page. */
export function extractHeaderNavHtml(html: string): string {
  const regions: string[] = [];
  for (const m of html.matchAll(/<header\b[^>]*>([\s\S]*?)<\/header>/gi)) regions.push(m[1]);
  for (const m of html.matchAll(/<nav\b[^>]*>([\s\S]*?)<\/nav>/gi)) regions.push(m[1]);
  return regions.join(" ");
}

function extractMatchingLinks(html: string, baseUrl: string): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1];
    if (!href || /^(#|javascript:|mailto:|tel:)/i.test(href.trim())) continue;
    const linkText = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    const hrefLower = href.toLowerCase();
    const isMatch = COURSE_PAGE_KEYWORDS.some((kw) => linkText.includes(kw) || hrefLower.includes(kw));
    if (!isMatch) continue;
    const abs = absolutize(href, baseUrl);
    if (abs) found.add(abs);
  }
  return [...found];
}

/**
 * Scans `html` (a page's raw markup, e.g. CachedPage.html) for `<a>` tags
 * whose link text or href path names a courses/subjects page, and returns
 * the deduped, absolute URLs they point to (resolved against `baseUrl`).
 * Prefers matches found inside `<header>`/`<nav>` regions — a real site's
 * actual top-navigation menu — over the whole page, falling back to a
 * whole-page scan only when no header/nav region yielded a match (either
 * because the site has no such match there, or doesn't use those tags at
 * all). Never throws on malformed markup — a regex miss just yields fewer
 * links.
 */
export function findCoursePageLinks(html: string, baseUrl: string): string[] {
  if (!html) return [];
  const headerNavHtml = extractHeaderNavHtml(html);
  if (headerNavHtml.trim().length > 0) {
    const headerNavMatches = extractMatchingLinks(headerNavHtml, baseUrl);
    if (headerNavMatches.length > 0) return headerNavMatches;
  }
  return extractMatchingLinks(html, baseUrl);
}
