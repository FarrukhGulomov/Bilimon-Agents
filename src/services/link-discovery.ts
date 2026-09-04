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
 * Deliberately generic (keyword-matches ANY site's nav) rather than
 * site-specific parsing like services/kursi24.ts, since — unlike
 * kursi24.ts, which can afford exact class-name matches because it
 * targets exactly ONE known site — this runs against an unknown
 * institution's arbitrarily-structured own website. Pure regex-based (no
 * HTML parser dependency, matching this codebase's existing style), so
 * it's fully unit-testable offline; a site whose markup doesn't match
 * simply yields no extra links, never an error.
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

/**
 * Scans `html` (a page's raw markup, e.g. CachedPage.html) for `<a>` tags
 * whose link text or href path names a courses/subjects page, and returns
 * the deduped, absolute URLs they point to (resolved against `baseUrl`).
 * Never throws on malformed markup — a regex miss just yields fewer links.
 */
export function findCoursePageLinks(html: string, baseUrl: string): string[] {
  if (!html) return [];
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
