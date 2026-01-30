// server.js
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const FormData = require("form-data");
const cheerio = require('cheerio');
const puppeteer = require("puppeteer");
const stringSimilarity = require("string-similarity");
const app = express();
const PORT = 7860;
app.use(cors());
app.get("/search", async (req, res) => {
  const animeQuery = req.query.q || "Naruto";

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto('https://animepahe.si/anime', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.tab-content .tab-pane');
    await autoScroll(page);

    const results = await page.evaluate(() => {
      const allAnime = [];
      const panes = document.querySelectorAll('.tab-content .tab-pane');
      panes.forEach(pane => {
        const items = pane.querySelectorAll('.col-12.col-md-6 a');
        items.forEach(a => {
          const title = a.getAttribute('title');
          const link = a.getAttribute('href');
          if (title && link) allAnime.push({ title, link });
        });
      });
      return allAnime;
    });

    // Use string similarity to find close matches
    const matches = results.map(anime => {
      const similarity = stringSimilarity.compareTwoStrings(anime.title.toLowerCase(), animeQuery.toLowerCase());
      return { ...anime, similarity };
    });

    // Sort by similarity
    matches.sort((a, b) => b.similarity - a.similarity);

    await browser.close();

    // Return top 10 matches
    return res.json(matches.slice(0, 10));
  } catch (err) {
    await browser.close();
    console.error("Puppeteer search error:", err.message);
    return res.status(500).json({ error: "Failed to fetch search results." });
  }
});

// Helper function for scrolling
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 100;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  });
}

app.get('/video', async (req, res) => {
    const searchQuery = req.query.name;
    const episodeParam = parseInt(req.query.episode);

    if (!searchQuery || isNaN(episodeParam)) {
        return res.status(400).json({ error: 'Missing or invalid query parameters: name and episode' });
    }

    let browser;
    try {
        browser = await puppeteer.launch({ headless: true });
        const page = await browser.newPage();

        await page.setUserAgent('Mozilla/5.0');
        await page.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });

        // Step 1: Search for anime
        const searchUrl = `https://animeheaven.me/search.php?s=${encodeURIComponent(searchQuery)}`;
        await page.goto(searchUrl, { waitUntil: 'networkidle2' });

        const firstAnimeLink = await page.evaluate(() => {
            const aTags = Array.from(document.querySelectorAll('a'));
            const target = aTags.find(a => a.href.includes('anime.php?'));
            return target ? target.href : null;
        });

        if (!firstAnimeLink) {
            await browser.close();
            return res.status(404).json({ error: 'Anime not found' });
        }

        // Step 2: Visit anime page
        await page.goto(firstAnimeLink, { waitUntil: 'networkidle2' });

        const episodeMap = await page.evaluate(() => {
            const items = [];
            const anchors = document.querySelectorAll('a');
            anchors.forEach(a => {
                const href = a.href;
                if (href.includes('episode.php?')) {
                    const text = a.innerText || a.textContent;
                    const match = text.match(/Episode\s*(\d+)/i);
                    if (match) {
                        items.push({ number: parseInt(match[1]), url: href });
                    }
                }
            });
            return items;
        });

        const targetEpisode = episodeMap.find(e => e.number === episodeParam);
        if (!targetEpisode) {
            await browser.close();
            return res.status(404).json({ error: `Episode ${episodeParam} not found` });
        }

        // Step 3: Monitor for .mp4 response
        let videoUrl = null;
        page.on('response', async (response) => {
            const url = response.url();
            if (url.includes('.mp4') && !videoUrl) {
                videoUrl = url;
            }
        });

        // Step 4: Visit episode page and wait for video element
        await page.goto(targetEpisode.url, { waitUntil: 'networkidle2' });
        await page.waitForSelector('video, iframe', { timeout: 10000 }).catch(() => {});

        // Step 5: Extract episode number from page (optional)
        const pageEpisode = await page.evaluate(() => {
            const episodeText = document.body.innerText.match(/Episode\s*(\d+)/i);
            return episodeText ? parseInt(episodeText[1]) : null;
        });

        await browser.close();

        if (videoUrl) {
            return res.json({
                animeName: searchQuery,
                episodeNumber: pageEpisode || episodeParam,
                videoUrl
            });
        } else {
            return res.status(404).json({ error: 'Video URL not found' });
        }

    } catch (err) {
        if (browser) await browser.close();
        console.error(err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

app.get("/info", async (req, res) => {
  const url = req.query.url;

  if (!url || !url.startsWith("https://animepahe.si/anime/")) {
    return res.status(400).json({ error: "Invalid or missing AnimePahe URL." });
  }

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("section.main");

    // Extract anime ID
    const animeId = await page.evaluate(() => {
      const meta = document.querySelector('meta[property="og:url"]');
      return meta ? meta.content.split("/").pop() : null;
    });

    if (!animeId) throw new Error("Failed to extract anime ID");

    // Scrape anime data
    const data = await page.evaluate(() => {
      const getText = (selector) => {
        const el = document.querySelector(selector);
        return el ? el.textContent.trim() : null;
      };

      const getAttr = (selector, attr) => {
        const el = document.querySelector(selector);
        return el ? el.getAttribute(attr) : null;
      };

      const poster = getAttr(".anime-poster img", "data-src");
      const cover = getAttr(".anime-cover", "data-src");
      const title = getText("h1 span");
      const japaneseTitle = getText("h2.japanese");
      const synopsis = getText(".anime-synopsis");

      const info = {};
      document.querySelectorAll(".anime-info p").forEach(p => {
        const strong = p.querySelector("strong");
        if (!strong) return;
        const key = strong.textContent.replace(":", "").trim().toLowerCase();
        const value = p.textContent.replace(strong.textContent, "").trim();
        info[key] = value;
      });

      const genres = Array.from(document.querySelectorAll(".anime-genre li a")).map(a => a.textContent.trim());
      const externalLinks = Array.from(document.querySelectorAll(".external-links a")).map(a => ({
        label: a.textContent.trim(),
        url: a.href
      }));

      return {
        title,
        japaneseTitle,
        synopsis,
        poster,
        cover,
        info,
        genres,
        externalLinks
      };
    });

    // Upload poster to UploadNX
    let uploadedPosterUrl = data.poster;
    if (data.poster) {
      try {
        const imgRes = await axios.get(data.poster, { responseType: "arraybuffer" });
        const form = new FormData();
        form.append("file", Buffer.from(imgRes.data), "poster.jpg");

        const uploadRes = await axios.post("https://uploadnx.zone.id/api/upload", form, {
          headers: form.getHeaders(),
        });

        if (uploadRes.data && uploadRes.data.short_url) {
          uploadedPosterUrl = uploadRes.data.short_url;
        }
      } catch (err) {
        console.error("Poster upload failed:", err.message);
      }
    }

    // Fetch total number of episodes
    const totalEpisodes = await page.evaluate(async (animeId) => {
      let total = 0;
      for (let pageNum = 1; pageNum <= 50; pageNum++) {
        const res = await fetch(`https://animepahe.si/api?m=release&id=${animeId}&page=${pageNum}`);
        if (!res.ok) break;
        const json = await res.json();
        if (!json || !json.data || json.data.length === 0) break;
        total += json.data.length;
      }
      return total;
    }, animeId);

    await browser.close();

    // Keep the same response structure
    res.json({
      ...data,
      poster: uploadedPosterUrl,
      animeId,
      totalEpisodes
    });

  } catch (err) {
    await browser.close();
    console.error("Anime info error:", err.message);
    res.status(500).json({ error: "Failed to fetch anime info." });
  }
});

app.get("/api/episode", async (req, res) => {
  const animeId = req.query.id;
  const episodeQuery = parseInt(req.query.episode);

  if (!animeId || isNaN(episodeQuery)) {
    return res.status(400).json({ error: "id and episode query parameters are required" });
  }

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  try {
    // Go directly to the anime page using the ID
    await page.goto(`https://animepahe.si/anime/${animeId}`, { waitUntil: "domcontentloaded" });

    // Verify the anime page loaded correctly
    const pageTitle = await page.title();
    if (pageTitle.includes("404") || pageTitle.includes("Not Found")) {
      await browser.close();
      return res.status(404).json({ error: "Anime not found" });
    }

    // Search for episode
    let found = null;
    for (let pageNum = 1; pageNum <= 50; pageNum++) {
      const data = await page.evaluate(async (animeId, pageNum) => {
        const apiUrl = `https://animepahe.si/api?m=release&id=${animeId}&page=${pageNum}&sort=episode_asc`;
        const res = await fetch(apiUrl);
        if (!res.ok) return null;
        return await res.json();
      }, animeId, pageNum);

      if (!data || !data.data) continue;

      const match = data.data.find((ep) => ep.episode == episodeQuery || ep.number == episodeQuery);
      if (match) {
        found = {
          episode: match.episode,
          snapshot: match.snapshot.replace(/\\\//g, "/"),
          session: match.session,
        };
        break;
      }
    }

    if (!found) {
      await browser.close();
      return res.status(404).json({ error: `Episode ${episodeQuery} not found.` });
    }

    // Upload snapshot to UploadNX
let uploadedSnapshot = found.snapshot;
if (found.snapshot) {
  try {
    const imgRes = await axios.get(found.snapshot, { responseType: "arraybuffer" });
    const form = new FormData();
    form.append("file", Buffer.from(imgRes.data), `snapshot-${Date.now()}.jpg`);

    const uploadRes = await axios.post("https://uploadnx.zone.id/api/upload", form, {
      headers: form.getHeaders(),
    });

    if (uploadRes.data && uploadRes.data.short_url) {
      uploadedSnapshot = uploadRes.data.short_url;
    }
  } catch (err) {
    console.error("Snapshot upload failed:", err.message);
  }
}

    const playUrl = `https://animepahe.si/play/${animeId}/${found.session}`;

    // Go to play page
    const playPage = await browser.newPage();
    await playPage.goto(playUrl, { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 5000));

    // Extract streaming & download links
    const links = await playPage.evaluate(() => {
      const result = { sub: {}, dub: {} };

      const streamButtons = document.querySelectorAll("#resolutionMenu button[data-src]");
      streamButtons.forEach((button) => {
        const quality = button.getAttribute("data-resolution") + "p";
        const audio = button.getAttribute("data-audio");
        const url = button.getAttribute("data-src");
        if (audio === "jpn") result.sub[quality] = url;
        else if (audio === "eng") result.dub[quality] = url;
      });

      const downloadLinks = document.querySelectorAll('#pickDownload a[href*="pahe.win"]');
      downloadLinks.forEach((a) => {
        const text = a.innerText.trim().toLowerCase();
        const href = a.href;
        const isDub = text.includes("eng");

        if (text.includes("360")) {
          if (isDub) result.dub["360p_download"] = href;
          else result.sub["360p_download"] = href;
        } else if (text.includes("480")) {
          if (isDub) result.dub["480p_download"] = href;
          else result.sub["480p_download"] = href;
        } else if (text.includes("720")) {
          if (isDub) result.dub["720p_download"] = href;
          else result.sub["720p_download"] = href;
        } else if (text.includes("1080")) {
          if (isDub) result.dub["1080p_download"] = href;
          else result.sub["1080p_download"] = href;
        }
      });

      return result;
    });

    await playPage.close();
    await browser.close();

    return res.json({
      animeId,
      episode: found.episode,
      snapshot: uploadedSnapshot,
      playUrl,
      links,
    });
  } catch (err) {
    await browser.close();
    console.error("Episode info error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/resolvex', async (req, res) => {
  const inputURL = req.query.url;
  
  console.log('=== RESOLVEX REQUEST STARTED ===');
  console.log('Input URL:', inputURL);
  
  if (!inputURL) {
    console.log('❌ ERROR: No URL provided');
    return res.status(400).json({ error: 'Missing URL parameter' });
  }

  const isPaheURL = inputURL.startsWith('https://pahe.win/');
  const isKwikURL = inputURL.includes('kwik.cx/');
  
  if (!isPaheURL && !isKwikURL) {
    console.log('❌ ERROR: Invalid URL - must be pahe.win or kwik.cx');
    return res.status(400).json({ error: 'Invalid URL - must be pahe.win or kwik.cx URL' });
  }

  console.log('URL Type:', isPaheURL ? 'pahe.win' : 'kwik.cx');

  let browser;
  try {
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

    const heavySpoofFingerprint = async (page) => {
      console.log('🔧 Setting up HEAVY browser fingerprint spoofing...');
      
      // Set realistic user agent
      const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
      await page.setUserAgent(userAgent);
      console.log('✅ User Agent set:', userAgent);
      
      // Set viewport
      await page.setViewport({ 
        width: 1920, 
        height: 1080,
        deviceScaleFactor: 1,
        hasTouch: false,
        isLandscape: true,
        isMobile: false
      });
      console.log('✅ Viewport configured: 1920x1080');
      
      // Set extra HTTP headers
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Cache-Control': 'max-age=0',
        'DNT': '1'
      });
      console.log('✅ Extra HTTP headers set');
      
      // Heavy JavaScript evasion techniques
      await page.evaluateOnNewDocument(() => {
        // Webdriver
        Object.defineProperty(navigator, 'webdriver', {
          get: () => false
        });
        
        // Chrome object
        window.chrome = {
          runtime: {},
          loadTimes: function() {},
          csi: function() {},
          app: {}
        };
        
        // Permissions
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) => (
          parameters.name === 'notifications' ?
            Promise.resolve({ state: Notification.permission }) :
            originalQuery(parameters)
        );
        
        // Plugins
        Object.defineProperty(navigator, 'plugins', {
          get: () => [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
            { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
          ]
        });
        
        // Languages
        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en']
        });
        
        // Platform
        Object.defineProperty(navigator, 'platform', {
          get: () => 'Win32'
        });
        
        // Hardware concurrency
        Object.defineProperty(navigator, 'hardwareConcurrency', {
          get: () => 8
        });
        
        // Device memory
        Object.defineProperty(navigator, 'deviceMemory', {
          get: () => 8
        });
        
        // Vendor
        Object.defineProperty(navigator, 'vendor', {
          get: () => 'Google Inc.'
        });
        
        // MaxTouchPoints
        Object.defineProperty(navigator, 'maxTouchPoints', {
          get: () => 0
        });
        
        // Media devices
        if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
          navigator.mediaDevices.enumerateDevices = () => Promise.resolve([
            { kind: 'audioinput', deviceId: 'default', label: '', groupId: '' },
            { kind: 'videoinput', deviceId: 'default', label: '', groupId: '' }
          ]);
        }
        
        // WebGL
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(parameter) {
          if (parameter === 37445) {
            return 'Intel Inc.';
          }
          if (parameter === 37446) {
            return 'Intel Iris OpenGL Engine';
          }
          return getParameter.apply(this, [parameter]);
        };
        
        // Battery
        if (navigator.getBattery) {
          navigator.getBattery = () => Promise.resolve({
            charging: true,
            chargingTime: 0,
            dischargingTime: Infinity,
            level: 1
          });
        }
        
        // Connection
        Object.defineProperty(navigator, 'connection', {
          get: () => ({
            effectiveType: '4g',
            rtt: 50,
            downlink: 10,
            saveData: false
          })
        });
        
        // Timezone
        const originalDateTimeFormat = Intl.DateTimeFormat;
        Intl.DateTimeFormat = function(...args) {
          return originalDateTimeFormat.apply(this, args);
        };
        Intl.DateTimeFormat.prototype = originalDateTimeFormat.prototype;
        
        // Screen
        Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
        Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });
        
        // Override toString
        const originalToString = Function.prototype.toString;
        Function.prototype.toString = function() {
          if (this === navigator.permissions.query) {
            return 'function query() { [native code] }';
          }
          if (this === navigator.mediaDevices.enumerateDevices) {
            return 'function enumerateDevices() { [native code] }';
          }
          return originalToString.call(this);
        };
        
        // Window size matches screen size
        Object.defineProperty(window, 'outerWidth', { get: () => window.screen.width });
        Object.defineProperty(window, 'outerHeight', { get: () => window.screen.height });
        
        // Remove headless indicators
        delete navigator.__proto__.webdriver;
        
        // Canvas fingerprint noise
        const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
        HTMLCanvasElement.prototype.toDataURL = function(type) {
          const context = this.getContext('2d');
          if (context) {
            const imageData = context.getImageData(0, 0, this.width, this.height);
            for (let i = 0; i < imageData.data.length; i += 4) {
              imageData.data[i] += Math.floor(Math.random() * 3) - 1;
              imageData.data[i + 1] += Math.floor(Math.random() * 3) - 1;
              imageData.data[i + 2] += Math.floor(Math.random() * 3) - 1;
            }
            context.putImageData(imageData, 0, 0);
          }
          return originalToDataURL.apply(this, [type]);
        };
        
        console.log('Heavy spoofing applied');
      });
      console.log('✅ Heavy JavaScript evasion techniques applied');
    };

    const randomScroll = async (page) => {
      console.log('📜 Performing random scroll...');
      await page.evaluate(() => {
        return new Promise(resolve => {
          let totalHeight = 0;
          const distance = Math.floor(Math.random() * 100) + 100;
          const timer = setInterval(() => {
            const scrollAmount = Math.floor(Math.random() * 50) + distance;
            window.scrollBy(0, scrollAmount);
            totalHeight += scrollAmount;
            if (totalHeight >= document.body.scrollHeight) {
              clearInterval(timer);
              resolve();
            }
          }, Math.floor(Math.random() * 100) + 150);
        });
      });
      console.log('✅ Scroll completed');
    };

    const randomMouseMovement = async (page) => {
      console.log('🖱️  Simulating random mouse movements...');
      await page.evaluate(() => {
        for (let i = 0; i < 5; i++) {
          const x = Math.floor(Math.random() * window.innerWidth);
          const y = Math.floor(Math.random() * window.innerHeight);
          const event = new MouseEvent('mousemove', {
            clientX: x,
            clientY: y,
            bubbles: true
          });
          document.dispatchEvent(event);
        }
      });
      console.log('✅ Mouse movements simulated');
    };

    console.log('🚀 Launching Puppeteer browser with stealth mode...');
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--window-size=1920,1080',
        '--disable-infobars',
        '--disable-notifications',
        '--disable-popup-blocking'
      ],
      ignoreHTTPSErrors: true,
      defaultViewport: null
    });
    console.log('✅ Browser launched with stealth arguments');

    const page = await browser.newPage();
    await heavySpoofFingerprint(page);

    let kwikLink = null;

    // Step 1: Handle pahe.win URL (if applicable)
    if (isPaheURL) {
      console.log('\n=== STEP 1: NAVIGATING TO PAHE.WIN ===');
      console.log('Target URL:', inputURL);
      
      const paheResponse = await page.goto(inputURL, { 
        waitUntil: 'networkidle2',
        timeout: 60000
      });
      console.log('📡 Response Status:', paheResponse.status());
      console.log('✅ Page loaded successfully');
      
      console.log('⏳ Waiting 3000ms...');
      await delay(3000);
      
      await randomMouseMovement(page);
      await randomScroll(page);
      
      console.log('⏳ Waiting 2000ms...');
      await delay(2000);

      // Step 2: Extract kwik.cx link
      console.log('\n=== STEP 2: EXTRACTING KWIK.CX LINK ===');
      kwikLink = await page.$$eval('a.btn.btn-secondary.btn-block.redirect', links =>
        links.find(a => a.href.includes('kwik.cx/f') || a.href.includes('kwik.cx/d'))?.href
      );
      
      if (!kwikLink) {
        console.log('❌ ERROR: kwik.cx link not found on pahe.win');
        throw new Error('kwik.cx link not found on pahe.win');
      }
      
      console.log('✅ Kwik link found:', kwikLink);

      // Convert /d/ to /f/ if detected
      if (kwikLink.includes('/d/')) {
        console.log('🔄 Detected /d/ URL, converting to /f/');
        kwikLink = kwikLink.replace('/d/', '/f/');
        console.log('✅ Converted URL:', kwikLink);
      }
    } else {
      // Direct kwik.cx URL
      console.log('\n=== STEP 1: USING DIRECT KWIK.CX LINK ===');
      kwikLink = inputURL;
      console.log('Kwik link:', kwikLink);
      
      // Convert /d/ to /f/ if detected
      if (kwikLink.includes('/d/')) {
        console.log('🔄 Detected /d/ URL, converting to /f/');
        kwikLink = kwikLink.replace('/d/', '/f/');
        console.log('✅ Converted URL:', kwikLink);
      }
    }

    let mp4Url = null;
    let mp4UrlFound = false;

    // Step 3: Set up interception
    console.log('\n=== STEP 3: SETTING UP REQUEST/RESPONSE INTERCEPTION ===');
    await page.setRequestInterception(true);
    
    page.on('request', request => {
      const url = request.url();
      
      // Block unnecessary resources to speed up and avoid detection
      const blockedResources = ['image', 'stylesheet', 'font', 'media'];
      if (blockedResources.includes(request.resourceType())) {
        request.abort();
        return;
      }
      
      if (url.endsWith('.mp4') && (
        url.includes('cdn') || url.includes('vault') || url.includes('eu') ||
        url.includes('bunny') || url.includes('nextcdn') ||
        url.match(/\.(mp4)(\?|$)/i)
      )) {
        mp4Url = url;
        mp4UrlFound = true;
        console.log('🎥 MP4 URL CAPTURED (request):', url);
      }
      request.continue();
    });

    page.on('response', response => {
      const url = response.url();
      const status = response.status();

      // Log all responses with status codes
      if (url.endsWith('.mp4') || url.includes('kwik') || status >= 300) {
        console.log(`📡 Response: ${status} - ${url.substring(0, 100)}${url.length > 100 ? '...' : ''}`);
      }

      if (status >= 300 && status < 400) {
        const location = response.headers()['location'];
        if (location && location.endsWith('.mp4')) {
          mp4Url = location;
          mp4UrlFound = true;
          console.log('🎥 MP4 URL CAPTURED (redirect):', location);
          console.log('📡 Redirect Status:', status);
        }
      }
      if (url.endsWith('.mp4')) {
        mp4Url = url;
        mp4UrlFound = true;
        console.log('🎥 MP4 URL CAPTURED (response):', url);
        console.log('📡 Response Status:', status);
      }
    });
    
    console.log('✅ Interception configured');

    // Step 4: Navigate to kwik.cx and click button
    console.log('\n=== STEP 4: NAVIGATING TO KWIK.CX ===');
    console.log('Target URL:', kwikLink);
    
    const kwikResponse = await page.goto(kwikLink, { 
      waitUntil: 'domcontentloaded',
      timeout: 60000 
    });
    console.log('📡 Response Status:', kwikResponse.status());
    
    if (kwikResponse.status() === 403) {
      console.log('⚠️  Got 403, waiting for Cloudflare challenge...');
      await delay(5000);
      
      // Wait for Cloudflare challenge to complete
      await page.waitForNavigation({ 
        waitUntil: 'networkidle2', 
        timeout: 30000 
      }).catch(() => console.log('⚠️  Navigation timeout, continuing...'));
      
      console.log('📍 Current URL after challenge:', page.url());
    }
    
    console.log('✅ Page loaded');
    
    console.log('⏳ Waiting 4000ms for page to stabilize...');
    await delay(4000);
    
    await randomMouseMovement(page);
    await delay(1000);

    console.log('\n=== STEP 5: CLICKING DOWNLOAD BUTTON ===');
    const buttonSelector = 'button.button.is-uppercase.is-success.is-fullwidth';
    console.log('Looking for button:', buttonSelector);
    
    try {
      await page.waitForSelector(buttonSelector, { timeout: 20000 });
      console.log('✅ Button found');
      
      // Simulate human-like click
      await randomMouseMovement(page);
      await delay(500);
      
      await page.click(buttonSelector);
      console.log('✅ Button clicked');
    } catch (e) {
      console.log('⚠️  Button not found, trying alternative methods...');
      
      // Try clicking by evaluating JavaScript
      const clicked = await page.evaluate((sel) => {
        const btn = document.querySelector(sel);
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      }, buttonSelector);
      
      if (clicked) {
        console.log('✅ Button clicked via JavaScript');
      } else {
        console.log('❌ Could not find button');
      }
    }

    // Check if redirected to /d/ after button click
    console.log('⏳ Waiting 3000ms...');
    await delay(3000);
    
    let currentUrl = page.url();
    console.log('📍 Current URL after button click:', currentUrl);

    if (currentUrl.includes('/d/')) {
      console.log('🔄 Detected /d/ redirect, converting to /f/ and reloading');
      const fixedUrl = currentUrl.replace('/d/', '/f/');
      console.log('New URL:', fixedUrl);
      
      try {
        const reloadResponse = await page.goto(fixedUrl, { 
          waitUntil: 'domcontentloaded',
          timeout: 60000 
        });
        console.log('📡 Reload Response Status:', reloadResponse.status());
        
        if (reloadResponse.status() === 403) {
          console.log('⚠️  Got 403 on reload, waiting for Cloudflare...');
          await delay(5000);
          
          await page.waitForNavigation({ 
            waitUntil: 'networkidle2', 
            timeout: 30000 
          }).catch(() => console.log('⚠️  Navigation timeout, continuing...'));
        }
        
        console.log('⏳ Waiting 3000ms...');
        await delay(3000);
        console.log('✅ Reloaded with /f/ URL');
      } catch (e) {
        console.log('⚠️  Error reloading:', e.message);
      }
    }

    // Step 6: Extended sniffing & retries
    console.log('\n=== STEP 6: MONITORING FOR MP4 URL ===');
    let waitTime = 0;
    const maxWaitTime = 45000;

    while (!mp4UrlFound && waitTime < maxWaitTime) {
      await delay(1000);
      waitTime += 1000;

      if (waitTime % 5000 === 0) {
        console.log(`⏱️  Monitoring... (${waitTime}ms / ${maxWaitTime}ms)`);
        
        try {
          const currentUrl = page.url();
          console.log('📍 Current page URL:', currentUrl);

          if (currentUrl.endsWith('.mp4') && (
            currentUrl.includes('cdn') || currentUrl.includes('vault') || 
            currentUrl.includes('eu') || currentUrl.includes('nextcdn') ||
            currentUrl.includes('bunny')
          )) {
            mp4Url = currentUrl;
            mp4UrlFound = true;
            console.log('🎥 DIRECT MP4 URL FOUND:', currentUrl);
            break;
          }

          console.log('🔍 Scanning page content for MP4 URLs...');
          const pageContent = await page.content();
          const mp4Match = pageContent.match(/(https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*)/gi);
          
          if (mp4Match && mp4Match.length > 0) {
            console.log(`📋 Found ${mp4Match.length} potential MP4 URL(s) in content`);
            const found = mp4Match.find(match =>
              match.includes('cdn') || match.includes('vault') ||
              match.includes('eu') || match.includes('nextcdn') ||
              match.includes('bunny')
            );
            if (found) {
              mp4Url = found;
              mp4UrlFound = true;
              console.log('🎥 MP4 URL FOUND in page content:', mp4Url);
              break;
            }
          }
          
          // Additional method: check for video elements
          const videoSrc = await page.evaluate(() => {
            const video = document.querySelector('video');
            return video ? video.src : null;
          });
          
          if (videoSrc && videoSrc.endsWith('.mp4')) {
            mp4Url = videoSrc;
            mp4UrlFound = true;
            console.log('🎥 MP4 URL FOUND from video element:', videoSrc);
            break;
          }
          
        } catch (err) {
          console.log('⚠️  Error during periodic check:', err.message);
        }
      }
    }

    if (!mp4UrlFound || !mp4Url) {
      console.log('❌ FAILED: No valid MP4 URL found after monitoring');
      
      // Last attempt: take screenshot for debugging
      const screenshot = await page.screenshot({ encoding: 'base64' });
      console.log('📸 Screenshot taken (base64 length):', screenshot.length);
      
      throw new Error('Failed to find a valid MP4 URL');
    }

    console.log('\n=== SUCCESS ===');
    console.log('✅ Kwik Link:', kwikLink);
    console.log('✅ MP4 Link:', mp4Url);

    const response = { kwikLink, mp4Link: mp4Url };
    
    console.log('🔒 Closing browser...');
    await browser.close();
    console.log('✅ Browser closed');
    
    console.log('📤 Sending response with status 200');
    console.log('=== RESOLVEX REQUEST COMPLETED ===\n');
    
    return res.status(200).json(response);

  } catch (err) {
    console.log('\n=== ERROR OCCURRED ===');
    console.error('❌ Error in resolvex:', err.message);
    console.error('Stack trace:', err.stack);
    
    if (browser) {
      console.log('🔒 Closing browser due to error...');
      await browser.close();
      console.log('✅ Browser closed');
    }
    
    console.log('📤 Sending error response with status 500');
    console.log('=== RESOLVEX REQUEST FAILED ===\n');
    
    return res.status(500).json({ error: err.message });
  }
});
app.get('/getDownload', async (req, res) => {
    const { moviename, episode } = req.query;
    if (!moviename) {
        return res.status(400).json({ error: "moviename query parameter is required" });
    }

    const searchQuery = moviename.trim();
    const episodeFilter = episode ? episode.trim() : null;
    const searchUrl = `https://nkiri.com/?s=${encodeURIComponent(searchQuery)}`;

    console.log("\n🔍 Searching for:", searchQuery);

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-setuid-sandbox", "--ignore-certificate-errors"]
        });

        const page = await browser.newPage();
        await page.goto(searchUrl, { waitUntil: "networkidle2" });

        // Extract first movie link
        await page.waitForSelector("article.post a, h2.entry-title a", { timeout: 10000 });
        const firstMovieLink = await page.evaluate(() => {
            const el = document.querySelector("article.post a, h2.entry-title a");
            return el ? el.href : null;
        });

        if (!firstMovieLink) {
            await browser.close();
            return res.status(404).json({ error: "No movie found" });
        }

        console.log("\n✅ First Movie Page Found:", firstMovieLink);

        // ===========================
        // 2️⃣ GET DOWNLOAD LINKS FROM MOVIE PAGE
        // ===========================
        await page.goto(firstMovieLink, { waitUntil: "networkidle2" });
        const moviePageHtml = await page.content();
        const $movie = cheerio.load(moviePageHtml);

        let downloadLinks = [];
        const videoExtensions = [".mkv", ".mp4", ".mov", ".avi"];

        $movie("a").each((i, el) => {
            const link = $movie(el).attr("href");
            if (
                link &&
                (link.includes("downloadwella.com") ||
                    link.includes("wetafiles.com") ||
                    videoExtensions.some(ext => link.endsWith(ext)))
            ) {
                downloadLinks.push(link);
            }
        });

        if (downloadLinks.length === 0) {
            await browser.close();
            return res.status(404).json({ error: "No valid download links found" });
        }

        let selectedLink = downloadLinks[0];
        if (downloadLinks.length > 1 && episodeFilter) {
            const filteredLinks = downloadLinks.filter(link =>
                link.includes(`E${episodeFilter}`) || link.includes(`e${episodeFilter}`)
            );
            if (filteredLinks.length > 0) {
                selectedLink = filteredLinks[0];
            }
        }

        console.log("\n✅ Selected Download Link:", selectedLink);

        // Extract movie name from filename
        const filename = selectedLink.split("/").pop();
        const movieTitle = filename
            .replace(/\.(mkv|mp4|mov|avi).*$/, "")
            .replace(/[\.\-_\(\)]/g, " ")
            .trim();

        // ===========================
        // 3️⃣ HANDLE FINAL DOWNLOAD LINK (STILL PUPPETEER)
        // ===========================
        if (videoExtensions.some(ext => selectedLink.endsWith(ext))) {
            await browser.close();
            return res.json({
                movie: movieTitle,
                finalDownloadUrl: selectedLink
            });
        }

        // Open intermediate page
        await page.goto(selectedLink, { waitUntil: "networkidle2" });

        // Wait for "Create Download Link" button
        await page.waitForSelector("#downloadbtn", { timeout: 15000 });
        console.log("\n✅ Download button found, clicking...");

        let finalDownloadUrl = null;
        page.on("response", async (response) => {
            const requestUrl = response.url();
            if (requestUrl.includes("/d/") && videoExtensions.some(ext => requestUrl.endsWith(ext))) {
                finalDownloadUrl = requestUrl;
                console.log("\n✅ FINAL DOWNLOAD LINK:", finalDownloadUrl);
            }
        });

        // Click the button
        await page.evaluate(() => document.querySelector("#downloadbtn").click());

        // Give time for redirects
        await new Promise(resolve => setTimeout(resolve, 10000));

        await browser.close();

        if (!finalDownloadUrl) {
            return res.status(404).json({ error: "Failed to extract final download link" });
        }

        res.json({
            movie: movieTitle,
            finalDownloadUrl
        });

    } catch (error) {
        console.error("\n❌ Error:", error.message);
        if (browser) await browser.close();
        res.status(500).json({ error: "Internal server error" });
    }
});

const clientId = 'ae3ec3332d1b4500bbef0f6952ea6805';
const clientSecret = 'dc03110d119d40bdab1f23461e004c31';

async function getAccessToken() {
  const authString = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  try {
    const response = await axios.post('https://accounts.spotify.com/api/token', 
      'grant_type=client_credentials', 
      {
        headers: {
          'Authorization': `Basic ${authString}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        }
      }
    );
    return response.data.access_token;
  } catch (error) {
    console.error('Failed to get access token:', error.response ? error.response.data : error.message);
    throw error;
  }
}


app.get('/song', async (req, res) => {
  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: 'Missing query parameter q' });
  }

  try {
    const token = await getAccessToken();

    const response = await axios.get('https://api.spotify.com/v1/search', {
      params: {
        q: query,
        type: 'track',
        limit: 1,
        include_external: 'audio'
      },
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    const track = response.data.tracks.items[0];
    if (!track) {
      return res.status(404).json({ error: 'No tracks found' });
    }

    // Construct the JSON response
    const result = {
      title: track.name,
      id: track.id,
      artists: track.artists.map(a => a.name),
      album: track.album.name,
      duration_seconds: Math.floor(track.duration_ms / 1000),
      popularity: track.popularity,
      release_date: track.album.release_date,
      spotify_url: track.external_urls.spotify,
      preview_available: Boolean(track.preview_url),
      explicit: track.explicit,
      album_type: track.album.album_type,
      total_tracks_in_album: track.album.total_tracks,
      track_number: track.track_number,
      isrc: track.external_ids.isrc,
      available_markets_count: track.available_markets.length
    };

    res.json(result);

  } catch (error) {
    console.error('Error fetching track:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'Failed to fetch track' });
  }
});

app.get('/spotify', async (req, res) => {
    const spotifyUrl = req.query.url;

    if (!spotifyUrl) {
        return res.status(400).json({ error: "Missing 'url' query parameter" });
    }

    let browser;
    let downloadUrl = null;

    try {
        browser = await puppeteer.launch({
            headless: true,
            defaultViewport: null,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled'
            ]
        });

        const page = await browser.newPage();

        // 🛡️ Extreme Fingerprint Spoofing
        await page.evaluateOnNewDocument(() => {
            // --- Navigator overrides ---
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
            Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
            Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

            // --- Plugins spoof ---
            Object.defineProperty(navigator, 'plugins', {
                get: () => [
                    { name: 'Chrome PDF Plugin' },
                    { name: 'Chrome PDF Viewer' },
                    { name: 'Native Client' }
                ]
            });

            // --- Permissions spoof ---
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) =>
                parameters.name === 'notifications'
                    ? Promise.resolve({ state: Notification.permission })
                    : originalQuery(parameters);

            // --- Screen + Touch ---
            Object.defineProperty(window, 'innerWidth', { get: () => 1920 });
            Object.defineProperty(window, 'innerHeight', { get: () => 1080 });
            Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 1 });

            // --- WebGL spoof ---
            const getParameter = WebGLRenderingContext.prototype.getParameter;
            WebGLRenderingContext.prototype.getParameter = function(parameter) {
                if (parameter === 37445) return 'Intel Inc.';
                if (parameter === 37446) return 'Intel Iris OpenGL Engine';
                return getParameter.call(this, parameter);
            };
            if (window.WebGL2RenderingContext) {
                const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
                WebGL2RenderingContext.prototype.getParameter = function(parameter) {
                    if (parameter === 37445) return 'Intel Inc.';
                    if (parameter === 37446) return 'Intel Iris OpenGL Engine';
                    return getParameter2.call(this, parameter);
                };
            }

            // --- Media devices spoof ---
            navigator.mediaDevices = {
                enumerateDevices: () => Promise.resolve([
                    { kind: 'audioinput', label: 'Default Microphone', deviceId: 'default' },
                    { kind: 'videoinput', label: 'HD Webcam', deviceId: 'webcam1' },
                    { kind: 'audiooutput', label: 'Default Speakers', deviceId: 'default' }
                ])
            };

            // --- Battery API spoof ---
            navigator.getBattery = () =>
                Promise.resolve({
                    charging: true,
                    chargingTime: 0,
                    dischargingTime: Infinity,
                    level: 1.0,
                    onchargingchange: null,
                    onchargingtimechange: null,
                    ondischargingtimechange: null,
                    onlevelchange: null
                });

            // --- Clipboard API spoof ---
            navigator.clipboard = {
                readText: () => Promise.resolve(''),
                writeText: () => Promise.resolve()
            };

            // --- Geolocation spoof ---
            navigator.geolocation.getCurrentPosition = (success) => {
                success({
                    coords: {
                        latitude: 40.7128,
                        longitude: -74.0060,
                        accuracy: 10
                    }
                });
            };

            // --- Network info spoof ---
            navigator.connection = {
                downlink: 10,
                effectiveType: '4g',
                rtt: 50,
                saveData: false
            };

            // --- SpeechSynthesis spoof ---
            window.speechSynthesis = {
                getVoices: () => [
                    { name: 'Google US English', lang: 'en-US' }
                ]
            };
        });

        // Custom UA + headers
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36'
        );
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'DNT': '1',
            'Upgrade-Insecure-Requests': '1'
        });

        // Capture API request
        page.on('response', async (response) => {
            const url = response.url();
            if (url.includes('/api/composer/')) {
                try {
                    const json = await response.json();
                    if (json.dlink) {
                        downloadUrl = json.dlink;
                        console.log("🎯 Found download URL:", downloadUrl);
                    }
                } catch (err) {
                    console.error("Error parsing JSON:", err);
                }
            }
        });

        // Visit site
        await page.goto('https://spotisongdownloader.to', { waitUntil: 'networkidle2' });

        // Simulate random human actions
        await page.evaluate(() => window.focus());
        for (let i = 0; i < 3; i++) {
            await page.mouse.move(Math.random() * 800, Math.random() * 600, { steps: 10 });
            await page.mouse.wheel({ deltaY: Math.random() * 200 });
            await new Promise(r => setTimeout(r, 200 + Math.random() * 200));
        }

        // Type URL like a human
        await page.waitForSelector('#id_url', { visible: true });
        for (const char of spotifyUrl) {
            await page.type('#id_url', char, { delay: Math.floor(Math.random() * 80) + 50 });
        }
        await new Promise(r => setTimeout(r, 400));

        // Click download
        const submitBtn = await page.$('#submit');
        const box = await submitBtn.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
        await new Promise(r => setTimeout(r, 200));
        await submitBtn.click();

        // While waiting for navigation, wander the mouse
        await Promise.race([
            page.waitForNavigation({ waitUntil: 'networkidle2' }),
            (async () => {
                for (let i = 0; i < 6; i++) {
                    await page.mouse.move(Math.random() * 900, Math.random() * 700, { steps: 4 });
                    await page.mouse.wheel({ deltaY: Math.random() * 400 });
                    await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
                }
            })()
        ]);

        // Scroll + focus again
        await page.mouse.wheel({ deltaY: 300 });
        await page.evaluate(() => window.focus());

        // Click "Generate Download Link"
        await page.waitForSelector('a.button.is-primary[dlink]', { visible: true });
        const genBtn = await page.$('a.button.is-primary[dlink]');
        const genBox = await genBtn.boundingBox();
        await page.mouse.move(genBox.x + genBox.width / 2, genBox.y + genBox.height / 2, { steps: 5 });
        await genBtn.click();

        // Pick m4a
        await page.waitForSelector('select[name="qcars"]', { visible: true });
        await page.select('select[name="qcars"]', 'm4a');

        // Wait for API
        console.log("⏳ Waiting for /api/composer request...");
        const maxWaitTime = 15000;
        const start = Date.now();
        while (!downloadUrl && Date.now() - start < maxWaitTime) {
            await new Promise(r => setTimeout(r, 200));
        }

        if (downloadUrl) {
            return res.json({ success: true, downloadUrl });
        } else {
            return res.status(500).json({ success: false, error: "Failed to capture download link" });
        }

    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
    } finally {
        if (browser) {
            await browser.close();
        }
    }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
