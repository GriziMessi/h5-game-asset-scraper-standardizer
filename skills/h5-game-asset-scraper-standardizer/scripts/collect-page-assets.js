#!/usr/bin/env node

import { chromium } from 'playwright';
import sharp from 'sharp';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif'];
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.m3u8'];

/**
 * Convert a page title into a kebab-case folder slug.
 * Strips common Playhop suffixes like ": Play Online For Free On Playhop"
 * and "在 Playhop 上免费在线畅玩".
 */
function slugify(title) {
  if (!title) return 'page-assets';
  return title
    .replace(/:?\s*(?:Play Online For Free On Playhop|在 Playhop 上免费在线畅玩).*/i, '')
    .replace(/[^a-zA-Z0-9一-鿿\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase() || 'page-assets';
}

function parseArgs(argv) {
  const args = {
    url: argv[0],
    help: argv.length === 0 || argv[0] === '--help' || argv[0] === '-h',
    output: null,  // auto-generated from page title if not specified
    waitMs: 3000,
    scrolls: 6,
    maxImages: 80
  };

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === '--output' && value) {
      args.output = value;
      i += 1;
    } else if (arg === '--wait-ms' && value) {
      args.waitMs = Number(value);
      i += 1;
    } else if (arg === '--scrolls' && value) {
      args.scrolls = Number(value);
      i += 1;
    } else if (arg === '--max-images' && value) {
      args.maxImages = Number(value);
      i += 1;
    }
  }

  return args;
}

function usage() {
  console.error(`Usage: node collect-page-assets.js <url> [--output <dir>] [--wait-ms 3000] [--scrolls 6] [--max-images 80]`);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function toAbsoluteUrl(value, baseUrl) {
  if (!value || value.startsWith('data:') || value.startsWith('blob:')) {
    return null;
  }
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
}

function parseSrcset(srcset, baseUrl) {
  if (!srcset) return [];
  return srcset
    .split(',')
    .map((item) => item.trim().split(/\s+/)[0])
    .map((item) => toAbsoluteUrl(item, baseUrl))
    .filter(Boolean);
}

function filenameFromUrl(url, fallbackExt = '.png') {
  const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 12);
  let ext = fallbackExt;
  try {
    const parsed = new URL(url);
    const parsedExt = path.extname(parsed.pathname).toLowerCase();
    if (IMAGE_EXTENSIONS.includes(parsedExt)) {
      ext = parsedExt === '.jpeg' ? '.jpg' : parsedExt;
    }
  } catch {
    // Keep fallback.
  }
  return `${hash}${ext}`;
}

async function ensureDirs(outputDir) {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(path.join(outputDir, 'media'), { recursive: true });
  await fs.mkdir(path.join(outputDir, 'raw-images'), { recursive: true });
  await fs.mkdir(path.join(outputDir, 'standardized'), { recursive: true });
}

async function scrollPage(page, scrolls) {
  for (let i = 0; i < scrolls; i += 1) {
    await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight, 700)));
    await page.waitForTimeout(450);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

/**
 * Build full image URLs from Playhop-style CDN prefix URLs.
 * Playhop stores "prefix-url" entries like:
 *   https://static.playhop.com/images/.../abc123/
 * The actual images are served by appending size suffixes: pjpg928x522, pjpg1920x1080, etc.
 */
function buildImageUrlsFromPrefix(prefixUrl) {
  if (!prefixUrl) return [];
  const base = prefixUrl.replace(/\/$/, '');
  // Common Playhop size suffixes, largest first for best quality
  const sizes = ['pjpg1920x1080', 'pjpg928x522', 'pjpg800x450', 'pjpg464x261', 'pjpg340x340', 'pjpg256x256', 'pjpg160x160'];
  return sizes.map((s) => `${base}/${s}`);
}

async function extractPageData(page, url) {
  return page.evaluate((baseUrl) => {
    const abs = (value) => {
      if (!value || value.startsWith('data:') || value.startsWith('blob:')) return null;
      try {
        return new URL(value, baseUrl).toString();
      } catch {
        return null;
      }
    };

    const srcsetUrls = (srcset) => {
      if (!srcset) return [];
      return srcset
        .split(',')
        .map((item) => item.trim().split(/\s+/)[0])
        .map(abs)
        .filter(Boolean);
    };

    const metadata = {};
    const title = document.querySelector('title')?.textContent?.trim() || '';
    if (title) metadata.title = title;

    document.querySelectorAll('meta').forEach((meta) => {
      const key = meta.getAttribute('name') || meta.getAttribute('property');
      const content = meta.getAttribute('content');
      if (key && content) metadata[key] = content.trim();
    });

    const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href');
    if (canonical) metadata.canonical = abs(canonical);

    // =========================================================
    // STRATEGY 1: CSS-based extraction (works for most sites)
    // =========================================================

    // --- Game description from DOM ---
    const gameDescEl =
      document.querySelector('.game-description__description') ||
      document.querySelector('[class*="game-description__description"]') ||
      document.querySelector('[class*="middle-layer-info"][class*="description"]') ||
      document.querySelector('[class*="shortDescription"]');
    const domDescription = gameDescEl ? gameDescEl.textContent.replace(/\s+/g, ' ').trim() : '';

    const visibleText = [...document.body.querySelectorAll('h1,h2,h3,p,li,figcaption,[class*="description"],[class*="Description"]')]
      .map((node) => node.textContent.replace(/\s+/g, ' ').trim())
      .filter((text) => text.length >= 2);

    // --- All page images (img tags + srcset + data-src + style backgrounds) ---
    const imageUrls = [];
    document.querySelectorAll('img').forEach((img) => {
      imageUrls.push(abs(img.currentSrc || img.src || img.getAttribute('src')));
      imageUrls.push(...srcsetUrls(img.getAttribute('srcset')));
      imageUrls.push(abs(img.getAttribute('data-src')));
      imageUrls.push(abs(img.getAttribute('data-original')));
    });

    document.querySelectorAll('source').forEach((source) => {
      imageUrls.push(abs(source.getAttribute('src')));
      imageUrls.push(...srcsetUrls(source.getAttribute('srcset')));
    });

    document.querySelectorAll('[style]').forEach((node) => {
      const style = node.getAttribute('style') || '';
      const matches = [...style.matchAll(/url\(["']?([^"')]+)["']?\)/g)];
      matches.forEach((match) => imageUrls.push(abs(match[1])));
    });

    // --- Game screenshots from CSS containers ---
    const cssScreenshotUrls = [];
    // Try user-specified selector first
    const gamePageContainer =
      document.querySelector('.horizontal-container__list_game-page') ||
      document.querySelector('[class*="horizontal-container__list"][class*="game-page"]');
    if (gamePageContainer) {
      gamePageContainer.querySelectorAll('img').forEach((img) => {
        cssScreenshotUrls.push(abs(img.currentSrc || img.src || img.getAttribute('src')));
        cssScreenshotUrls.push(...srcsetUrls(img.getAttribute('srcset')));
        cssScreenshotUrls.push(abs(img.getAttribute('data-src')));
        cssScreenshotUrls.push(abs(img.getAttribute('data-original')));
      });
      gamePageContainer.querySelectorAll('source').forEach((source) => {
        cssScreenshotUrls.push(abs(source.getAttribute('src')));
        cssScreenshotUrls.push(...srcsetUrls(source.getAttribute('srcset')));
      });
    }
    // Also extract background-image URLs from Playhop-style media preview containers
    document.querySelectorAll('[class*="middle-layer-media"][class*="image"]').forEach((el) => {
      const style = el.getAttribute('style') || '';
      const match = style.match(/url\(["']?([^"')]+)["']?\)/);
      if (match) cssScreenshotUrls.push(abs(match[1]));
    });

    const videoUrls = [];
    document.querySelectorAll('video, video source').forEach((node) => {
      videoUrls.push(abs(node.getAttribute('src')));
      videoUrls.push(abs(node.getAttribute('poster')));
    });
    document.querySelectorAll('a[href], iframe[src]').forEach((node) => {
      const value = node.getAttribute('href') || node.getAttribute('src');
      videoUrls.push(abs(value));
    });

    // =========================================================
    // STRATEGY 2: JSON-based extraction (Playhop embeds data in <script>)
    // =========================================================
    let jsonDescription = '';
    const jsonScreenshotUrls = [];
    const jsonImageUrls = [];

    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const text = script.textContent || '';
      if (!text.includes('"description"') || !text.includes('"screenshots"')) continue;

      try {
        // Try to extract description from JSON string
        const descMatch = text.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (descMatch) {
          jsonDescription = descMatch[1]
            .replace(/\\n/g, '\n')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\')
            .trim();
        }

        // Extract screenshot prefix URLs from screenshots.desktop array
        const screenshotsSection = text.match(/"screenshots"\s*:\s*\{[^}]*"desktop"\s*:\s*\[([^\]]*)\]/);
        if (screenshotsSection) {
          const prefixMatches = [...screenshotsSection[1].matchAll(/"prefix-url"\s*:\s*"([^"]+)"/g)];
          prefixMatches.forEach((m) => {
            const prefix = m[1];
            // Build candidate URLs with common size suffixes
            const sizes = ['pjpg1920x1080', 'pjpg928x522', 'pjpg800x450', 'pjpg464x261'];
            sizes.forEach((s) => {
              const fullUrl = prefix.replace(/\/$/, '') + '/' + s;
              jsonScreenshotUrls.push(abs(fullUrl));
            });
          });
        }

        // Extract icon/cover prefix URLs from the same JSON blob
        const allPrefixMatches = [...text.matchAll(/"prefix-url"\s*:\s*"([^"]+)"/g)];
        allPrefixMatches.forEach((m) => {
          const prefix = m[1];
          const sizes = ['pjpg928x522', 'pjpg464x261', 'pjpg340x340', 'pjpg256x256', 'pjpg160x160'];
          sizes.forEach((s) => {
            const fullUrl = prefix.replace(/\/$/, '') + '/' + s;
            jsonImageUrls.push(abs(fullUrl));
          });
        });
      } catch (_) {
        // Ignore parse errors in script content
      }
    }

    // =========================================================
    // STRATEGY 3: Yandex Games video extraction
    // Yandex Games embeds video streaming URLs in <script> tags
    // as JSON configuration data. The pattern is:
    //   https://runtime.strm.yandex.ru/player/video/<videoId>?...
    // These are NOT in <video> tags — they're in JS configs like
    // __NEXT_DATA__, window.__INITIAL_STATE__, or inline scripts.
    // =========================================================
    const yandexVideoUrls = [];
    for (const script of scripts) {
      const text = script.textContent || '';
      // Match Yandex streaming player URLs — the video ID is alphanumeric,
      // followed by query params that configure loop, mute, autoplay, etc.
      const matches = text.match(/https:\/\/[^"'\s]*strm\.yandex\.ru\/player\/video\/[a-z0-9]+[^"'\s<>]*/gi);
      if (matches) {
        matches.forEach((m) => yandexVideoUrls.push(m));
      }
    }
    // Also scan for iframes whose src points to yandex video player
    document.querySelectorAll('iframe[src*="strm.yandex.ru"], iframe[src*="yandex.ru/player/video"]').forEach((iframe) => {
      yandexVideoUrls.push(abs(iframe.getAttribute('src')));
    });

    // =========================================================
    // Merge results: prefer JSON data, fall back to CSS data
    // =========================================================
    const gameDescription = jsonDescription || domDescription;

    // Screenshots: prefer JSON screenshots (from screenshots.desktop),
    // fall back to CSS container screenshots
    const finalScreenshotUrls = jsonScreenshotUrls.length > 0
      ? jsonScreenshotUrls
      : cssScreenshotUrls;

    // Image URLs: include JSON prefix-built URLs for comprehensive coverage
    const allImageUrls = [...imageUrls, ...jsonImageUrls];

    // Video URLs: include Yandex streaming URLs found in script data / iframes
    const allVideoUrls = [...videoUrls, ...yandexVideoUrls];

    return {
      metadata,
      gameDescription,
      text: [...new Set(visibleText)],
      imageUrls: [...new Set(allImageUrls.filter(Boolean))],
      screenshotUrls: [...new Set(finalScreenshotUrls.filter(Boolean))],
      videoUrls: [...new Set(allVideoUrls.filter(Boolean))]
    };
  }, url);
}

function classifyVideoUrls(urls) {
  return urls.filter((url) => {
    const lower = url.toLowerCase();
    return VIDEO_EXTENSIONS.some((ext) => lower.includes(ext))
      || lower.includes('youtube.com')
      || lower.includes('youtu.be')
      || lower.includes('vimeo.com')
      || lower.includes('video')
      || lower.includes('strm.yandex.ru')       // Yandex Games streaming player
      || lower.includes('yandex.ru/player/video') // Yandex video player path
      || lower.includes('yagames')               // Yandex Games query param
      || lower.includes('from=yagames');         // Yandex Games referrer param
  });
}

async function downloadImage(url, outputDir) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; webpage-asset-standardizer/1.0)'
    }
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const input = Buffer.from(arrayBuffer);
  const image = sharp(input, { animated: false });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error('Missing image dimensions');
  }

  const filename = filenameFromUrl(url, '.png').replace(/\.(webp|avif|gif)$/i, '.png');
  const filePath = path.join(outputDir, 'raw-images', filename);
  await image.png({ compressionLevel: 9 }).toFile(filePath);

  return {
    url,
    file: path.relative(outputDir, filePath),
    width: metadata.width,
    height: metadata.height,
    format: metadata.format,
    area: metadata.width * metadata.height
  };
}

function roleScore(image) {
  const ratio = image.width / image.height;
  const squareScore = Math.abs(1 - ratio);
  const landscapeScore = Math.abs((16 / 9) - ratio);
  return {
    icon: squareScore + (image.area > 2048 * 2048 ? 3 : 0),
    landscape: landscapeScore - Math.min(image.area / 10000000, 1)
  };
}

function assignRoles(images, screenshotUrlSet) {
  // Screenshots: ONLY from the game-page container
  const screenshotCandidates = images.filter(
    (image) => screenshotUrlSet.has(image.url) && image.width >= 120 && image.height >= 120
  );

  // Icon: prefer clean game icons over marketing/og:image cards
  // Game icons are square, typically 160-512px, from game image CDN (not opengraph)
  const usable = images.filter((image) => image.width >= 120 && image.height >= 120);

  // Separate game icons from og:image/marketing cards
  const ogImagePattern = /opengraph|og-image|og_image/i;
  const gameIcons = usable.filter(
    (image) => Math.abs(image.width - image.height) < image.width * 0.05
      && image.width <= 512
      && !ogImagePattern.test(image.url)
  ).sort((a, b) => b.area - a.area);

  const ogIcons = usable.filter(
    (image) => Math.abs(image.width - image.height) < image.width * 0.05
      && ogImagePattern.test(image.url)
  ).sort((a, b) => b.area - a.area);

  // Prefer game icon; fall back to og:image if no clean game icon exists
  const icon = gameIcons[0] || ogIcons[0] || null;

  // Cover: best landscape image (not og:image marketing cards, not background)
  const landscapes = usable
    .filter((image) => image !== icon
      && image.width > image.height
      && image.width >= 500
      && !image.url.includes('background-game')
      && !ogImagePattern.test(image.url))
    .sort((a, b) => roleScore(a).landscape - roleScore(b).landscape);

  const roles = {};
  if (icon) roles.icon = icon.file;
  if (landscapes[0]) roles.cover = landscapes[0].file;
  screenshotCandidates.slice(0, 20).forEach((image, index) => {
    roles[`screenshot_${index + 1}`] = image.file;
  });
  return roles;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.url) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });

  // Block font requests BEFORE page load to prevent screenshot timeout
  // while waiting for fonts to load on fullPage screenshots.
  // Use a regex — Playwright glob **/*.{a,b} brace expansion is unreliable.
  await page.route(/\.(woff2?|ttf|otf|eot)(\?|$)/i, (route) => route.abort());

  try {
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(args.waitMs);
    await scrollPage(page, args.scrolls);

    // Auto-generate output folder name from page title if not explicitly set
    if (!args.output) {
      const pageTitle = await page.title();
      args.output = `./outputs/${slugify(pageTitle)}`;
    }
    const outputDir = path.resolve(args.output);
    await ensureDirs(outputDir);

    // Screenshot is non-critical — some pages hang on document.fonts.ready.
    // Catch timeout and continue so collect never fails on screenshot alone.
    try {
      await page.screenshot({
        path: path.join(outputDir, 'page-screenshot.png'),
        timeout: 15000
      });
    } catch (screenshotErr) {
      console.error(`Screenshot skipped: ${screenshotErr.message}`);
    }

    const data = await extractPageData(page, args.url);

    // Post-extraction: safety scan for Yandex video iframes that may have
    // loaded dynamically after the initial DOM parse (common on Yandex Games).
    // This catches iframes injected by React/Next.js hydration or lazy-loaded widgets.
    const yandexIframeUrls = await page.evaluate(() => {
      const urls = [];
      document.querySelectorAll('iframe[src*="strm.yandex.ru"], iframe[src*="yandex.ru/player/video"]').forEach((iframe) => {
        const src = iframe.getAttribute('src');
        if (src) {
          try {
            urls.push(new URL(src, location.href).toString());
          } catch {
            urls.push(src);
          }
        }
      });
      return urls;
    });
    data.videoUrls = [...new Set([...data.videoUrls, ...yandexIframeUrls])];

    const imageUrls = unique([
      ...data.imageUrls,
      data.metadata['og:image'],
      data.metadata['twitter:image']
    ].map((item) => toAbsoluteUrl(item, args.url) || item));
    const videoUrls = classifyVideoUrls(data.videoUrls);

    // Build a lookup set for screenshot URLs so we can tag them later
    const screenshotUrlSet = new Set(data.screenshotUrls.map((u) => toAbsoluteUrl(u, args.url)).filter(Boolean));

    const downloaded = [];
    for (const imageUrl of imageUrls.slice(0, args.maxImages)) {
      try {
        const result = await downloadImage(imageUrl, outputDir);
        // Tag images that came from the game-page screenshot container
        result.isScreenshot = screenshotUrlSet.has(result.url);
        downloaded.push(result);
      } catch (error) {
        downloaded.push({ url: imageUrl, error: error.message, isScreenshot: screenshotUrlSet.has(imageUrl) });
      }
    }

    const successfulImages = downloaded.filter((item) => item.file);

    // Description: prefer structured game-description span, fall back to metadata
    const descriptionParts = [
      data.metadata.title,
      data.gameDescription,
      data.metadata.description,
      data.metadata['og:description'],
      ...data.text
    ].filter(Boolean);
    const descriptionText = unique(descriptionParts).join('\n\n').trim();
    const suggestedRoles = assignRoles(successfulImages, screenshotUrlSet);

    await fs.writeFile(path.join(outputDir, 'description.txt'), `${descriptionText}\n`, 'utf8');
    await fs.writeFile(path.join(outputDir, 'media', 'image-urls.txt'), `${imageUrls.join('\n')}\n`, 'utf8');
    await fs.writeFile(path.join(outputDir, 'media', 'video-urls.txt'), `${videoUrls.join('\n')}\n`, 'utf8');

    const manifest = {
      sourceUrl: args.url,
      collectedAt: new Date().toISOString(),
      metadata: data.metadata,
      gameDescription: data.gameDescription,
      text: data.text,
      videoUrls,
      screenshotUrls: data.screenshotUrls,
      images: successfulImages,
      failedImages: downloaded.filter((item) => item.error),
      suggestedRoles,
      outputs: []
    };
    await fs.writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    console.log(JSON.stringify(manifest, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
