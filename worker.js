import { Hono } from 'hono';
import { cors } from 'hono/cors';
import * as cheerio from 'cheerio';

const app = new Hono();
app.use('*', cors());

const BASE_URL = 'https://tv12.lk21official.cc';
const CACHE_TTL = 3600; // Cache berlaku selama 1 jam (3600 detik)

app.get('/', async (c) => {
  const page = parseInt(c.req.query('page') || '1', 10);

  if (isNaN(page) || page < 1 || page > 9) {
    return c.json({ error: true, error_msg: "Page must be 1-9" }, 400);
  }

  const cacheKey = `latest_page_${page}`;

  try {
    // 1. Cek apakah data sudah ada di Cloudflare KV
    const cachedData = await c.env.LK21_KV.get(cacheKey, { type: 'json' });

    if (cachedData) {
      return c.json({
        status: true,
        source: "KV Cache (Fast)",
        ...cachedData
      });
    }

    // 2. Jika tidak ada di Cache, lakukan scraping ke LK21
    const targetUrl = page === 1 ? `${BASE_URL}/latest/` : `${BASE_URL}/latest/page/${page}/`;

    const res = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Referer': `${BASE_URL}/`
      }
    });

    if (!res.ok) {
      return c.json({ error: true, status_code: res.status, error_msg: "Failed to fetch LK21" }, 400);
    }

    const html = await res.text();
    const $ = cheerio.load(html);
    const results = [];

    $('.col-lg-2.col-sm-3.col-xs-4, .search-item, .grid-item').each((_, element) => {
      const $item = $(element);
      const $link = $item.find('a').first();
      const $img = $item.find('img').first();

      const href = $link.attr('href');
      if (!href) return;

      const judul = $img.attr('alt') || $link.attr('title') || $link.text().trim();
      const rawImg = $img.attr('src') || $img.attr('data-src');
      const thumbnail = rawImg ? (rawImg.startsWith('//') ? `https:${rawImg}` : rawImg) : null;
      const slug = href.replace(BASE_URL, '').replace(/^\/|\/$/g, '');

      if (judul && slug) {
        results.push({ judul, slug, url: `${BASE_URL}/${slug}/`, thumbnail });
      }
    });

    const responseData = {
      page,
      total_data: results.length,
      data: results
    };

    // 3. Simpan hasil scraping ke Cloudflare KV dengan waktu kedaluwarsa (TTL)
    await c.env.LK21_KV.put(cacheKey, JSON.stringify(responseData), {
      expirationTtl: CACHE_TTL
    });

    return c.json({
      status: true,
      source: "Live Scrape",
      ...responseData
    });

  } catch (err) {
    return c.json({ error: true, error_msg: err.message }, 500);
  }
});

export default app;
