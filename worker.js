import { Hono } from 'hono';
import { cors } from 'hono/cors';
import * as cheerio from 'cheerio';

const app = new Hono();
app.use('*', cors());

const BASE_URL = 'https://tv12.lk21official.cc';
const CACHE_TTL = 3600; // Cache 1 jam

app.get('/', async (c) => {
  const page = parseInt(c.req.query('page') || '1', 10);

  if (isNaN(page) || page < 1 || page > 9) {
    return c.json({ error: true, error_msg: "Page must be 1-9" }, 400);
  }

  const cacheKey = `latest_page_${page}`;

  try {
    // 1. Cek KV Cache (Abaikan jika ada query ?refresh=true)
    const forceRefresh = c.req.query('refresh') === 'true';
    if (!forceRefresh) {
      const cachedData = await c.env.LK21_KV.get(cacheKey, { type: 'json' });
      if (cachedData && cachedData.data?.length > 0) {
        return c.json({
          status: true,
          source: "KV Cache (Fast)",
          ...cachedData
        });
      }
    }

    // 2. Target URL
    const targetUrl = page === 1 ? `${BASE_URL}/latest/` : `${BASE_URL}/latest/page/${page}/`;

    // Fetch dengan opsi redirect: 'follow'
    const res = await fetch(targetUrl, {
      method: 'GET',
      redirect: 'follow', // OLEH KARENA ADA 302 REDIRECT, WAJIB FOLLOW
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'id,en-US;q=0.7,en;q=0.3',
        'Referer': `${BASE_URL}/`
      }
    });

    if (!res.ok && res.status !== 302) {
      return c.json({ error: true, status_code: res.status, error_msg: "Gagal mengambil data dari LK21" }, 400);
    }

    const html = await res.text();
    const $ = cheerio.load(html);
    const results = [];

    // Selector parsing fleksibel
    $('.movie-box, article, .grid-item, .col-lg-2, .col-sm-3, .col-xs-4, .search-item').each((_, element) => {
      const $item = $(element);
      const $link = $item.find('a').first();
      const $img = $item.find('img').first();

      const href = $link.attr('href');
      if (!href) return;

      if (href.includes('/genre/') || href.includes('/year/') || href.includes('/country/')) return;

      const judul = $img.attr('alt') || $link.attr('title') || $item.find('h2, h3').text().trim();
      const rawImg = $img.attr('src') || $img.attr('data-src');
      const thumbnail = rawImg ? (rawImg.startsWith('//') ? `https:${rawImg}` : rawImg) : null;
      
      const slug = href.replace(/https?:\/\/[^\/]+/, '').replace(/^\/|\/$/g, '');
      const rating = $item.find('.rating, .fa-star').parent().text().trim() || null;
      const quality = $item.find('.quality, .label-quality').text().trim() || null;

      if (judul && slug && !results.some(r => r.slug === slug)) {
        results.push({
          judul: judul.replace(/Permalink to /i, ''),
          slug,
          url: `${BASE_URL}/${slug}/`,
          thumbnail,
          rating,
          kualitas: quality
        });
      }
    });

    const responseData = {
      page,
      total_data: results.length,
      data: results
    };

    // 3. Simpan ke KV Cache hanya jika berhasil dapat data
    if (results.length > 0) {
      await c.env.LK21_KV.put(cacheKey, JSON.stringify(responseData), {
        expirationTtl: CACHE_TTL
      });
    }

    return c.json({
      status: true,
      source: "Live Scrape",
      final_url: res.url, // URL tujuan akhir setelah redirect
      ...responseData
    });

  } catch (err) {
    return c.json({ error: true, error_msg: err.message }, 500);
  }
});

export default app;
