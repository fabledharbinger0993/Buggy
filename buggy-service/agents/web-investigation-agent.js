import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Launches a headless browser sub-agent that searches jmail.world for a
 * target term, paginates the results via scroll, and persists the harvested
 * rows to investigation_results.json for the coordinator agent to consume.
 *
 * @param {string} targetTerm - Search term to investigate.
 * @param {object} [options]
 * @param {string} [options.outputPath] - Override output JSON path.
 * @param {number} [options.maxScrollAttempts=10] - Pagination scroll cap.
 * @param {boolean} [options.headless=true] - Run browser headless.
 * @returns {Promise<object>} The persisted payload.
 */
export async function runWebInvestigationAgent(targetTerm, options = {}) {
  const {
    outputPath,
    maxScrollAttempts = 10,
    headless = true,
  } = options;

  console.log(`[Agent Status] Launching browser sub-agent for term: "${targetTerm}"...`);

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();
  let payload = null;

  try {
    // 1. Navigate to target
    await page.goto('https://jmail.world/', { waitUntil: 'networkidle' });
    console.log('[Agent Status] Target page loaded and hydrated.');

    // 2. Locate and interact with the search input
    const searchInput = page
      .locator('input[placeholder*="Search" i], input[type="search"], input[type="text"]')
      .first();

    await searchInput.waitFor({ state: 'visible', timeout: 5000 });
    await searchInput.click();
    await searchInput.fill(targetTerm);
    await page.keyboard.press('Enter');

    console.log(`[Agent Status] Search submitted for "${targetTerm}". Waiting for results network traffic...`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000); // Buffer for UI rendering

    // 3. Infinite scroll / pagination loop
    let previousHeight = 0;
    let currentHeight = await page.evaluate(() => document.body.scrollHeight);
    let scrollAttempts = 0;

    console.log('[Agent Status] Beginning dataset traversal via pagination scroll...');

    while (scrollAttempts < maxScrollAttempts) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500); // DOM append window

      previousHeight = currentHeight;
      currentHeight = await page.evaluate(() => document.body.scrollHeight);

      if (currentHeight === previousHeight) {
        break;
      }
      scrollAttempts++;
      console.log(`[Agent Status] Scrolled page batch ${scrollAttempts}.`);
    }

    // 4. Data extraction
    const emails = await page.evaluate(() => {
      const rows = document.querySelectorAll('div[role="row"], tr, .mail-row-selector');
      const data = [];

      if (rows.length === 0) {
        return [{ rawTextDump: document.body.innerText }];
      }

      rows.forEach((row) => {
        data.push({
          rowText: row.innerText,
          htmlContext: row.innerHTML,
        });
      });
      return data;
    });

    console.log(`[Agent Status] Successfully extracted ${emails.length} data points.`);

    // 5. Persist payload
    payload = {
      term: targetTerm,
      timestamp: new Date().toISOString(),
      resultsCount: emails.length,
      data: emails,
    };

    const resolvedOutput =
      outputPath ??
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'investigation_results.json');

    await writeFile(resolvedOutput, JSON.stringify(payload, null, 2));
    console.log(`[Agent Status] Data written to ${resolvedOutput}`);
  } catch (error) {
    console.error(`[Agent Error] Sub-agent execution failed: ${error.message}`);
    throw error;
  } finally {
    await browser.close();
    console.log('[Agent Status] Browser closed. Sub-agent handoff complete.');
  }

  return payload;
}

// CLI entry: `node agents/web-investigation-agent.js <term>`
const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const term = process.argv[2] ?? 'jerky';
  runWebInvestigationAgent(term).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
