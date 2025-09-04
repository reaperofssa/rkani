// server.js
const express = require("express");
const axios = require("axios");
const puppeteer = require("puppeteer");
const stringSimilarity = require("string-similarity");
const app = express();
const PORT = 7860;

app.get("/search", async (req, res) => {
  const animeQuery = req.query.q || "Naruto";

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto('https://animepahe.ru/anime', { waitUntil: 'domcontentloaded' });
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

  if (!url || !url.startsWith("https://animepahe.ru/anime/")) {
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

    // Fetch total number of episodes using fetch inside browser context
    const totalEpisodes = await page.evaluate(async (animeId) => {
      let total = 0;
      for (let pageNum = 1; pageNum <= 50; pageNum++) {
        const res = await fetch(`https://animepahe.ru/api?m=release&id=${animeId}&page=${pageNum}`);
        if (!res.ok) break;
        const json = await res.json();
        if (!json || !json.data || json.data.length === 0) break;
        total += json.data.length;
      }
      return total;
    }, animeId);

    await browser.close();

    res.json({
      ...data,
      animeId,
      totalEpisodes
    });

  } catch (err) {
    await browser.close();
    console.error("Anime info error:", err.message);
    res.status(500).json({ error: "Failed to fetch anime info." });
  }
});

app.get('/api/episode', async (req, res) => {
  const animeId = req.query.id;
  const episodeQuery = parseInt(req.query.episode);

  if (!animeId || isNaN(episodeQuery)) {
    return res.status(400).json({ error: 'id and episode query parameters are required' });
  }

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  try {
    // Go directly to the anime page using the ID
    await page.goto(`https://animepahe.ru/anime/${animeId}`, { waitUntil: 'domcontentloaded' });

    // Verify the anime page loaded correctly
    const pageTitle = await page.title();
    if (pageTitle.includes('404') || pageTitle.includes('Not Found')) {
      await browser.close();
      return res.status(404).json({ error: 'Anime not found' });
    }

    // Search for episode
    let found = null;
    for (let pageNum = 1; pageNum <= 50; pageNum++) {
      const data = await page.evaluate(async (animeId, pageNum) => {
        const apiUrl = `https://animepahe.ru/api?m=release&id=${animeId}&page=${pageNum}&sort=episode_asc`;
        const res = await fetch(apiUrl);
        if (!res.ok) return null;
        return await res.json();
      }, animeId, pageNum);

      if (!data || !data.data) continue;

      const match = data.data.find(ep => ep.episode == episodeQuery || ep.number == episodeQuery);
      if (match) {
        found = {
          episode: match.episode,
          snapshot: match.snapshot.replace(/\\\//g, '/'),
          session: match.session
        };
        break;
      }
    }

    if (!found) {
      await browser.close();
      return res.status(404).json({ error: `Episode ${episodeQuery} not found.` });
    }

    const playUrl = `https://animepahe.ru/play/${animeId}/${found.session}`;

    // Go to play page
    const playPage = await browser.newPage();
    await playPage.goto(playUrl, { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 5000));

    // Extractxx and organize links by quality and audio type
    const links = await playPage.evaluate(() => {
      const result = {
        sub: {},
        dub: {}
      };
      
      // Extract streaming links (kwik.si)
      const streamButtons = document.querySelectorAll('#resolutionMenu button[data-src]');
      streamButtons.forEach(button => {
        const quality = button.getAttribute('data-resolution') + 'p';
        const audio = button.getAttribute('data-audio');
        const url = button.getAttribute('data-src');
        
        if (audio === 'jpn') {
          result.sub[quality] = url;
        } else if (audio === 'eng') {
          result.dub[quality] = url;
        }
      });
      
      // Extract download links (pahe.win)
      const downloadLinks = document.querySelectorAll('#pickDownload a[href*="pahe.win"]');
      downloadLinks.forEach(a => {
        const text = a.innerText.trim().toLowerCase();
        const href = a.href;
        const isDub = text.includes('eng');
        
        if (text.includes('360')) {
          if (isDub) result.dub['360p_download'] = href;
          else result.sub['360p_download'] = href;
        } 
        else if (text.includes('480')) {
          if (isDub) result.dub['480p_download'] = href;
          else result.sub['480p_download'] = href;
        }
        else if (text.includes('720')) {
          if (isDub) result.dub['720p_download'] = href;
          else result.sub['720p_download'] = href;
        }
        else if (text.includes('1080')) {
          if (isDub) result.dub['1080p_download'] = href;
          else result.sub['1080p_download'] = href;
        }
      });
      
      return result;
    });

    await playPage.close();
    await browser.close();

    return res.json({
      animeId,
      episode: found.episode,
      snapshot: found.snapshot, // Using the original snapshot URL directly
      playUrl,
      links
    });

  } catch (err) {
    await browser.close();
    return res.status(500).json({ error: err.message });
  }
});

app.get('/resolvex', async (req, res) => {
  const paheURL = req.query.url;
  if (!paheURL || !paheURL.startsWith('https://pahe.win/')) {
    return res.status(400).json({ error: 'Invalid or missing pahe.win URL' });
  }

  let browser;
  try {
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

    const spoofFingerprint = async (page) => {
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/114.0.0.0 Safari/537.36');
      await page.setViewport({ width: 1366, height: 768 });
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        window.chrome = { runtime: {} };
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
      });
    };

    const randomScroll = async (page) => {
      await page.evaluate(() => {
        return new Promise(resolve => {
          let totalHeight = 0;
          const distance = 150;
          const timer = setInterval(() => {
            window.scrollBy(0, distance);
            totalHeight += distance;
            if (totalHeight >= document.body.scrollHeight) {
              clearInterval(timer);
              resolve();
            }
          }, 200);
        });
      });
    };

    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await spoofFingerprint(page);

    // Step 1: Navigate to pahe.win
    await page.goto(paheURL, { waitUntil: 'networkidle2' });
    await delay(2500);
    await randomScroll(page);
    await delay(1500);

    // Step 2: Extract kwik.si link
    const kwikLink = await page.$$eval('a.btn.btn-secondary.btn-block.redirect', links =>
      links.find(a => a.href.includes('kwik.si'))?.href
    );
    if (!kwikLink) throw new Error('kwik.si link not found on pahe.win');

    let mp4Url = null;
    let mp4UrlFound = false;

    // Step 3: Intercept requests & responses
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = request.url();
      if (url.endsWith('.mp4') && (
        url.includes('cdn') || url.includes('vault') || url.includes('eu') ||
        url.includes('bunny') || url.includes('nextcdn') ||
        url.match(/\.(mp4)(\?|$)/i)
      )) {
        mp4Url = url;
        mp4UrlFound = true;
        console.log('MP4 URL captured:', url);
      }
      request.continue();
    });

    page.on('response', response => {
      const url = response.url();
      const status = response.status();

      if (status >= 300 && status < 400) {
        const location = response.headers()['location'];
        if (location && location.endsWith('.mp4')) {
          mp4Url = location;
          mp4UrlFound = true;
          console.log('MP4 URL from redirect:', location);
        }
      }
      if (url.endsWith('.mp4')) {
        mp4Url = url;
        mp4UrlFound = true;
        console.log('MP4 URL from response:', url);
      }
    });

    // Step 4: Go to kwik.si and click the button
    await page.goto(kwikLink, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(2000);

    const buttonSelector = 'button.button.is-uppercase.is-success.is-fullwidth';
    await page.waitForSelector(buttonSelector, { timeout: 15000 });
    await page.click(buttonSelector);
    console.log('Clicked Kwik.si button');

    // Step 5: Extended sniffing & retries
    let waitTime = 0;
    const maxWaitTime = 30000;

    while (!mp4UrlFound && waitTime < maxWaitTime) {
      await delay(1000);
      waitTime += 1000;

      if (waitTime % 5000 === 0) {
        try {
          const currentUrl = page.url();
          console.log('Current page URL:', currentUrl);

          if (currentUrl.endsWith('.mp4') && (
            currentUrl.includes('cdn') || currentUrl.includes('vault') || 
            currentUrl.includes('eu') || currentUrl.includes('nextcdn')
          )) {
            mp4Url = currentUrl;
            mp4UrlFound = true;
            console.log('Direct MP4 URL found:', currentUrl);
            break;
          }

          const pageContent = await page.content();
          const mp4Match = pageContent.match(/(https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*)/gi);
          if (mp4Match && mp4Match.length > 0) {
            const found = mp4Match.find(match =>
              match.includes('cdn') || match.includes('vault') ||
              match.includes('eu') || match.includes('nextcdn')
            );
            if (found) {
              mp4Url = found;
              mp4UrlFound = true;
              console.log('MP4 URL from page content:', mp4Url);
              break;
            }
          }
        } catch (err) {
          console.log('Error during periodic check:', err.message);
        }
      }
    }

    if (!mp4UrlFound || !mp4Url) throw new Error('Failed to find a valid MP4 URL');

    const response = { kwikLink, mp4Link: mp4Url };
    await browser.close();
    return res.status(200).json(response);

  } catch (err) {
    if (browser) await browser.close();
    console.error('Error in resolvex:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
