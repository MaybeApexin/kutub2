import { fetchBookPage } from "../lib/scraper.ts";

try {
  const result = await fetchBookPage("https://shamela.ws/book/12876");
  console.log("Succeeded (unexpected):", result.title, result.page.paragraphs.length);
} catch (err) {
  console.log("Failed as expected:", err instanceof Error ? err.message : err);
}
