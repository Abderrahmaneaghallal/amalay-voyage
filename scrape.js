const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TARGET_HOST = 'https://amalay.vercel.app';
const WORKSPACE_DIR = 'c:/Users/hp/Desktop/AMALAY';

// Pages to scrape
const pages = [
  { path: '/fr', filename: 'fr/index.html' },
  { path: '/fr/signin', filename: 'fr/signin.html' },
  { path: '/fr/signup', filename: 'fr/signup.html' },
  { path: '/fr/cities', filename: 'fr/cities.html' },
  { path: '/fr/parteners', filename: 'fr/parteners.html' },
  { path: '/fr/offers', filename: 'fr/offers.html' },
  { path: '/fr/mbaraa', filename: 'fr/mbaraa.html' },
  { path: '/fr/blogs', filename: 'fr/blogs.html' },
  { path: '/fr/referral', filename: 'fr/referral.html' },
  { path: '/fr/payment', filename: 'fr/payment.html' },
  { path: '/fr/helpCenter', filename: 'fr/helpCenter.html' },
  { path: '/fr/confidentiality', filename: 'fr/confidentiality.html' },
  { path: '/fr/conditions', filename: 'fr/conditions.html' },
];

// In-memory cache of downloaded assets to avoid duplicates
// Maps: absoluteUrl -> relativePath (e.g. 'assets/images/abcd.png')
const assetCache = {};

// Ensure directories exist
function ensureDirs() {
  const dirs = [
    path.join(WORKSPACE_DIR, 'fr'),
    path.join(WORKSPACE_DIR, 'assets/css'),
    path.join(WORKSPACE_DIR, 'assets/images'),
    path.join(WORKSPACE_DIR, 'assets/fonts')
  ];
  for (const d of dirs) {
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true });
    }
  }
}

// Get file extension from URL, handling Next.js resized images
function getExtension(urlStr) {
  try {
    const u = new URL(urlStr, TARGET_HOST);
    let pathname = u.pathname;
    if (pathname.includes('/_next/image')) {
      const innerUrl = u.searchParams.get('url');
      if (innerUrl) {
        const innerU = new URL(innerUrl, TARGET_HOST);
        pathname = innerU.pathname;
      }
    }
    const ext = path.extname(pathname);
    return ext || '.jpg';
  } catch (e) {
    return '.jpg';
  }
}

// Helper to construct absolute URL
function getAbsoluteUrl(urlStr) {
  if (!urlStr) return '';
  if (urlStr.startsWith('data:')) return urlStr;
  if (urlStr.startsWith('http://') || urlStr.startsWith('https://')) return urlStr;
  if (urlStr.startsWith('//')) return 'https:' + urlStr;
  return new URL(urlStr, TARGET_HOST).toString();
}

// Download file helper
async function downloadFile(urlStr, destPath) {
  try {
    const res = await fetch(urlStr);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destPath, buffer);
    console.log(`[Success] Downloaded: ${urlStr} -> ${path.relative(WORKSPACE_DIR, destPath)}`);
    return true;
  } catch (err) {
    console.error(`[Error] Failed to download ${urlStr}:`, err.message);
    return false;
  }
}

// Queue an asset for download, returning its local cache-relative path
async function downloadAsset(urlStr, folder) {
  const absUrl = getAbsoluteUrl(urlStr);
  if (!absUrl || absUrl.startsWith('data:')) return urlStr;
  
  if (assetCache[absUrl]) {
    return assetCache[absUrl];
  }
  
  const ext = getExtension(absUrl);
  const hash = crypto.createHash('md5').update(absUrl).digest('hex').slice(0, 12);
  const filename = `${hash}${ext}`;
  const relPath = `assets/${folder}/${filename}`;
  const destPath = path.join(WORKSPACE_DIR, relPath);
  
  // Download asset
  const success = await downloadFile(absUrl, destPath);
  if (success) {
    assetCache[absUrl] = relPath;
    
    // If it's a CSS file, we must post-process it to find referenced fonts/images
    if (folder === 'css') {
      await processCSSFile(destPath, absUrl);
    }
    
    return relPath;
  } else {
    // Return original url on failure
    return urlStr;
  }
}

// Parse and rewrite asset references in downloaded CSS files
async function processCSSFile(cssPath, cssAbsUrl) {
  let content = fs.readFileSync(cssPath, 'utf8');
  
  // Regex to find url(...) references
  const urlRegex = /url\((?!['"]?data:)([^)]+)\)/g;
  let match;
  const matches = [];
  
  while ((match = urlRegex.exec(content)) !== null) {
    matches.push(match[1]);
  }
  
  for (let matchUrl of matches) {
    // Clean quotes
    matchUrl = matchUrl.replace(/['"]/g, '').trim();
    if (matchUrl.startsWith('data:')) continue;
    
    // Resolve relative URL based on CSS file URL
    let resolvedUrl;
    if (matchUrl.startsWith('/') || matchUrl.startsWith('http') || matchUrl.startsWith('//')) {
      resolvedUrl = getAbsoluteUrl(matchUrl);
    } else {
      // Relative to CSS file
      resolvedUrl = new URL(matchUrl, cssAbsUrl).toString();
    }
    
    // Determine folder type
    let folder = 'images';
    if (resolvedUrl.includes('.woff') || resolvedUrl.includes('.ttf') || resolvedUrl.includes('.eot') || resolvedUrl.includes('.otf')) {
      folder = 'fonts';
    }
    
    const relAssetPath = await downloadAsset(resolvedUrl, folder);
    
    // Rewrite reference in CSS (relative to css folder path, which is assets/css/)
    // assets/css/file.css -> assets/images/file.png means path is ../images/file.png
    const cssToAssetRel = '../' + relAssetPath.replace('assets/', '');
    content = content.replaceAll(matchUrl, cssToAssetRel);
  }
  
  fs.writeFileSync(cssPath, content, 'utf8');
}

// Construct the correct relative path for the HTML file context
function getHTMLRelativePath(pageFilename, relAssetPath) {
  if (relAssetPath.startsWith('http://') || relAssetPath.startsWith('https://') || relAssetPath.startsWith('data:')) {
    return relAssetPath;
  }
  const depth = pageFilename.split('/').length - 1;
  const prefix = '../'.repeat(depth);
  return prefix + relAssetPath;
}

// Process srcset attributes
async function processSrcset(srcset, pageFilename) {
  if (!srcset) return '';
  const parts = [];
  const entries = srcset.split(',');
  
  for (const entry of entries) {
    const trimmed = entry.trim();
    const match = trimmed.match(/^(\S+)(?:\s+(.+))?$/);
    if (!match) {
      parts.push(trimmed);
      continue;
    }
    const url = match[1];
    const descriptor = match[2] || '';
    const relPath = await downloadAsset(url, 'images');
    const pageRelPath = getHTMLRelativePath(pageFilename, relPath);
    parts.push(descriptor ? `${pageRelPath} ${descriptor}` : pageRelPath);
  }
  
  return parts.join(', ');
}

// Inject mobile menu logic & remove nextjs scripts
function sanitizeAndInjectJS(html, pageFilename) {
  // 1. Remove NextJS hydration script tags
  // Matches <script src="/_next/..."></script>
  let cleanHtml = html.replace(/<script[^>]+src="\/_next\/[^"]*"[^>]*><\/script>/gi, '');
  // Matches preloads
  cleanHtml = cleanHtml.replace(/<link[^>]+href="\/_next\/[^"]*"[^>]*>/gi, '');
  // Matches __NEXT_DATA__
  cleanHtml = cleanHtml.replace(/<script[^>]*id="__NEXT_DATA__"[^>]*>[\s\S]*?<\/script>/gi, '');
  // Matches generic self.__next_f scripts
  cleanHtml = cleanHtml.replace(/<script[^>]*>[\s\S]*?self\.__next_f[\s\S]*?<\/script>/gi, '');
  
  // 2. Rewrite navigation URLs to local pages
  // e.g. href="/fr" -> href="index.html" or href="../fr/index.html"
  // e.g. href="/fr/cities" -> href="cities.html" or href="../fr/cities.html"
  for (const p of pages) {
    const targetLocal = getHTMLRelativePath(pageFilename, p.filename);
    
    // Replace href="/fr" with correct relative path
    const regexExact = new RegExp(`href="${p.path}"`, 'g');
    cleanHtml = cleanHtml.replace(regexExact, `href="${targetLocal}"`);
    
    // Replace href="/fr/" with correct relative path
    const regexExactSlash = new RegExp(`href="${p.path}/"`, 'g');
    cleanHtml = cleanHtml.replace(regexExactSlash, `href="${targetLocal}"`);
  }
  
  // 3. Inject custom static vanilla script at the end of body for hamburger menu
  const menuScript = `
  <script>
    document.addEventListener('DOMContentLoaded', () => {
      const menuBtn = document.querySelector('button[aria-label="Open menu"]');
      if (!menuBtn) return;
      
      // Locate mobile menu (the absolute div at bottom of navbar)
      // It is the sibling or inside nav
      const navContainer = menuBtn.closest('nav');
      if (!navContainer) return;
      
      // Let's search for the mobile menu container in nav
      // It is the div with class containing "lg:hidden absolute left-4 right-4"
      const mobileMenu = navContainer.querySelector('.absolute.lg\\\\:hidden');
      if (!mobileMenu) return;
      
      // Hide mobile menu initially
      mobileMenu.classList.add('hidden');
      
      // Save SVG templates for Hamburger and Close X
      const menuSvgHtml = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-menu h-6 w-6" aria-hidden="true"><path d="M4 12h16"></path><path d="M4 18h16"></path><path d="M4 6h16"></path></svg>';
      const closeSvgHtml = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x h-6 w-6" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>';
      
      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = !mobileMenu.classList.contains('hidden');
        if (isOpen) {
          mobileMenu.classList.add('hidden');
          menuBtn.innerHTML = menuSvgHtml;
        } else {
          mobileMenu.classList.remove('hidden');
          menuBtn.innerHTML = closeSvgHtml;
        }
      });
      
      // Close menu if clicking outside
      document.addEventListener('click', (e) => {
        if (!mobileMenu.classList.contains('hidden') && !navContainer.contains(e.target)) {
          mobileMenu.classList.add('hidden');
          menuBtn.innerHTML = menuSvgHtml;
        }
      });
    });
  </script>
  `;
  cleanHtml = cleanHtml.replace('</body>', menuScript + '\n</body>');
  return cleanHtml;
}

// Scrape a single page
async function scrapePage(browser, pageInfo) {
  const page = await browser.newPage();
  
  // Set normal mobile or desktop user agent and screen sizes
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1440, height: 900 });
  
  const pageUrl = TARGET_HOST + pageInfo.path;
  console.log(`\\n---------------------------------------------\\n[Crawl] Navigating to: ${pageUrl}`);
  
  let retries = 3;
  while (retries > 0) {
    try {
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      break;
    } catch (e) {
      retries--;
      console.warn(`[Warning] Navigation failed for ${pageUrl}: ${e.message}. Retries left: ${retries}`);
      if (retries === 0) throw e;
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  
  // Wait 4 seconds for page to hydrate and dynamic components to execute
  await new Promise(r => setTimeout(r, 4000));
  
  // Ensure the page content has finished loading its animations or dynamic states
  // We click the mobile menu button in Puppeteer so we can capture the mobile menu HTML container
  // Then we can extract it and inject it directly into the page's HTML structure
  let mobileMenuHTML = '';
  try {
    // Set viewport to mobile so hamburger shows up
    await page.setViewport({ width: 375, height: 812 });
    await new Promise(r => setTimeout(r, 1000));
    
    // Check if Open menu button is there and click it
    const openMenuBtn = await page.$('button[aria-label="Open menu"]');
    if (openMenuBtn) {
      console.log('[Info] Found mobile menu button. Clicking to render...');
      await openMenuBtn.click();
      await new Promise(r => setTimeout(r, 1500)); // Wait for render
      
      // Extract mobile menu div (class has absolute lg:hidden top-[calc(100%+12px)])
      mobileMenuHTML = await page.evaluate(() => {
        const div = document.querySelector('nav .absolute.lg\\:hidden');
        return div ? div.outerHTML : '';
      });
      console.log('[Info] Successfully captured mobile menu HTML container.');
    }
  } catch (e) {
    console.warn('[Warning] Failed to extract mobile menu overlay:', e.message);
  }
  
  // Restore desktop viewport before grabbing full DOM
  await page.setViewport({ width: 1440, height: 900 });
  await new Promise(r => setTimeout(r, 1000));
  
  // Extract all assets from the page context
  const assets = await page.evaluate(() => {
    const list = { css: [], images: [] };
    
    // Stylesheets
    document.querySelectorAll('link[rel="stylesheet"]').forEach(el => {
      if (el.href) list.css.push(el.href);
    });
    
    // Images
    document.querySelectorAll('img').forEach(el => {
      if (el.src) list.images.push(el.src);
      if (el.srcset) {
        list.images.push(...el.srcset.split(',').map(s => s.trim().split(' ')[0]));
      }
    });
    document.querySelectorAll('source').forEach(el => {
      if (el.srcset) {
        list.images.push(...el.srcset.split(',').map(s => s.trim().split(' ')[0]));
      }
    });
    
    // Background images in inline styles
    Array.from(document.querySelectorAll('*')).forEach(el => {
      const bg = el.style.backgroundImage || getComputedStyle(el).backgroundImage;
      if (bg && bg !== 'none' && bg.startsWith('url(')) {
        let clean = bg.trim().substring(4, bg.trim().length - 1).replace(/^['"]|['"]$/g, '');
        list.images.push(clean);
      }
    });
    
    return list;
  });
  
  // Download CSS
  for (const cssUrl of assets.css) {
    await downloadAsset(cssUrl, 'css');
  }
  
  // Download Images
  for (const imgUrl of assets.images) {
    await downloadAsset(imgUrl, 'images');
  }
  
  // Get the DOM HTML content
  let html = await page.content();
  
  // If we captured mobile menu HTML, inject it into the HTML DOM if not already present
  if (mobileMenuHTML && !html.includes('absolute lg:hidden') && !html.includes('lg:hidden absolute left-4 right-4')) {
    // Inject it inside the inner nav
    // Find the hamburger button container and place it after
    const targetTag = '</button></div></nav>';
    const index = html.indexOf(targetTag);
    if (index !== -1) {
      const splitPos = index + targetTag.length;
      html = html.slice(0, splitPos) + mobileMenuHTML + html.slice(splitPos);
      console.log('[Info] Injected mobile menu overlay HTML.');
    }
  }
  
  // Close the page tab
  await page.close();
  
  // Rewrite HTML urls using assetCache
  let parsedHtml = html;
  
  // Sort cache keys by length descending to prevent substring replace conflicts
  const cacheUrls = Object.keys(assetCache).sort((a, b) => b.length - a.length);
  
  for (const origUrl of cacheUrls) {
    const relAsset = assetCache[origUrl];
    const targetLocal = getHTMLRelativePath(pageInfo.filename, relAsset);
    
    // Replace URL in HTML
    parsedHtml = parsedHtml.replaceAll(origUrl, targetLocal);
    
    // Also replace relative references that don't have targeting host prefix
    try {
      const u = new URL(origUrl);
      const relativePathName = u.pathname;
      if (relativePathName !== '/') {
        parsedHtml = parsedHtml.replaceAll(`"${relativePathName}"`, `"${targetLocal}"`);
        parsedHtml = parsedHtml.replaceAll(`'${relativePathName}'`, `'${targetLocal}'`);
        parsedHtml = parsedHtml.replaceAll(`url(${relativePathName})`, `url(${targetLocal})`);
        
        // NextJS srcset formats
        // e.g. /_next/image?url=%2Fhome%2Fpromo.png&amp;w=640&amp;q=75
        // Escape for string replace
        const nextJSSrcsetPattern = relativePathName.replace(/\\//g, '\\\\/');
        const r = new RegExp(`\\\\/_next\\\\/image\\\\?url=[^"\\\\s]*${nextJSSrcsetPattern}[^"\\\\s]*`, 'g');
        parsedHtml = parsedHtml.replace(r, targetLocal);
      }
    } catch(e) {}
  }
  
  // Clean NextJS, fix navigations, inject dynamic menu toggler
  parsedHtml = sanitizeAndInjectJS(parsedHtml, pageInfo.filename);
  
  // Save page to workspace
  const destFile = path.join(WORKSPACE_DIR, pageInfo.filename);
  fs.writeFileSync(destFile, parsedHtml, 'utf8');
  console.log(`[Success] Saved page: ${pageInfo.path} -> ${pageInfo.filename}`);
}

async function startCrawl() {
  ensureDirs();
  console.log('Starting Website Scraper...');
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  
  try {
    for (const pageInfo of pages) {
      await scrapePage(browser, pageInfo);
    }
    
    // Generate root redirect index.html
    const rootIndexContent = `<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="refresh" content="0; url=./fr/index.html">
  <title>Amalay Redirect</title>
</head>
<body>
  <p>Redirecting to <a href="./fr/index.html">French version</a>...</p>
</body>
</html>`;
    fs.writeFileSync(path.join(WORKSPACE_DIR, 'index.html'), rootIndexContent, 'utf8');
    console.log('[Success] Generated root index.html redirect.');
    
  } catch (err) {
    console.error('Crawl Error:', err);
  } finally {
    await browser.close();
    console.log('Crawl completed.');
  }
}

startCrawl();
