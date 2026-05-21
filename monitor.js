const { chromium } = require('playwright');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// Configuration
const TARGET_POSTCODES = new Set([
  'BT1', 'BT2', 'BT3', 'BT4', 'BT5', 'BT6', 'BT7', 'BT8', 'BT9', 'BT10', 
  'BT11', 'BT12', 'BT13', 'BT14', 'BT15', 'BT16', 'BT17', 'BT18', 'BT36', 'BT37'
]);
const MAX_PRICE = 250000;
const HISTORY_FILE = path.join(__dirname, 'properties_history.json');
const INTEREST_RATES = [4.5, 5.0, 5.5];
const MORTGAGE_TERMS = [25, 30, 35];
const LTV = 0.90; // 90% Loan To Value

// Helper: Get today's date in YYYY-MM-DD
function getTodayDateString() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Helper: Parse numerical price from text (handles price drops, ranges, symbols)
function parsePriceText(priceText) {
  if (!priceText) return null;
  const cleanText = priceText.replace(/,/g, '');
  const matches = cleanText.match(/\d+/g);
  if (!matches || matches.length === 0) return null;
  // If multiple prices exist (e.g. £209,950£249,950), the first one is usually the active/lower price
  return parseInt(matches[0], 10);
}

// Helper: Check if a postcode is within Greater Belfast and < 30 min commute
function isPostcodeInCommuteRange(postcode) {
  if (!postcode) return false;
  const match = postcode.trim().toUpperCase().match(/^(BT\d+)/);
  if (!match) return false;
  return TARGET_POSTCODES.has(match[1]);
}

// Helper: Calculate monthly repayment for amortized mortgage
function calculateMonthlyRepayment(price, ltv, annualRate, years) {
  const principal = price * ltv;
  const r = (annualRate / 100) / 12;
  const n = years * 12;

  if (r === 0) return principal / n;
  const payment = principal * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
  return Math.round(payment * 100) / 100;
}

// Helper: Load history database
function loadHistory() {
  if (fs.existsSync(HISTORY_FILE)) {
    try {
      const data = fs.readFileSync(HISTORY_FILE, 'utf-8');
      return JSON.parse(data);
    } catch (err) {
      console.error('Error reading history file. Starting fresh.', err.message);
    }
  }
  return { listings: {} };
}

// Helper: Save history database
function saveHistory(history) {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
    console.log(`Saved ${Object.keys(history.listings).length} listings to properties_history.json`);
  } catch (err) {
    console.error('Error saving history file:', err.message);
  }
}

// Core Fetcher: Navigates using a clean, isolated browser context to bypass session tracking
async function fetchPage(browser, url, selector) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 }
  });
  const page = await context.newPage();
  
  let html = '';
  let success = false;
  let retries = 3;
  
  while (!success && retries > 0) {
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 20000 });
      if (selector) {
        await page.waitForSelector(selector, { state: 'attached', timeout: 10000 });
      }
      html = await page.content();
      success = true;
    } catch (err) {
      retries--;
      console.warn(`  Warning: Failed to fetch ${url}. Retries left: ${retries}. Error: ${err.message}`);
      if (retries > 0) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }
  
  await context.close();
  if (!success) {
    throw new Error(`Failed to load page: ${url} after 3 attempts`);
  }
  return html;
}

// Main Runner
async function run() {
  console.log(`=== BELFAST PROPERTY MONITOR - RUNNING AT ${new Date().toISOString()} ===`);
  const todayStr = getTodayDateString();
  const history = loadHistory();
  
  // Launch single headless browser, but we will spawn isolated contexts for requests
  const browser = await chromium.launch({ headless: true });
  const crawledListings = [];

  // Step 1: Crawl 7 pages of PropertyPal search results
  console.log('\n--- STEP 1: Crawling search results (7 pages) ---');
  for (let pNum = 1; pNum <= 7; pNum++) {
    const url = pNum === 1 
      ? 'https://www.propertypal.com/property-for-sale/belfast?max=250000&stygrp=6'
      : `https://www.propertypal.com/property-for-sale/belfast?max=250000&stygrp=6&page=${pNum}`;
    
    console.log(`Fetching search page ${pNum}: ${url}`);
    
    try {
      const html = await fetchPage(browser, url, 'li');
      const $ = cheerio.load(html);
      let pageCount = 0;
      
      $('li').each((i, el) => {
        const item = $(el);
        const a = item.find('a');
        if (a.length === 0) return;

        const href = a.attr('href') || '';
        if (!href || href.startsWith('/search') || href.startsWith('/user') || href.startsWith('/favourites')) return;

        const addressEl = item.find('h2, [class*="address"]');
        const addressText = addressEl.text().trim();

        const priceEl = item.find('strong, [class*="price"]');
        const priceText = priceEl.text().trim();

        if (addressText && priceText) {
          const parsedPrice = parsePriceText(priceText);
          if (parsedPrice && parsedPrice <= MAX_PRICE) {
            const fullUrl = href.startsWith('http') ? href : 'https://www.propertypal.com' + href;
            crawledListings.push({
              href: fullUrl,
              rawPriceText: priceText,
              price: parsedPrice,
              address: addressText
            });
            pageCount++;
          }
        }
      });
      console.log(`  Found ${pageCount} valid listings on page ${pNum}`);
    } catch (err) {
      console.error(`  Error crawling search page ${pNum}:`, err.message);
    }
    
    // Polite scraping delay between search page requests
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`\nCrawling finished. Found ${crawledListings.length} total raw candidates under £250,000.`);

  // Step 2: Fetch detailed records for uncached, outdated or partially resolved listings
  console.log('\n--- STEP 2: Hydrating listings with detailed specifications ---');
  let detailScrapeCount = 0;
  
  for (let i = 0; i < crawledListings.length; i++) {
    const listing = crawledListings[i];
    const key = listing.href;
    const cached = history.listings[key];

    // Decide whether to scrape details (we also scrape if tenure is currently Unknown or if coordinates are missing)
    const needsDetailScrape = !cached || 
      cached.numBathrooms === undefined || 
      cached.tenure === undefined || 
      cached.tenure === 'Unknown' || 
      !cached.postcode || 
      cached.agency === 'Unknown' ||
      cached.latitude === undefined ||
      cached.longitude === undefined;

    if (needsDetailScrape) {
      console.log(`[${i + 1}/${crawledListings.length}] Hydrating: ${listing.address} (${listing.href})`);
      detailScrapeCount++;
      
      try {
        const html = await fetchPage(browser, listing.href, 'script#__NEXT_DATA__');
        
        // Find NextJS hydration data payload containing clean JSON
        const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
        if (match) {
          const data = JSON.parse(match[1]);
          const prop = data.props?.pageProps?.property || data.props?.pageProps?.model?.property || data.props?.pageProps?.model;
          
          if (prop) {
            const tenureText = prop.keyInfo?.find(k => k.key === 'TENURE')?.text || 'Unknown';
            const styleText = prop.keyInfo?.find(k => k.key === 'STYLE')?.text || prop.style?.text || 'Terraced House';
            const bathrooms = parseInt(prop.numBathrooms, 10) || 1;
            const bedrooms = parseInt(prop.numBedrooms, 10) || 0;
            const agency = prop.account?.organisation || prop.agents?.[0]?.name || 'Unknown';
            const postcode = prop.postcode || '';
            const displayAddress = prop.displayAddress || listing.address;
            const latitude = prop.coordinate?.latitude || null;
            const longitude = prop.coordinate?.longitude || null;

            // Save to database
            history.listings[key] = {
              href: listing.href,
              address: displayAddress,
              price: prop.price?.price || listing.price,
              postcode: postcode,
              numBedrooms: bedrooms,
              numBathrooms: bathrooms,
              tenure: tenureText,
              style: styleText,
              agency: agency,
              latitude: latitude,
              longitude: longitude,
              firstSeen: cached?.firstSeen || todayStr,
              lastSeen: todayStr
            };
            console.log(`  -> Beds: ${bedrooms}, Baths: ${bathrooms}, Tenure: ${tenureText}, Agency: ${agency}, Postcode: ${postcode}, Lat: ${latitude}, Lng: ${longitude}`);
          } else {
            console.log(`  -> Property details not found in __NEXT_DATA__. Using basic search details.`);
            history.listings[key] = {
              ...listing,
              firstSeen: cached?.firstSeen || todayStr,
              lastSeen: todayStr,
              postcode: '',
              numBathrooms: 1,
              numBedrooms: 0,
              tenure: 'Unknown',
              style: 'Terraced House',
              agency: 'Unknown',
              latitude: null,
              longitude: null
            };
          }
        } else {
          console.log(`  -> __NEXT_DATA__ payload missing on details page.`);
          history.listings[key] = {
            ...listing,
            firstSeen: cached?.firstSeen || todayStr,
            lastSeen: todayStr,
            postcode: '',
            numBathrooms: 1,
            numBedrooms: 0,
            tenure: 'Unknown',
            style: 'Terraced House',
            agency: 'Unknown',
            latitude: null,
            longitude: null
          };
        }
      } catch (err) {
        console.error(`  -> Detail scraping failed:`, err.message);
        // Retain cached version or keep basic card details as fallback
        if (!cached) {
          history.listings[key] = {
            ...listing,
            firstSeen: todayStr,
            lastSeen: todayStr,
            postcode: '',
            numBathrooms: 1,
            numBedrooms: 0,
            tenure: 'Unknown',
            style: 'Terraced House',
            agency: 'Unknown',
            latitude: null,
            longitude: null
          };
        } else {
          cached.lastSeen = todayStr;
          history.listings[key] = cached;
        }
      }
      
      // 1 second polite delay between detail page crawls
      await new Promise(r => setTimeout(r, 1000));
    } else {
      // Already cached and fully resolved! Just update lastSeen date and price
      cached.lastSeen = todayStr;
      if (listing.price && listing.price !== cached.price) {
        console.log(`Price change detected for ${listing.address}: £${cached.price.toLocaleString()} -> £${listing.price.toLocaleString()}`);
        cached.price = listing.price;
      }
      history.listings[key] = cached;
    }
  }

  console.log(`\nHydration complete. Performed ${detailScrapeCount} detail crawls.`);
  
  // Save updated history
  saveHistory(history);
  await browser.close();

  // Step 3: Filter, Categorize and Calculate Mortgages
  console.log('\n--- STEP 3: Filtering & Financial Modeling ---');
  
  const allPropertiesList = [];
  const highPriorityList = [];
  const standardList = [];

  Object.values(history.listings).forEach(item => {
    // Only keep active listings (seen today)
    if (item.lastSeen !== todayStr) return;

    // Filters:
    // 1. Price Cap <= 250k
    if (item.price > MAX_PRICE) return;

    // 2. Commute Limit (BT1–BT17, BT18, BT36, BT37)
    let postcode = item.postcode;
    if (!postcode) {
      const match = item.address.match(/(BT\d+\s+\d*[A-Z]{2})/i);
      postcode = match ? match[1].toUpperCase() : '';
    }

    if (!isPostcodeInCommuteRange(postcode)) {
      return; // Skip properties outside commute limit or missing postcode
    }

    // 3. Highlight/Tag day-over-day additions
    const isNew = item.firstSeen === todayStr;

    // 4. Calculate Mortgages
    const repayments = {};
    INTEREST_RATES.forEach(rate => {
      const rateKey = rate.toFixed(1);
      repayments[rateKey] = {};
      MORTGAGE_TERMS.forEach(years => {
        repayments[rateKey][years] = calculateMonthlyRepayment(item.price, LTV, rate, years);
      });
    });

    const parsedItem = {
      ...item,
      postcode: postcode || 'Belfast',
      isNew: isNew,
      repayments: repayments
    };

    allPropertiesList.push(parsedItem);

    // 5. Prioritize Freehold Terraced houses with >= 2 bathrooms
    const isTerraced = item.style.toLowerCase().includes('terrace') || item.style.toLowerCase().includes('townhouse');
    const isFreehold = item.tenure.toLowerCase().includes('freehold');
    const has2Baths = item.numBathrooms >= 2;

    if (isTerraced && isFreehold && has2Baths) {
      highPriorityList.push(parsedItem);
    } else {
      standardList.push(parsedItem);
    }
  });

  // Sort properties: New listings first, then by priority, then ascending price
  const sortFunc = (a, b) => {
    if (a.isNew && !b.isNew) return -1;
    if (!a.isNew && b.isNew) return 1;
    return a.price - b.price;
  };

  highPriorityList.sort(sortFunc);
  standardList.sort(sortFunc);
  
  // Master sort order for primary display
  allPropertiesList.sort((a, b) => {
    // High priority first
    const aPriority = (a.style.toLowerCase().includes('terrace') && a.tenure.toLowerCase().includes('freehold') && a.numBathrooms >= 2) ? 1 : 0;
    const bPriority = (b.style.toLowerCase().includes('terrace') && b.tenure.toLowerCase().includes('freehold') && b.numBathrooms >= 2) ? 1 : 0;
    if (aPriority !== bPriority) return bPriority - aPriority;
    // New listings next
    if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
    // Lower price next
    return a.price - b.price;
  });

  console.log(`\nFiltered Properties Count: ${allPropertiesList.length}`);
  console.log(`- High Priority Candidates (Freehold + 2+ Baths): ${highPriorityList.length}`);
  console.log(`- Standard Terraced Candidates: ${standardList.length}`);

  // Step 4: Write Outputs (daily_report.md and index.html)
  console.log('\n--- STEP 4: Generating daily_report.md and index.html ---');
  generateDailyReportMarkdown(allPropertiesList, highPriorityList, todayStr);
  generateindexHtml(allPropertiesList, todayStr);
  
  console.log('\n=== MONITOR PIPELINE EXECUTED SUCCESSFULLY ===');
}

// Sub-generator: daily_report.md
function generateDailyReportMarkdown(allProperties, highPriority, todayStr) {
  const filePath = path.join(__dirname, 'daily_report.md');
  let md = `# Belfast Property Market Report - ${todayStr}\n\n`;
  md += `Daily property report for residential terraced houses under **£250,000** in Greater Belfast. Includes 90% LTV monthly mortgage repayments for **25, 30, and 35 years** across **4.5%, 5.0%, and 5.5%** interest rates.\n\n`;
  
  // Market Summary
  const avgPrice = allProperties.reduce((sum, item) => sum + item.price, 0) / (allProperties.length || 1);
  const newAdditionsCount = allProperties.filter(p => p.isNew).length;

  md += `## 📊 Today's Market Metrics\n\n`;
  md += `| Metric | Value |\n`;
  md += `| :--- | :--- |\n`;
  md += `| **Total Matching Properties** | **${allProperties.length}** |\n`;
  md += `| **High Priority Candidates (Freehold + 2+ Baths)** | **${highPriority.length}** |\n`;
  md += `| **New Additions Today** | **${newAdditionsCount}** |\n`;
  md += `| **Average Asking Price** | **£${Math.round(avgPrice).toLocaleString()}** |\n\n`;

  // Section 1: High Priority Listings
  md += `## 🔥 High Priority Listings (Freehold & 2+ Bathrooms)\n\n`;
  if (highPriority.length === 0) {
    md += `*No freehold terraced houses with at least 2 bathrooms found today. Check standard listings below.*\n\n`;
  } else {
    highPriority.forEach((p, idx) => {
      const isNewText = p.isNew ? ` 🟢 **[NEW ADDITION]**` : '';
      const firstSeenDate = new Date(p.firstSeen);
      const todayDate = new Date(todayStr);
      firstSeenDate.setHours(0, 0, 0, 0);
      todayDate.setHours(0, 0, 0, 0);
      const diffTime = todayDate - firstSeenDate;
      const days = Math.round(diffTime / (1000 * 60 * 60 * 24));
      const daysText = days === 0 ? 'New today' : (days === 1 ? '1 day ago' : `${days} days ago`);

      md += `### ${idx + 1}. ${p.address}${isNewText}\n`;
      md += `- **Asking Price:** £${p.price.toLocaleString()}\n`;
      md += `- **Agency:** ${p.agency}\n`;
      md += `- **Specs:** ${p.numBedrooms} Bed | ${p.numBathrooms} Bath | ${p.style} | Tenure: **${p.tenure}**\n`;
      md += `- **Listed Date:** ${p.firstSeen} (${daysText})\n`;
      md += `- **Links:** [View on PropertyPal](${p.href}) | [View on Google Maps](https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.address)})\n\n`;
      md += `#### Monthly Repayment Comparison (90% LTV = £${(p.price * 0.9).toLocaleString()}):`;
      md += `\n\n`;
      md += `| Interest Rate | 25 Years | 30 Years | 35 Years |\n`;
      md += `| :--- | :--- | :--- | :--- |\n`;
      md += `| **4.5%** | £${p.repayments['4.5'][25].toLocaleString()} | £${p.repayments['4.5'][30].toLocaleString()} | £${p.repayments['4.5'][35].toLocaleString()} |\n`;
      md += `| **5.0%** | £${p.repayments['5.0'][25].toLocaleString()} | £${p.repayments['5.0'][30].toLocaleString()} | £${p.repayments['5.0'][35].toLocaleString()} |\n`;
      md += `| **5.5%** | £${p.repayments['5.5'][25].toLocaleString()} | £${p.repayments['5.5'][30].toLocaleString()} | £${p.repayments['5.5'][35].toLocaleString()} |\n\n`;
      md += `---\n\n`;
    });
  }

  // Section 2: All Other Matching Listings
  md += `## 🏠 Standard Matching Listings\n\n`;
  const standardProperties = allProperties.filter(p => !highPriority.some(hp => hp.href === p.href));
  if (standardProperties.length === 0) {
    md += `*No other matching listings found.*\n\n`;
  } else {
    standardProperties.forEach((p, idx) => {
      const isNewText = p.isNew ? ` 🟢 **[NEW ADDITION]**` : '';
      const firstSeenDate = new Date(p.firstSeen);
      const todayDate = new Date(todayStr);
      firstSeenDate.setHours(0, 0, 0, 0);
      todayDate.setHours(0, 0, 0, 0);
      const diffTime = todayDate - firstSeenDate;
      const days = Math.round(diffTime / (1000 * 60 * 60 * 24));
      const daysText = days === 0 ? 'New today' : (days === 1 ? '1 day ago' : `${days} days ago`);

      md += `### ${idx + 1}. ${p.address}${isNewText}\n`;
      md += `- **Asking Price:** £${p.price.toLocaleString()}\n`;
      md += `- **Agency:** ${p.agency}\n`;
      md += `- **Specs:** ${p.numBedrooms} Bed | ${p.numBathrooms} Bath | ${p.style} | Tenure: ${p.tenure}\n`;
      md += `- **Listed Date:** ${p.firstSeen} (${daysText})\n`;
      md += `- **Links:** [View on PropertyPal](${p.href}) | [View on Google Maps](https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.address)})\n\n`;
      md += `#### Monthly Repayment Comparison (90% LTV = £${(p.price * 0.9).toLocaleString()}):\n\n`;
      md += `| Interest Rate | 25 Years | 30 Years | 35 Years |\n`;
      md += `| :--- | :--- | :--- | :--- |\n`;
      md += `| **4.5%** | £${p.repayments['4.5'][25].toLocaleString()} | £${p.repayments['4.5'][30].toLocaleString()} | £${p.repayments['4.5'][35].toLocaleString()} |\n`;
      md += `| **5.0%** | £${p.repayments['5.0'][25].toLocaleString()} | £${p.repayments['5.0'][30].toLocaleString()} | £${p.repayments['5.0'][35].toLocaleString()} |\n`;
      md += `| **5.5%** | £${p.repayments['5.5'][25].toLocaleString()} | £${p.repayments['5.5'][30].toLocaleString()} | £${p.repayments['5.5'][35].toLocaleString()} |\n\n`;
      md += `---\n\n`;
    });
  }

  fs.writeFileSync(filePath, md, 'utf-8');
  console.log(`Generated ${filePath}`);
}

// Sub-generator: index.html
function generateindexHtml(allProperties, todayStr) {
  const filePath = path.join(__dirname, 'index.html');
  const avgPrice = allProperties.reduce((sum, item) => sum + item.price, 0) / (allProperties.length || 1);
  const newCount = allProperties.filter(p => p.isNew).length;
  const highPriorityCount = allProperties.filter(p => p.style.toLowerCase().includes('terrace') && p.tenure.toLowerCase().includes('freehold') && p.numBathrooms >= 2).length;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Belfast Property Market index</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Outfit:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  
  <!-- Leaflet Map Assets -->
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>

  <style>
    :root {
      --bg-primary: hsl(222, 47%, 6%);
      --bg-secondary: hsl(222, 47%, 10%);
      --bg-card: rgba(18, 26, 42, 0.65);
      --border-glow: rgba(56, 189, 248, 0.1);
      --border-glass: rgba(255, 255, 255, 0.06);
      --accent-cyan: hsl(190, 100%, 45%);
      --accent-indigo: hsl(240, 100%, 70%);
      --accent-rose: hsl(340, 100%, 65%);
      --accent-gradient: linear-gradient(135deg, var(--accent-cyan), var(--accent-indigo));
      --text-primary: hsl(210, 40%, 98%);
      --text-secondary: hsl(215, 20%, 75%);
      --text-muted: hsl(215, 12%, 55%);
      --success-glow: rgba(34, 197, 94, 0.15);
      --success-text: hsl(142, 70%, 45%);
      --shadow-premium: 0 10px 30px -10px rgba(0, 0, 0, 0.7);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: 'Inter', sans-serif;
      background-color: var(--bg-primary);
      color: var(--text-primary);
      line-height: 1.6;
      padding: 2rem 1.5rem;
      background-image: 
        radial-gradient(at 10% 20%, rgba(56, 189, 248, 0.05) 0px, transparent 50%),
        radial-gradient(at 90% 80%, rgba(99, 102, 241, 0.05) 0px, transparent 50%);
      min-height: 100vh;
    }

    .container {
      max-width: 1300px;
      margin: 0 auto;
    }

    /* Header */
    header {
      margin-bottom: 2.5rem;
      position: relative;
      padding-bottom: 1.5rem;
      border-bottom: 1px solid var(--border-glass);
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      flex-wrap: wrap;
      gap: 1.5rem;
    }

    .header-titles h1 {
      font-family: 'Outfit', sans-serif;
      font-size: 2.8rem;
      font-weight: 800;
      background: linear-gradient(to right, #fff, var(--text-secondary));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 0.2rem;
      letter-spacing: -0.03em;
    }

    .header-titles p {
      color: var(--text-secondary);
      font-size: 1.1rem;
      font-weight: 300;
    }

    .header-meta {
      text-align: right;
    }

    .header-date {
      font-family: 'Outfit', sans-serif;
      font-size: 1.2rem;
      font-weight: 600;
      color: var(--accent-cyan);
    }

    .header-subtitle {
      font-size: 0.9rem;
      color: var(--text-muted);
    }

    /* Stats Section */
    .stats-container {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 1.5rem;
      margin-bottom: 3rem;
    }

    .stat-card {
      background: var(--bg-card);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--border-glass);
      border-radius: 16px;
      padding: 1.5rem;
      box-shadow: var(--shadow-premium);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      position: relative;
      overflow: hidden;
    }

    .stat-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 4px;
      height: 100%;
      background: var(--accent-gradient);
      opacity: 0.7;
    }

    .stat-card:hover {
      transform: translateY(-4px);
      border-color: rgba(56, 189, 248, 0.3);
      box-shadow: 0 15px 35px -10px rgba(56, 189, 248, 0.15);
    }

    .stat-card.rose::before {
      background: var(--accent-rose);
    }

    .stat-card.cyan::before {
      background: var(--accent-cyan);
    }

    .stat-card-title {
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin-bottom: 0.5rem;
      font-weight: 600;
    }

    .stat-card-value {
      font-family: 'Outfit', sans-serif;
      font-size: 2.2rem;
      font-weight: 700;
      letter-spacing: -0.02em;
    }

    /* Controls Bar */
    .controls-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: rgba(13, 19, 33, 0.8);
      border: 1px solid var(--border-glass);
      padding: 1rem 1.5rem;
      border-radius: 14px;
      margin-bottom: 2.5rem;
      flex-wrap: wrap;
      gap: 1.2rem;
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
    }

    .search-box {
      position: relative;
      display: flex;
      align-items: center;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border-glass);
      border-radius: 10px;
      padding: 0.25rem 0.75rem;
      width: 280px;
      transition: all 0.3s ease;
    }

    .search-box:focus-within {
      border-color: rgba(56, 189, 248, 0.4);
      box-shadow: 0 0 15px rgba(56, 189, 248, 0.15);
      background: rgba(255, 255, 255, 0.08);
    }

    .search-icon {
      color: var(--text-muted);
      margin-right: 0.5rem;
      flex-shrink: 0;
    }

    .search-box input {
      background: transparent;
      border: none;
      color: var(--text-primary);
      font-family: 'Inter', sans-serif;
      font-size: 0.9rem;
      width: 100%;
      outline: none;
      padding: 0.4rem 0;
    }

    .search-box input::placeholder {
      color: var(--text-muted);
    }

    .filter-tabs {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
    }

    .tab-btn {
      background: transparent;
      border: none;
      color: var(--text-secondary);
      padding: 0.6rem 1.2rem;
      font-size: 0.9rem;
      font-weight: 500;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .tab-btn:hover {
      color: var(--text-primary);
      background: rgba(255, 255, 255, 0.04);
    }

    .tab-btn.active {
      color: var(--text-primary);
      background: var(--accent-gradient);
      box-shadow: 0 4px 15px -4px rgba(56, 189, 248, 0.4);
    }

    .rate-selector {
      display: flex;
      align-items: center;
      gap: 0.8rem;
    }

    .rate-label {
      font-size: 0.85rem;
      color: var(--text-muted);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }

    .rate-btn-group {
      display: flex;
      background: rgba(255, 255, 255, 0.04);
      padding: 0.25rem;
      border-radius: 10px;
      border: 1px solid var(--border-glass);
    }

    .rate-btn {
      background: transparent;
      border: none;
      color: var(--text-secondary);
      padding: 0.4rem 1rem;
      font-size: 0.9rem;
      font-weight: 600;
      border-radius: 7px;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .rate-btn:hover {
      color: var(--text-primary);
    }

    .rate-btn.active {
      background: var(--bg-primary);
      color: var(--accent-cyan);
      box-shadow: inset 0 0 10px rgba(0, 0, 0, 0.5);
      border: 1px solid rgba(56, 189, 248, 0.2);
    }

    /* View Selector */
    .view-selector {
      display: flex;
      background: rgba(255, 255, 255, 0.04);
      padding: 0.25rem;
      border-radius: 10px;
      border: 1px solid var(--border-glass);
    }

    .view-btn {
      background: transparent;
      border: none;
      color: var(--text-secondary);
      padding: 0.4rem 1rem;
      font-size: 0.9rem;
      font-weight: 600;
      border-radius: 7px;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .view-btn:hover {
      color: var(--text-primary);
    }

    .view-btn.active {
      background: var(--bg-primary);
      color: var(--accent-cyan);
      box-shadow: inset 0 0 10px rgba(0, 0, 0, 0.5);
      border: 1px solid rgba(56, 189, 248, 0.2);
    }

    /* Dynamic Mortgage Modeler Panel */
    .modeler-panel {
      background: var(--bg-card);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--border-glass);
      border-radius: 20px;
      padding: 1.8rem;
      box-shadow: var(--shadow-premium);
      margin-bottom: 2rem;
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
    }

    .modeler-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 1rem;
    }

    .modeler-header h2 {
      font-family: 'Outfit', sans-serif;
      font-size: 1.4rem;
      font-weight: 700;
      color: var(--text-primary);
    }

    .mode-selector {
      display: flex;
      background: rgba(255, 255, 255, 0.04);
      padding: 0.25rem;
      border-radius: 10px;
      border: 1px solid var(--border-glass);
    }

    .mode-btn {
      background: transparent;
      border: none;
      color: var(--text-secondary);
      padding: 0.4rem 1rem;
      font-size: 0.85rem;
      font-weight: 600;
      border-radius: 7px;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .mode-btn:hover {
      color: var(--text-primary);
    }

    .mode-btn.active {
      background: var(--bg-primary);
      color: var(--accent-cyan);
      box-shadow: inset 0 0 10px rgba(0, 0, 0, 0.5);
      border: 1px solid rgba(56, 189, 248, 0.2);
    }

    .modeler-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 1.5rem;
    }

    .modeler-control {
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border-glass);
      padding: 1.2rem;
      border-radius: 14px;
      transition: all 0.3s ease;
    }

    .modeler-control:hover {
      border-color: rgba(56, 189, 248, 0.2);
    }

    .control-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .control-label {
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }

    .control-value {
      font-family: 'Outfit', sans-serif;
      font-size: 1.15rem;
      font-weight: 700;
      color: var(--accent-cyan);
    }

    /* Custom range sliders styling */
    .custom-slider {
      -webkit-appearance: none;
      width: 100%;
      height: 6px;
      border-radius: 3px;
      background: rgba(255, 255, 255, 0.08);
      outline: none;
      transition: background 0.3s;
      margin: 0.4rem 0;
    }

    .custom-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: var(--accent-cyan);
      box-shadow: 0 0 10px var(--accent-cyan);
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .custom-slider::-webkit-slider-thumb:hover {
      transform: scale(1.2);
      background: #fff;
      box-shadow: 0 0 15px #fff;
    }

    .custom-slider::-moz-range-thumb {
      width: 16px;
      height: 16px;
      border: none;
      border-radius: 50%;
      background: var(--accent-cyan);
      box-shadow: 0 0 10px var(--accent-cyan);
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .custom-slider::-moz-range-thumb:hover {
      transform: scale(1.2);
      background: #fff;
      box-shadow: 0 0 15px #fff;
    }

    /* Collapsible Specific Calculator */
    .customize-toggle-btn {
      margin-top: 0.8rem;
      display: flex;
      justify-content: center;
      align-items: center;
      width: 100%;
      background: transparent;
      border: 1px dashed var(--border-glass);
      color: var(--text-secondary);
      padding: 0.6rem;
      font-size: 0.8rem;
      font-weight: 600;
      border-radius: 10px;
      cursor: pointer;
      transition: all 0.2s ease;
      gap: 0.4rem;
    }

    .customize-toggle-btn:hover {
      border-color: rgba(56, 189, 248, 0.3);
      color: var(--accent-cyan);
      background: rgba(56, 189, 248, 0.03);
    }

    .card-calculator {
      display: none;
      margin-top: 1rem;
      background: rgba(13, 19, 33, 0.7);
      border: 1px solid var(--border-glass);
      border-radius: 12px;
      padding: 1.2rem;
      flex-direction: column;
      gap: 1rem;
      animation: slideDown 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    @keyframes slideDown {
      from {
        opacity: 0;
        transform: translateY(-8px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .calc-row {
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
      text-align: left;
    }

    .calc-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--text-muted);
    }

    .calc-val {
      font-family: 'Outfit', sans-serif;
      font-size: 0.85rem;
      font-weight: 700;
      color: var(--text-primary);
    }

    .calc-input-box {
      display: flex;
      align-items: center;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border-glass);
      border-radius: 6px;
      padding: 0.2rem 0.5rem;
      width: 100px;
      text-align: right;
    }

    .calc-input-box span {
      color: var(--text-muted);
      font-size: 0.8rem;
      margin-right: 0.2rem;
    }

    .calc-input-box input {
      background: transparent;
      border: none;
      color: var(--text-primary);
      width: 100%;
      text-align: right;
      font-family: 'Outfit', sans-serif;
      font-weight: bold;
      font-size: 0.85rem;
      outline: none;
    }

    /* Affordability warnings */
    .affordability-warning {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.25);
      color: hsl(0, 85%, 65%);
      font-size: 0.75rem;
      font-weight: 600;
      padding: 0.5rem 0.8rem;
      border-radius: 8px;
      margin-top: 0.5rem;
      display: flex;
      align-items: center;
      gap: 0.4rem;
      text-align: left;
    }

    /* Map View Styling */
    #map-container {
      width: 100%;
      height: 600px;
      border-radius: 20px;
      border: 1px solid var(--border-glass);
      background: var(--bg-card);
      box-shadow: var(--shadow-premium);
      overflow: hidden;
      margin-bottom: 2.5rem;
      display: none;
      position: relative;
      z-index: 1;
    }

    /* Glowing Custom Pins */
    .custom-marker {
      display: flex;
      justify-content: center;
      align-items: center;
      width: 24px !important;
      height: 24px !important;
    }

    .marker-pin {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      border: 2px solid #fff;
      box-shadow: 0 0 10px rgba(255, 255, 255, 0.5);
      transition: all 0.2s ease;
      position: relative;
    }

    .marker-pin::after {
      content: '';
      position: absolute;
      top: -4px;
      left: -4px;
      right: -4px;
      bottom: -4px;
      border-radius: 50%;
      border: 1px solid inherit;
      animation: pulse-ring 1.5s infinite;
      opacity: 0.8;
      pointer-events: none;
    }

    @keyframes pulse-ring {
      0% {
        transform: scale(0.8);
        opacity: 0.8;
      }
      100% {
        transform: scale(2.2);
        opacity: 0;
      }
    }

    .pin-standard {
      background-color: var(--accent-cyan);
      border-color: var(--accent-cyan);
      box-shadow: 0 0 12px var(--accent-cyan);
    }
    .pin-standard::after {
      border-color: var(--accent-cyan);
    }

    .pin-priority {
      background-color: var(--accent-rose);
      border-color: var(--accent-rose);
      box-shadow: 0 0 12px var(--accent-rose);
    }
    .pin-priority::after {
      border-color: var(--accent-rose);
    }

    .pin-new {
      background-color: var(--success-text);
      border-color: var(--success-text);
      box-shadow: 0 0 12px var(--success-text);
    }
    .pin-new::after {
      border-color: var(--success-text);
    }

    /* Leaflet Dark Theme modifications */
    .leaflet-container {
      background-color: var(--bg-secondary) !important;
      font-family: 'Inter', sans-serif !important;
    }

    .leaflet-bar {
      border: 1px solid var(--border-glass) !important;
      box-shadow: var(--shadow-premium) !important;
      border-radius: 8px !important;
      overflow: hidden;
    }

    .leaflet-bar a {
      background-color: var(--bg-card) !important;
      color: var(--text-primary) !important;
      border-bottom: 1px solid var(--border-glass) !important;
      transition: all 0.2s ease;
    }

    .leaflet-bar a:hover {
      background-color: rgba(255, 255, 255, 0.08) !important;
      color: var(--accent-cyan) !important;
    }

    .leaflet-popup-content-wrapper {
      background: var(--bg-card) !important;
      backdrop-filter: blur(16px) !important;
      -webkit-backdrop-filter: blur(16px) !important;
      border: 1px solid var(--border-glass) !important;
      border-radius: 16px !important;
      color: var(--text-primary) !important;
      box-shadow: var(--shadow-premium) !important;
      padding: 0.5rem !important;
      max-width: 320px;
    }

    .leaflet-popup-tip {
      background: var(--bg-card) !important;
      border-left: 1px solid var(--border-glass) !important;
      border-bottom: 1px solid var(--border-glass) !important;
    }

    .leaflet-popup-close-button {
      color: var(--text-muted) !important;
      top: 10px !important;
      right: 10px !important;
      font-size: 16px !important;
      transition: color 0.2s ease;
    }

    .leaflet-popup-close-button:hover {
      color: var(--accent-rose) !important;
    }

    .popup-card {
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
    }

    .popup-header {
      display: flex;
      flex-direction: column;
      margin-bottom: 0.2rem;
    }

    .popup-price {
      font-family: 'Outfit', sans-serif;
      font-size: 1.5rem;
      font-weight: 800;
      color: var(--text-primary);
      line-height: 1.2;
    }

    .popup-address {
      font-family: 'Outfit', sans-serif;
      font-size: 0.95rem;
      font-weight: 600;
      color: var(--text-secondary);
      margin-top: 0.15rem;
    }

    .popup-specs {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
      margin: 0.2rem 0;
    }

    .popup-spec-pill {
      font-size: 0.65rem;
      padding: 0.25rem 0.5rem;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border-glass);
      color: var(--text-secondary);
    }

    .popup-spec-pill.highlight {
      background: rgba(56, 189, 248, 0.05);
      border-color: rgba(56, 189, 248, 0.15);
      color: var(--accent-cyan);
    }

    .popup-spec-pill.priority-pill {
      background: rgba(244, 63, 94, 0.15);
      border-color: rgba(244, 63, 94, 0.3);
      color: var(--accent-rose);
      font-weight: bold;
    }

    .popup-meta {
      font-size: 0.75rem;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 0.3rem;
    }

    .popup-mortgage {
      background: rgba(13, 19, 33, 0.6);
      border: 1px solid var(--border-glass);
      border-radius: 8px;
      padding: 0.5rem 0.8rem;
      margin-top: 0.2rem;
    }

    .popup-mortgage-title {
      font-size: 0.65rem;
      text-transform: uppercase;
      font-weight: 700;
      color: var(--text-muted);
      margin-bottom: 0.3rem;
      letter-spacing: 0.05em;
      display: flex;
      justify-content: space-between;
    }

    .popup-repayment-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 0.4rem;
      text-align: center;
    }

    .popup-repayment-item {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border-glass);
      border-radius: 5px;
      padding: 0.25rem;
    }

    .popup-repayment-term {
      font-size: 0.6rem;
      color: var(--text-muted);
    }

    .popup-repayment-val {
      font-family: 'Outfit', sans-serif;
      font-size: 0.8rem;
      font-weight: 700;
      color: var(--accent-cyan);
    }

    .popup-btn {
      display: flex;
      justify-content: center;
      align-items: center;
      width: 100%;
      background: var(--accent-gradient);
      color: var(--text-primary);
      padding: 0.5rem;
      font-size: 0.8rem;
      font-weight: 600;
      border-radius: 8px;
      cursor: pointer;
      text-decoration: none;
      transition: all 0.2s ease;
      gap: 0.3rem;
      text-align: center;
      border: none;
      box-shadow: 0 4px 10px rgba(56, 189, 248, 0.25);
    }

    .popup-btn:hover {
      opacity: 0.95;
      box-shadow: 0 4px 15px rgba(56, 189, 248, 0.4);
    }

    .popup-links-row {
      display: flex;
      gap: 0.4rem;
      margin-top: 0.2rem;
    }

    .popup-map-link {
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 0.5rem;
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--accent-cyan);
      text-decoration: none;
      background: rgba(56, 189, 248, 0.05);
      border: 1px solid rgba(56, 189, 248, 0.15);
      border-radius: 8px;
      transition: all 0.2s ease;
      text-align: center;
      flex-grow: 1;
    }

    .popup-map-link:hover {
      background: rgba(56, 189, 248, 0.15);
      border-color: var(--accent-cyan);
    }

    /* Properties Grid */
    .properties-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
      gap: 2rem;
    }

    /* Property Card */
    .property-card {
      background: var(--bg-card);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--border-glass);
      border-radius: 20px;
      padding: 1.8rem;
      box-shadow: var(--shadow-premium);
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      position: relative;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      overflow: hidden;
    }

    .property-card::after {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: 20px;
      border: 2px solid transparent;
      transition: all 0.3s ease;
      pointer-events: none;
    }

    .property-card:hover {
      transform: translateY(-6px);
      box-shadow: 0 20px 40px -15px rgba(0, 0, 0, 0.8), 0 0 30px -10px rgba(56, 189, 248, 0.15);
    }

    .property-card:hover::after {
      border-color: rgba(56, 189, 248, 0.2);
    }

    /* Card Badge */
    .card-badges {
      display: flex;
      gap: 0.5rem;
      position: absolute;
      top: 1.5rem;
      right: 1.8rem;
    }

    .badge {
      font-size: 0.7rem;
      font-weight: 700;
      text-transform: uppercase;
      padding: 0.3rem 0.7rem;
      border-radius: 6px;
      letter-spacing: 0.05em;
    }

    .badge-new {
      background: var(--success-glow);
      color: var(--success-text);
      border: 1px solid rgba(34, 197, 94, 0.3);
      box-shadow: 0 0 10px rgba(34, 197, 94, 0.1);
    }

    .badge-priority {
      background: rgba(244, 63, 94, 0.15);
      color: var(--accent-rose);
      border: 1px solid rgba(244, 63, 94, 0.3);
      box-shadow: 0 0 10px rgba(244, 63, 94, 0.1);
    }

    /* Card Details */
    .card-price {
      font-family: 'Outfit', sans-serif;
      font-size: 2.2rem;
      font-weight: 800;
      color: var(--text-primary);
      margin-bottom: 0.2rem;
      letter-spacing: -0.02em;
    }

    .card-address-container {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.8rem;
      gap: 0.5rem;
      width: 100%;
      overflow: hidden;
    }

    .card-address {
      font-family: 'Outfit', sans-serif;
      font-size: 1.15rem;
      font-weight: 600;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex-grow: 1;
      margin-bottom: 0;
    }

    .map-link {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--accent-cyan);
      text-decoration: none;
      padding: 0.25rem 0.5rem;
      background: rgba(56, 189, 248, 0.05);
      border: 1px solid rgba(56, 189, 248, 0.15);
      border-radius: 6px;
      transition: all 0.2s ease;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .map-link:hover {
      background: rgba(56, 189, 248, 0.15);
      border-color: var(--accent-cyan);
      box-shadow: 0 0 10px rgba(56, 189, 248, 0.2);
    }

    .card-specs-row {
      display: flex;
      flex-wrap: wrap;
      gap: 0.8rem;
      margin-bottom: 1.2rem;
    }

    .spec-pill {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border-glass);
      color: var(--text-secondary);
      font-size: 0.8rem;
      font-weight: 500;
      padding: 0.35rem 0.7rem;
      border-radius: 8px;
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }

    .spec-pill.highlight {
      background: rgba(56, 189, 248, 0.05);
      border-color: rgba(56, 189, 248, 0.15);
      color: var(--accent-cyan);
    }

    .card-agency {
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-bottom: 1.5rem;
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }

    /* Financial Repayment Panel */
    .mortgage-panel {
      background: rgba(13, 19, 33, 0.5);
      border: 1px solid var(--border-glass);
      border-radius: 12px;
      padding: 1rem;
      margin-bottom: 1.5rem;
    }

    .mortgage-panel-title {
      font-size: 0.75rem;
      text-transform: uppercase;
      font-weight: 700;
      color: var(--text-muted);
      margin-bottom: 0.8rem;
      letter-spacing: 0.05em;
      display: flex;
      justify-content: space-between;
    }

    .mortgage-ltv-badge {
      color: var(--accent-cyan);
      font-weight: 700;
    }

    .repayment-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 0.6rem;
      text-align: center;
    }

    .repayment-item {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border-glass);
      border-radius: 8px;
      padding: 0.5rem;
      transition: all 0.3s ease;
    }

    .repayment-term {
      font-size: 0.7rem;
      color: var(--text-muted);
      margin-bottom: 0.15rem;
    }

    .repayment-value {
      font-family: 'Outfit', sans-serif;
      font-size: 1rem;
      font-weight: 700;
      color: var(--accent-cyan);
      transition: color 0.2s ease;
    }

    /* Card Action Button */
    .card-btn {
      display: flex;
      justify-content: center;
      align-items: center;
      width: 100%;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      color: var(--text-primary);
      padding: 0.8rem;
      font-size: 0.9rem;
      font-weight: 600;
      border-radius: 10px;
      cursor: pointer;
      text-decoration: none;
      transition: all 0.2s ease;
      gap: 0.5rem;
    }

    .card-btn:hover {
      background: var(--text-primary);
      color: var(--bg-primary);
      box-shadow: 0 4px 15px rgba(255, 255, 255, 0.1);
    }

    .card-btn svg {
      width: 16px;
      height: 16px;
      fill: currentColor;
      transition: transform 0.2s ease;
    }

    .card-btn:hover svg {
      transform: translateX(4px);
    }

    /* Empty state */
    .empty-state {
      grid-column: 1 / -1;
      text-align: center;
      padding: 5rem 2rem;
      background: var(--bg-card);
      border: 1px dashed var(--border-glass);
      border-radius: 20px;
      color: var(--text-secondary);
    }

    .empty-state h3 {
      font-family: 'Outfit', sans-serif;
      font-size: 1.5rem;
      margin-bottom: 0.5rem;
    }

    /* Responsiveness */
    @media (max-width: 992px) {
      .controls-bar {
        flex-direction: column;
        align-items: stretch;
      }
      .search-box {
        width: 100%;
      }
    }

    @media (max-width: 768px) {
      body {
        padding: 1rem;
      }
      header {
        flex-direction: column;
        align-items: flex-start;
      }
      .header-meta {
        text-align: left;
      }
      .properties-grid {
        grid-template-columns: 1fr;
      }
      #map-container {
        height: 450px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="header-titles">
        <h1>Belfast Property Monitor</h1>
        <p>Strategic residential real estate tracking for first-time buyers</p>
      </div>
      <div class="header-meta">
        <div class="header-date">Daily Analysis: ${todayStr}</div>
        <div class="header-subtitle">BT1-BT17, BT18, BT36, BT37 | Terraced | &le; £250k</div>
      </div>
    </header>

    <!-- Stats Bar -->
    <section class="stats-container">
      <div class="stat-card">
        <div class="stat-card-title">Total Checked Listings</div>
        <div class="stat-card-value">${allProperties.length}</div>
      </div>
      <div class="stat-card rose">
        <div class="stat-card-title">🔥 High Priority Candidates</div>
        <div class="stat-card-value">${highPriorityCount}</div>
      </div>
      <div class="stat-card cyan">
        <div class="stat-card-title">🟢 New Additions Today</div>
        <div class="stat-card-value">${newCount}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-title">Average Asking Price</div>
        <div class="stat-card-value">£${Math.round(avgPrice).toLocaleString()}</div>
      </div>
    </section>

    <!-- Global Mortgage Modeler Panel -->
    <section class="modeler-panel">
      <div class="modeler-header">
        <h2>🛠️ Dynamic Mortgage Modeler</h2>
        <div class="mode-selector">
          <button class="mode-btn active" id="btn-mode-deposit" onclick="setModelerMode('deposit')">Fixed Deposit Mode</button>
          <button class="mode-btn" id="btn-mode-ltv" onclick="setModelerMode('ltv')">Fixed LTV Mode</button>
        </div>
      </div>
      
      <div class="modeler-grid">
        <!-- Slider 1: Deposit Amount -->
        <div class="modeler-control" id="control-deposit">
          <div class="control-header">
            <span class="control-label">Global Deposit Budget</span>
            <span class="control-value" id="val-global-deposit">£20,000</span>
          </div>
          <input type="range" class="custom-slider" id="slider-global-deposit" min="5000" max="100000" step="1000" value="20000" oninput="handleGlobalDepositChange(this.value)">
        </div>

        <!-- Slider 2: LTV Percentage -->
        <div class="modeler-control" id="control-ltv" style="opacity: 0.4; pointer-events: none;">
          <div class="control-header">
            <span class="control-label">Global Loan-to-Value</span>
            <span class="control-value" id="val-global-ltv">90% LTV <span style="font-size:0.75rem; color:var(--text-muted); font-weight:normal;">(10% Dep)</span></span>
          </div>
          <input type="range" class="custom-slider" id="slider-global-ltv" min="50" max="95" step="1" value="90" oninput="handleGlobalLTVChange(this.value)">
        </div>

        <!-- Slider 3: Interest Rate -->
        <div class="modeler-control">
          <div class="control-header">
            <span class="control-label">Interest Rate</span>
            <span class="control-value" id="val-global-rate">5.00%</span>
          </div>
          <input type="range" class="custom-slider" id="slider-global-rate" min="1.0" max="10.0" step="0.05" value="5.0" oninput="handleGlobalRateChange(this.value)">
        </div>
      </div>
    </section>

    <!-- Controls Bar -->
    <section class="controls-bar">
      <div class="filter-tabs">
        <button class="tab-btn active" onclick="setFilter('all', this)">All Listings</button>
        <button class="tab-btn" onclick="setFilter('priority', this)">🔥 High Priority</button>
        <button class="tab-btn" onclick="setFilter('new', this)">🟢 New Additions</button>
        <button class="tab-btn" onclick="setFilter('freehold', this)">Freehold Only</button>
      </div>

      <div class="search-box">
        <svg class="search-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input type="text" id="search-input" placeholder="Search address, postcode, agency..." oninput="handleSearch(this.value)">
      </div>

      <div class="view-selector">
        <button class="view-btn active" id="btn-grid" onclick="setViewMode('grid')">Grid View</button>
        <button class="view-btn" id="btn-map" onclick="setViewMode('map')">Map View</button>
      </div>
    </section>

    <!-- Map View Element -->
    <div id="map-container"></div>

    <!-- Properties Grid -->
    <main class="properties-grid" id="properties-list"></main>
  </div>

  <script>
    // Raw properties injected by Node
    const rawProperties = ${JSON.stringify(allProperties)};

    // Current State
    let activeFilter = 'all';
    let searchQuery = '';
    let activeView = 'grid';
    
    // Global Modeler Settings
    let modelerMode = 'deposit'; // 'deposit' or 'ltv'
    let globalDeposit = 20000;   // In £
    let activeLTV = 90;          // In %
    let activeRate = 5.0;        // In %
    
    // Overridden Property-Specific Financing
    // Key: href, Value: { deposit: Number, ltv: Number, rate: Number, active: Boolean }
    const customFinancing = {};

    let map = null;
    let markersLayer = null;

    // Amortized monthly repayment calculator
    function calculateMonthlyRepayment(price, ltvPercent, annualRate, years) {
      const principal = price * (ltvPercent / 100);
      const r = (annualRate / 100) / 12;
      const n = years * 12;

      if (r === 0) return principal / n;
      const payment = principal * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
      return Math.round(payment * 100) / 100;
    }

    // Calculate days since a property was first seen
    function getDaysSinceListed(firstSeenStr) {
      const firstSeen = new Date(firstSeenStr);
      const today = new Date('${todayStr}');
      firstSeen.setHours(0, 0, 0, 0);
      today.setHours(0, 0, 0, 0);
      const diffTime = today - firstSeen;
      return Math.round(diffTime / (1000 * 60 * 60 * 24));
    }

    function getDaysText(firstSeenStr) {
      const days = getDaysSinceListed(firstSeenStr);
      if (days === 0) return 'New today';
      if (days === 1) return '1 day ago';
      return days + ' days ago';
    }

    // Retrieve active financial model for a specific property
    function getPropertyFinancing(p) {
      // 1. Check if user set custom values for this listing
      if (customFinancing[p.href] && customFinancing[p.href].active) {
        const custom = customFinancing[p.href];
        const deposit = custom.deposit;
        const ltv = custom.ltv;
        const rate = custom.rate;
        const loanAmount = p.price - deposit;
        const warning = (deposit < p.price * 0.05) 
          ? '⚠️ Deposit below minimum (5% = £' + Math.round(p.price * 0.05).toLocaleString() + ' required)' 
          : '';
        
        return {
          deposit: deposit,
          ltv: ltv,
          rate: rate,
          loanAmount: loanAmount,
          warning: warning,
          rep25: calculateMonthlyRepayment(p.price, ltv, rate, 25),
          rep30: calculateMonthlyRepayment(p.price, ltv, rate, 30),
          rep35: calculateMonthlyRepayment(p.price, ltv, rate, 35)
        };
      }

      // 2. Otherwise, use global modeler settings
      let deposit, ltv, warning = '';
      if (modelerMode === 'deposit') {
        deposit = globalDeposit;
        if (deposit > p.price) {
          deposit = p.price;
        }
        ltv = 100 * (1 - deposit / p.price);
        
        // 5% minimum deposit check
        if (deposit < p.price * 0.05) {
          warning = '⚠️ Deposit below minimum (5% = £' + Math.round(p.price * 0.05).toLocaleString() + ' required)';
        }
      } else {
        ltv = activeLTV;
        deposit = p.price * (1 - ltv / 100);
      }

      const loanAmount = p.price - deposit;

      return {
        deposit: Math.round(deposit),
        ltv: Math.round(ltv * 10) / 10,
        rate: activeRate,
        loanAmount: Math.round(loanAmount),
        warning: warning,
        rep25: calculateMonthlyRepayment(p.price, ltv, activeRate, 25),
        rep30: calculateMonthlyRepayment(p.price, ltv, activeRate, 30),
        rep35: calculateMonthlyRepayment(p.price, ltv, activeRate, 35)
      };
    }

    // Global Controls Event Handlers
    function setModelerMode(mode) {
      modelerMode = mode;
      
      const btnDep = document.getElementById('btn-mode-deposit');
      const btnLtv = document.getElementById('btn-mode-ltv');
      const ctrlDep = document.getElementById('control-deposit');
      const ctrlLtv = document.getElementById('control-ltv');
      
      if (mode === 'deposit') {
        btnDep.classList.add('active');
        btnLtv.classList.remove('active');
        ctrlDep.style.opacity = '1';
        ctrlDep.style.pointerEvents = 'auto';
        ctrlLtv.style.opacity = '0.4';
        ctrlLtv.style.pointerEvents = 'none';
      } else {
        btnDep.classList.remove('active');
        btnLtv.classList.add('active');
        ctrlDep.style.opacity = '0.4';
        ctrlDep.style.pointerEvents = 'none';
        ctrlLtv.style.opacity = '1';
        ctrlLtv.style.pointerEvents = 'auto';
      }
      
      renderListings();
      if (map) renderMapMarkers();
    }

    function handleGlobalDepositChange(val) {
      globalDeposit = parseFloat(val) || 20000;
      document.getElementById('val-global-deposit').innerText = '£' + globalDeposit.toLocaleString();
      renderListings();
      if (map) renderMapMarkers();
    }

    function handleGlobalLTVChange(val) {
      activeLTV = parseFloat(val) || 90;
      document.getElementById('val-global-ltv').innerHTML = activeLTV + '% LTV <span style="font-size:0.75rem; color:var(--text-muted); font-weight:normal;">(' + (100 - activeLTV) + '% Dep)</span>';
      renderListings();
      if (map) renderMapMarkers();
    }

    function handleGlobalRateChange(val) {
      activeRate = parseFloat(val) || 5.0;
      document.getElementById('val-global-rate').innerText = activeRate.toFixed(2) + '%';
      renderListings();
      if (map) renderMapMarkers();
    }

    // Property-Specific Calculator Handlers
    function toggleCardCalculator(url, event) {
      if (event) event.stopPropagation();
      const safeId = url.replace(/[^a-zA-Z0-9]/g, '');
      const calcEl = document.getElementById('calc-' + safeId);
      if (!calcEl) return;
      
      const isExpanded = calcEl.style.display === 'flex';
      calcEl.style.display = isExpanded ? 'none' : 'flex';
    }

    // Unified Affordability Core Calculations & Synchronizers
    function handleDepositChange(url, depositVal, price, source) {
      const parsedDep = Math.max(0, Math.min(price, parseFloat(depositVal) || 0));
      const calculatedLtv = 100 * (1 - parsedDep / price);
      
      if (!customFinancing[url]) {
        customFinancing[url] = { rate: activeRate };
      }
      customFinancing[url].active = true;
      customFinancing[url].deposit = parsedDep;
      customFinancing[url].ltv = Math.round(calculatedLtv * 10) / 10;
      
      const safeId = url.replace(/[^a-zA-Z0-9]/g, '');
      
      // Update Card inputs
      const cardInputEl = document.getElementById('input-dep-' + safeId);
      const cardSliderEl = document.getElementById('slider-dep-' + safeId);
      const cardLtvSliderEl = document.getElementById('slider-ltv-' + safeId);
      const cardLtvLabelEl = document.getElementById('lbl-ltv-' + safeId);
      
      if (cardInputEl && cardInputEl.value != parsedDep) cardInputEl.value = parsedDep;
      if (cardSliderEl && cardSliderEl.value != parsedDep) cardSliderEl.value = parsedDep;
      if (cardLtvSliderEl) cardLtvSliderEl.value = Math.max(50, Math.min(95, customFinancing[url].ltv));
      if (cardLtvLabelEl) cardLtvLabelEl.innerText = Math.round(customFinancing[url].ltv * 10) / 10;
      
      // Update Popup inputs
      const popupInputEl = document.getElementById('popup-input-dep-' + safeId);
      const popupSliderEl = document.getElementById('popup-slider-dep-' + safeId);
      const popupLtvSliderEl = document.getElementById('popup-slider-ltv-' + safeId);
      const popupLtvLabelEl = document.getElementById('popup-lbl-ltv-' + safeId);
      
      if (popupInputEl && popupInputEl.value != parsedDep) popupInputEl.value = parsedDep;
      if (popupSliderEl && popupSliderEl.value != parsedDep) popupSliderEl.value = parsedDep;
      if (popupLtvSliderEl) popupLtvSliderEl.value = Math.max(50, Math.min(95, customFinancing[url].ltv));
      if (popupLtvLabelEl) popupLtvLabelEl.innerText = Math.round(customFinancing[url].ltv * 10) / 10;
      
      updateCardUi(url);
      updatePopupUi(url);
    }

    function handleLTVChange(url, ltvVal, price, source) {
      const parsedLtv = parseFloat(ltvVal) || 90;
      const calculatedDep = price * (1 - parsedLtv / 100);
      
      if (!customFinancing[url]) {
        customFinancing[url] = { rate: activeRate };
      }
      customFinancing[url].active = true;
      customFinancing[url].ltv = parsedLtv;
      customFinancing[url].deposit = Math.round(calculatedDep);
      
      const safeId = url.replace(/[^a-zA-Z0-9]/g, '');
      
      // Update Card inputs
      const cardInputEl = document.getElementById('input-dep-' + safeId);
      const cardSliderEl = document.getElementById('slider-dep-' + safeId);
      const cardLtvLabelEl = document.getElementById('lbl-ltv-' + safeId);
      const cardLtvSliderEl = document.getElementById('slider-ltv-' + safeId);
      
      if (cardInputEl) cardInputEl.value = customFinancing[url].deposit;
      if (cardSliderEl) cardSliderEl.value = customFinancing[url].deposit;
      if (cardLtvLabelEl) cardLtvLabelEl.innerText = parsedLtv;
      if (cardLtvSliderEl) cardLtvSliderEl.value = parsedLtv;
      
      // Update Popup inputs
      const popupInputEl = document.getElementById('popup-input-dep-' + safeId);
      const popupSliderEl = document.getElementById('popup-slider-dep-' + safeId);
      const popupLtvLabelEl = document.getElementById('popup-lbl-ltv-' + safeId);
      const popupLtvSliderEl = document.getElementById('popup-slider-ltv-' + safeId);
      
      if (popupInputEl) popupInputEl.value = customFinancing[url].deposit;
      if (popupSliderEl) popupSliderEl.value = customFinancing[url].deposit;
      if (popupLtvLabelEl) popupLtvLabelEl.innerText = parsedLtv;
      if (popupLtvSliderEl) popupLtvSliderEl.value = parsedLtv;
      
      updateCardUi(url);
      updatePopupUi(url);
    }

    function handleRateChange(url, rateVal, price, source) {
      const parsedRate = parseFloat(rateVal) || 5.0;
      
      if (!customFinancing[url]) {
        const p = rawProperties.find(x => x.href === url);
        const fin = getPropertyFinancing(p);
        customFinancing[url] = { deposit: fin.deposit, ltv: fin.ltv };
      }
      customFinancing[url].active = true;
      customFinancing[url].rate = parsedRate;
      
      const safeId = url.replace(/[^a-zA-Z0-9]/g, '');
      
      // Update Card inputs
      const cardRateLabelEl = document.getElementById('lbl-rate-' + safeId);
      const cardRateSliderEl = document.getElementById('slider-rate-' + safeId);
      if (cardRateLabelEl) cardRateLabelEl.innerText = parsedRate.toFixed(2);
      if (cardRateSliderEl) cardRateSliderEl.value = parsedRate;
      
      // Update Popup inputs
      const popupRateLabelEl = document.getElementById('popup-lbl-rate-' + safeId);
      const popupRateSliderEl = document.getElementById('popup-slider-rate-' + safeId);
      if (popupRateLabelEl) popupRateLabelEl.innerText = parsedRate.toFixed(2);
      if (popupRateSliderEl) popupRateSliderEl.value = parsedRate;
      
      updateCardUi(url);
      updatePopupUi(url);
    }

    function resetCalculator(url, event) {
      if (event) event.stopPropagation();
      if (customFinancing[url]) {
        customFinancing[url].active = false;
      }
      
      const safeId = url.replace(/[^a-zA-Z0-9]/g, '');
      const p = rawProperties.find(x => x.href === url);
      const fin = getPropertyFinancing(p);
      
      // Reset Card Inputs
      const cardInputEl = document.getElementById('input-dep-' + safeId);
      const cardSliderEl = document.getElementById('slider-dep-' + safeId);
      const cardLtvSliderEl = document.getElementById('slider-ltv-' + safeId);
      const cardLtvLabelEl = document.getElementById('lbl-ltv-' + safeId);
      const cardRateSliderEl = document.getElementById('slider-rate-' + safeId);
      const cardRateLabelEl = document.getElementById('lbl-rate-' + safeId);
      
      if (cardInputEl) cardInputEl.value = fin.deposit;
      if (cardSliderEl) cardSliderEl.value = fin.deposit;
      if (cardLtvSliderEl) cardLtvSliderEl.value = fin.ltv;
      if (cardLtvLabelEl) cardLtvLabelEl.innerText = fin.ltv;
      if (cardRateSliderEl) cardRateSliderEl.value = fin.rate;
      if (cardRateLabelEl) cardRateLabelEl.innerText = fin.rate.toFixed(2);
      
      // Reset Popup Inputs
      const popupInputEl = document.getElementById('popup-input-dep-' + safeId);
      const popupSliderEl = document.getElementById('popup-slider-dep-' + safeId);
      const popupLtvSliderEl = document.getElementById('popup-slider-ltv-' + safeId);
      const popupLtvLabelEl = document.getElementById('popup-lbl-ltv-' + safeId);
      const popupRateSliderEl = document.getElementById('popup-slider-rate-' + safeId);
      const popupRateLabelEl = document.getElementById('popup-lbl-rate-' + safeId);
      
      if (popupInputEl) popupInputEl.value = fin.deposit;
      if (popupSliderEl) popupSliderEl.value = fin.deposit;
      if (popupLtvSliderEl) popupLtvSliderEl.value = fin.ltv;
      if (popupLtvLabelEl) popupLtvLabelEl.innerText = fin.ltv;
      if (popupRateSliderEl) popupRateSliderEl.value = fin.rate;
      if (popupRateLabelEl) popupRateLabelEl.innerText = fin.rate.toFixed(2);
      
      updateCardUi(url);
      updatePopupUi(url);
    }

    // Grid Card Shell Handlers (call unified core)
    function handleCardDepositChange(url, val, price) {
      handleDepositChange(url, val, price, 'card');
    }
    function handleCardLTVChange(url, val, price) {
      handleLTVChange(url, val, price, 'card');
    }
    function handleCardRateChange(url, val, price) {
      handleRateChange(url, val, price, 'card');
    }
    function resetCardCalculator(url, event) {
      resetCalculator(url, event);
    }

    // Popup-specific Shell Handlers (call unified core)
    function handlePopupDepositChange(url, val, price) {
      handleDepositChange(url, val, price, 'popup');
    }
    function handlePopupLTVChange(url, val, price) {
      handleLTVChange(url, val, price, 'popup');
    }
    function handlePopupRateChange(url, val, price) {
      handleRateChange(url, val, price, 'popup');
    }
    function resetPopupCalculator(url, event) {
      resetCalculator(url, event);
    }

    function togglePopupCalculator(url, event) {
      if (event) event.stopPropagation();
      const safeId = url.replace(/[^a-zA-Z0-9]/g, '');
      const calcEl = document.getElementById('popup-calc-' + safeId);
      if (!calcEl) return;
      
      const isExpanded = calcEl.style.display === 'flex';
      calcEl.style.display = isExpanded ? 'none' : 'flex';
      
      // Refresh popup dimensions for Leaflet container autoPan
      const popup = map._popup;
      if (popup) {
        popup.update();
      }
    }

    function updatePopupUi(url) {
      const safeId = url.replace(/[^a-zA-Z0-9]/g, '');
      const popupEl = document.querySelector('.leaflet-popup-content');
      if (!popupEl) return;
      
      const p = rawProperties.find(x => x.href === url);
      if (!p) return;
      
      const fin = getPropertyFinancing(p);
      
      const depEl = popupEl.querySelector('.popup-lbl-card-deposit');
      const ltvPctEl = popupEl.querySelector('.popup-lbl-card-ltv-pct');
      const rateEl = popupEl.querySelector('.popup-lbl-card-rate');
      const ltvEl = popupEl.querySelector('.popup-lbl-card-ltv');
      const rep25El = popupEl.querySelector('.popup-lbl-card-rep25');
      const rep30El = popupEl.querySelector('.popup-lbl-card-rep30');
      const rep35El = popupEl.querySelector('.popup-lbl-card-rep35');
      const warningEl = popupEl.querySelector('.popup-warning-container');
      
      if (depEl) depEl.innerText = '£' + fin.deposit.toLocaleString();
      if (ltvPctEl) ltvPctEl.innerText = '(' + fin.ltv + '% LTV)';
      if (rateEl) rateEl.innerText = fin.rate.toFixed(2) + '%';
      if (ltvEl) ltvEl.innerText = fin.ltv + '% LTV';
      
      if (rep25El) rep25El.innerText = '£' + fin.rep25.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
      if (rep30El) rep30El.innerText = '£' + fin.rep30.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
      if (rep35El) rep35El.innerText = '£' + fin.rep35.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
      
      if (warningEl) {
        warningEl.innerHTML = fin.warning ? '<div class="affordability-warning">' + fin.warning + '</div>' : '';
      }
    }

    // Smooth partial card DOM updates
    function updateCardUi(url) {
      const safeId = url.replace(/[^a-zA-Z0-9]/g, '');
      const cardEl = document.getElementById('card-' + safeId);
      if (!cardEl) return;
      
      const p = rawProperties.find(x => x.href === url);
      if (!p) return;
      
      const fin = getPropertyFinancing(p);
      
      const depEl = cardEl.querySelector('.lbl-card-deposit');
      const ltvPctEl = cardEl.querySelector('.lbl-card-ltv-pct');
      const loanEl = cardEl.querySelector('.lbl-card-loan');
      const rateEl = cardEl.querySelector('.lbl-card-rate');
      const ltvEl = cardEl.querySelector('.lbl-card-ltv');
      const rep25El = cardEl.querySelector('.lbl-card-rep25');
      const rep30El = cardEl.querySelector('.lbl-card-rep30');
      const rep35El = cardEl.querySelector('.lbl-card-rep35');
      const warningEl = cardEl.querySelector('.card-warning-container');
      
      if (depEl) depEl.innerText = '£' + fin.deposit.toLocaleString();
      if (ltvPctEl) ltvPctEl.innerText = '(' + fin.ltv + '% LTV)';
      if (loanEl) loanEl.innerText = '£' + fin.loanAmount.toLocaleString();
      if (rateEl) rateEl.innerText = fin.rate.toFixed(2) + '%';
      if (ltvEl) ltvEl.innerText = fin.ltv + '% LTV';
      
      if (rep25El) rep25El.innerText = '£' + fin.rep25.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
      if (rep30El) rep30El.innerText = '£' + fin.rep30.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
      if (rep35El) rep35El.innerText = '£' + fin.rep35.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
      
      if (warningEl) {
        warningEl.innerHTML = fin.warning ? '<div class="affordability-warning">' + fin.warning + '</div>' : '';
      }
    }

    // Handle search input filtering
    function handleSearch(query) {
      searchQuery = query.toLowerCase().trim();
      renderListings();
    }

    // Set Active Filter Tab
    function setFilter(filter, btn) {
      activeFilter = filter;

      const tabs = btn.parentElement.querySelectorAll('.tab-btn');
      tabs.forEach(t => t.classList.remove('active'));
      btn.classList.add('active');

      renderListings();
    }

    // Set View Mode (Grid vs Map)
    function setViewMode(mode) {
      activeView = mode;
      
      const gridBtn = document.getElementById('btn-grid');
      const mapBtn = document.getElementById('btn-map');
      const gridEl = document.getElementById('properties-list');
      const mapEl = document.getElementById('map-container');
      
      if (mode === 'grid') {
        gridBtn.classList.add('active');
        mapBtn.classList.remove('active');
        gridEl.style.display = 'grid';
        mapEl.style.display = 'none';
      } else {
        gridBtn.classList.remove('active');
        mapBtn.classList.add('active');
        gridEl.style.display = 'none';
        mapEl.style.display = 'block';
        
        if (!map) {
          initMap();
        }
        
        setTimeout(() => {
          if (map) {
            map.invalidateSize();
          }
        }, 100);
      }
    }

    // Get filtered list of properties
    function getFilteredProperties() {
      return rawProperties.filter(p => {
        const isTerraced = p.style.toLowerCase().includes('terrace') || p.style.toLowerCase().includes('townhouse');
        const isFreehold = p.tenure.toLowerCase().includes('freehold');
        const has2Baths = p.numBathrooms >= 2;
        const isPriority = isTerraced && isFreehold && has2Baths;

        if (activeFilter === 'priority' && !isPriority) return false;
        if (activeFilter === 'new' && !p.isNew) return false;
        if (activeFilter === 'freehold' && !isFreehold) return false;

        if (searchQuery) {
          const matchAddress = p.address.toLowerCase().includes(searchQuery);
          const matchPostcode = p.postcode.toLowerCase().includes(searchQuery);
          const matchAgency = p.agency.toLowerCase().includes(searchQuery);
          const matchStyle = p.style.toLowerCase().includes(searchQuery);
          if (!matchAddress && !matchPostcode && !matchAgency && !matchStyle) return false;
        }

        return true;
      });
    }

    // Initialize Leaflet Map
    function initMap() {
      map = L.map('map-container').setView([54.5973, -5.9301], 13);

      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 20
      }).addTo(map);

      markersLayer = L.layerGroup().addTo(map);
      renderMapMarkers();
    }

    // Draw markers on map based on current filter state
    function renderMapMarkers() {
      if (!map || !markersLayer) return;

      markersLayer.clearLayers();
      const filtered = getFilteredProperties();
      const bounds = [];

      filtered.forEach(p => {
        if (p.latitude === undefined || p.latitude === null || p.longitude === undefined || p.longitude === null) {
          return;
        }

        const lat = parseFloat(p.latitude);
        const lng = parseFloat(p.longitude);
        bounds.push([lat, lng]);

        const isTerraced = p.style.toLowerCase().includes('terrace') || p.style.toLowerCase().includes('townhouse');
        const isFreehold = p.tenure.toLowerCase().includes('freehold');
        const has2Baths = p.numBathrooms >= 2;
        const isPriority = isTerraced && isFreehold && has2Baths;

        let pinClass = 'pin-standard';
        if (isPriority) {
          pinClass = 'pin-priority';
        } else if (p.isNew) {
          pinClass = 'pin-new';
        }

        const customIcon = L.divIcon({
          className: 'custom-marker',
          html: '<div class="marker-pin ' + pinClass + '"></div>',
          iconSize: [24, 24],
          iconAnchor: [12, 12],
          popupAnchor: [0, -12]
        });

        let badges = '';
        if (isPriority) badges += '<span class="popup-spec-pill priority-pill">🔥 High Priority</span>';
        if (p.isNew) badges += '<span class="popup-spec-pill highlight" style="color: var(--success-text); border-color: rgba(34,197,94,0.3); background: var(--success-glow);">🟢 New</span>';

        const fin = getPropertyFinancing(p);
        const rep25 = fin.rep25.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
        const rep30 = fin.rep30.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
        const rep35 = fin.rep35.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});

        const popupHtml = \`
          <div class="popup-card">
            <div class="popup-header">
              <div style="display: flex; gap: 0.3rem; margin-bottom: 0.2rem;">\${badges}</div>
              <div class="popup-price">£\${p.price.toLocaleString()}</div>
              <div class="popup-address" title="\${p.address}">\${p.address}</div>
            </div>
            
            <div class="popup-specs">
              <span class="popup-spec-pill">\${p.numBedrooms} Bed</span>
              <span class="popup-spec-pill \${has2Baths ? 'highlight' : ''}">\${p.numBathrooms} Bath</span>
              <span class="popup-spec-pill \${isFreehold ? 'highlight' : ''}">\${p.tenure}</span>
              <span class="popup-spec-pill">\${p.style}</span>
            </div>
            
            <div class="popup-meta">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
              Commute: \${p.postcode} (&le; 30m)
            </div>
            <div class="popup-meta" style="margin-top: -0.2rem;">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              Agency: \${p.agency}
            </div>
            <div class="popup-meta" style="margin-top: -0.2rem; color: var(--text-secondary);">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:0.2rem; color: var(--accent-indigo);"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
              Listed: <strong>\${p.firstSeen}</strong> (\${getDaysText(p.firstSeen)})
            </div>
            <div class="popup-meta" style="margin-top: 0.2rem; color: var(--accent-cyan);">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:0.2rem;"><rect x="2" y="4" width="20" height="16" rx="2"/><circle cx="12" cy="12" r="2"/></svg>
              Deposit: <strong class="popup-lbl-card-deposit" style="color: var(--accent-cyan);">£\${fin.deposit.toLocaleString()}</strong> <span class="popup-lbl-card-ltv-pct" style="color: var(--text-muted);">(\${fin.ltv}% LTV)</span>
            </div>
            
            <div class="popup-warning-container">
              \${fin.warning ? '<div class="affordability-warning">' + fin.warning + '</div>' : ''}
            </div>
            
            <div class="popup-mortgage">
              <div class="popup-mortgage-title">
                <span>Repayments at <strong class="popup-lbl-card-rate">\${fin.rate.toFixed(2)}%</strong></span>
                <span class="popup-lbl-card-ltv" style="color: var(--accent-cyan); font-weight:700;">\${fin.ltv}% LTV</span>
              </div>
              <div class="popup-repayment-grid">
                <div class="popup-repayment-item">
                  <div class="popup-repayment-term">25 Yrs</div>
                  <div class="popup-repayment-val popup-lbl-card-rep25">£\${rep25}</div>
                </div>
                <div class="popup-repayment-item">
                  <div class="popup-repayment-term">30 Yrs</div>
                  <div class="popup-repayment-val popup-lbl-card-rep30">£\${rep30}</div>
                </div>
                <div class="popup-repayment-item">
                  <div class="popup-repayment-val popup-lbl-card-rep35">£\${rep35}</div>
                </div>
              </div>
            </div>
            
            <a href="\${p.href}" target="_blank" class="popup-btn">
              View PropertyPal
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
            </a>
            <div class="popup-links-row">
              <a class="popup-map-link" href="https://www.google.com/maps/search/?api=1&query=\${encodeURIComponent(p.address)}" target="_blank">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 0.2rem;"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/><line x1="9" y1="3" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="21"/></svg>
                Directions
              </a>
            </div>
            
            <button class="customize-toggle-btn" onclick="togglePopupCalculator('\\\${p.href}', event)">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:0.2rem;"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
              Customize Financing
            </button>
            
            <div class="card-calculator" id="popup-calc-\\\${safeId}" style="display: none;">
              <div class="calc-row">
                <div class="calc-header">
                  <span>Custom Deposit</span>
                  <div class="calc-input-box">
                    <span>£</span>
                    <input type="number" id="popup-input-dep-\\\${safeId}" value="\\\${fin.deposit}" oninput="handlePopupDepositChange('\\\${p.href}', this.value, \\\${p.price})" onmousedown="event.stopPropagation()" onpointerdown="event.stopPropagation()">
                  </div>
                </div>
                <input type="range" class="custom-slider" id="popup-slider-dep-\\\${safeId}" min="0" max="\\\${p.price}" step="500" value="\\\${fin.deposit}" oninput="handlePopupDepositChange('\\\${p.href}', this.value, \\\${p.price})" onmousedown="event.stopPropagation()" onpointerdown="event.stopPropagation()">
              </div>
              
              <div class="calc-row">
                <div class="calc-header">
                  <span>Custom LTV</span>
                  <span class="calc-val"><span id="popup-lbl-ltv-\\\${safeId}">\\\${fin.ltv}</span>% LTV</span>
                </div>
                <input type="range" class="custom-slider" id="popup-slider-ltv-\\\${safeId}" min="50" max="95" step="1" value="\\\${fin.ltv}" oninput="handlePopupLTVChange('\\\${p.href}', this.value, \\\${p.price})" onmousedown="event.stopPropagation()" onpointerdown="event.stopPropagation()">
              </div>

              <div class="calc-row">
                <div class="calc-header">
                  <span>Custom Interest Rate</span>
                  <span class="calc-val"><span id="popup-lbl-rate-\\\${safeId}">\\\${fin.rate.toFixed(2)}</span>%</span>
                </div>
                <input type="range" class="custom-slider" id="popup-slider-rate-\\\${safeId}" min="1.0" max="10.0" step="0.05" value="\\\${fin.rate}" oninput="handlePopupRateChange('\\\${p.href}', this.value, \\\${p.price})" onmousedown="event.stopPropagation()" onpointerdown="event.stopPropagation()">
              </div>
              
              <button class="customize-toggle-btn" style="border-style: solid; border-color: rgba(239, 68, 68, 0.2); color: hsl(0, 85%, 65%); margin-top: 0.5rem;" onclick="resetPopupCalculator('\\\${p.href}', event)">
                Reset to Global Modeler
              </button>
            </div>
          </div>
        \`;

        const marker = L.marker([lat, lng], { icon: customIcon }).bindPopup(popupHtml);
        markersLayer.addLayer(marker);
      });

      if (bounds.length > 0) {
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
      }
    }

    // Render properties matching active tab & rate
    function renderListings() {
      const container = document.getElementById('properties-list');
      container.innerHTML = '';

      const filtered = getFilteredProperties();

      if (map) {
        renderMapMarkers();
      }

      if (filtered.length === 0) {
        container.innerHTML = ' \
          <div class="empty-state"> \
            <h3>No Properties Found</h3> \
            <p>Try switching to another filter or check back later.</p> \
          </div> \
        ';
        return;
      }

      filtered.forEach(p => {
        const isTerraced = p.style.toLowerCase().includes('terrace') || p.style.toLowerCase().includes('townhouse');
        const isFreehold = p.tenure.toLowerCase().includes('freehold');
        const has2Baths = p.numBathrooms >= 2;
        const isPriority = isTerraced && isFreehold && has2Baths;

        let badges = '';
        if (isPriority) badges += '<span class="badge badge-priority">🔥 High Priority</span>';
        if (p.isNew) badges += '<span class="badge badge-new">🟢 New</span>';

        const fin = getPropertyFinancing(p);
        const rep25 = fin.rep25.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
        const rep30 = fin.rep30.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
        const rep35 = fin.rep35.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
        const safeId = p.href.replace(/[^a-zA-Z0-9]/g, '');

        const cardHtml = \`
          <div class="property-card" id="card-\${safeId}">
            <div>
              <div class="card-badges">\${badges}</div>
              <div class="card-price">£\${p.price.toLocaleString()}</div>
              <div class="card-address-container">
                <div class="card-address" title="\${p.address}">\${p.address}</div>
                <a class="map-link" href="https://www.google.com/maps/search/?api=1&query=\${encodeURIComponent(p.address)}" target="_blank" title="View on Google Maps">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/><line x1="9" y1="3" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="21"/></svg>
                  Map Location
                </a>
              </div>
              
              <div class="card-specs-row">
                <span class="spec-pill">\${p.numBedrooms} Bed</span>
                <span class="spec-pill \${has2Baths ? 'highlight' : ''}">\${p.numBathrooms} Bath</span>
                <span class="spec-pill \${isFreehold ? 'highlight' : ''}">\${p.tenure}</span>
                <span class="spec-pill">\${p.style}</span>
              </div>

              <div class="card-agency">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                Commute: \${p.postcode} (&le; 30m)
              </div>
              <div class="card-agency" style="margin-top: -1rem;">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                Agency: \${p.agency}
              </div>

              <div class="card-agency" style="margin-top: -1rem; color: var(--text-secondary);">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-indigo);"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                Listed: <strong style="margin-left:0.2rem; color: var(--text-primary);">\${p.firstSeen}</strong> <span style="font-size:0.75rem; color:var(--text-muted); margin-left:0.3rem;">(\${getDaysText(p.firstSeen)})</span>
              </div>

              <div class="card-agency" style="margin-top: -1rem; color: var(--text-secondary);">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><line x1="12" y1="10" x2="12" y2="10"/><line x1="8" y1="10" x2="8" y2="10"/><line x1="16" y1="10" x2="16" y2="10"/></svg>
                Deposit: <strong class="lbl-card-deposit" style="margin-left:0.2rem; color:var(--accent-cyan);">£\${fin.deposit.toLocaleString()}</strong> <span class="lbl-card-ltv-pct" style="font-size:0.75rem; color:var(--text-muted); margin-left:0.3rem;">(\${fin.ltv}% LTV)</span>
              </div>
              <div class="card-agency" style="margin-top: -1rem; color: var(--text-secondary);">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
                Loan Amount: <strong class="lbl-card-loan" style="margin-left:0.2rem; color:var(--text-primary);">£\${fin.loanAmount.toLocaleString()}</strong>
              </div>

              <div class="card-warning-container">
                \${fin.warning ? '<div class="affordability-warning">' + fin.warning + '</div>' : ''}
              </div>
            </div>

            <div>
              <div class="mortgage-panel">
                <div class="mortgage-panel-title">
                  <span>Repayments at <strong class="lbl-card-rate">\${fin.rate.toFixed(2)}%</strong></span>
                  <span class="mortgage-ltv-badge lbl-card-ltv">\${fin.ltv}% LTV</span>
                </div>
                <div class="repayment-grid">
                  <div class="repayment-item">
                    <div class="repayment-term">25 Yrs</div>
                    <div class="repayment-value lbl-card-rep25">£\${rep25}</div>
                  </div>
                  <div class="repayment-item">
                    <div class="repayment-term">30 Yrs</div>
                    <div class="repayment-value lbl-card-rep30">£\${rep30}</div>
                  </div>
                  <div class="repayment-item">
                    <div class="repayment-term">35 Yrs</div>
                    <div class="repayment-value lbl-card-rep35">£\${rep35}</div>
                  </div>
                </div>
              </div>

              <a href="\${p.href}" target="_blank" class="card-btn">
                View PropertyPal
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
              </a>

              <button class="customize-toggle-btn" onclick="toggleCardCalculator('\${p.href}', event)">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:0.2rem;"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
                Customize Financing
              </button>
              
              <div class="card-calculator" id="calc-\${safeId}">
                <div class="calc-row">
                  <div class="calc-header">
                    <span>Custom Deposit</span>
                    <div class="calc-input-box">
                      <span>£</span>
                      <input type="number" id="input-dep-\${safeId}" value="\${fin.deposit}" oninput="handleCardDepositChange('\${p.href}', this.value, \${p.price})">
                    </div>
                  </div>
                  <input type="range" class="custom-slider" id="slider-dep-\${safeId}" min="0" max="\${p.price}" step="500" value="\${fin.deposit}" oninput="handleCardDepositChange('\${p.href}', this.value, \${p.price})">
                </div>
                
                <div class="calc-row">
                  <div class="calc-header">
                    <span>Custom LTV</span>
                    <span class="calc-val"><span id="lbl-ltv-\${safeId}">\${fin.ltv}</span>% LTV</span>
                  </div>
                  <input type="range" class="custom-slider" id="slider-ltv-\${safeId}" min="50" max="95" step="1" value="\${fin.ltv}" oninput="handleCardLTVChange('\${p.href}', this.value, \${p.price})">
                </div>

                <div class="calc-row">
                  <div class="calc-header">
                    <span>Custom Interest Rate</span>
                    <span class="calc-val"><span id="lbl-rate-\${safeId}">\${fin.rate.toFixed(2)}</span>%</span>
                  </div>
                  <input type="range" class="custom-slider" id="slider-rate-\${safeId}" min="1.0" max="10.0" step="0.05" value="\${fin.rate}" oninput="handleCardRateChange('\${p.href}', this.value, \${p.price})">
                </div>
                
                <button class="customize-toggle-btn" style="border-style: solid; border-color: rgba(239, 68, 68, 0.2); color: hsl(0, 85%, 65%); margin-top: 0.5rem;" onclick="resetCardCalculator('\${p.href}', event)">
                  Reset to Global Modeler
                </button>
              </div>
            </div>
          </div>
        \`;
        container.insertAdjacentHTML('beforeend', cardHtml);
      });
    }

    // Initial load
    renderListings();
  </script>
</body>
</html>

`;

  fs.writeFileSync(filePath, html, 'utf-8');
  console.log(`Generated ${filePath}`);
}

run();
