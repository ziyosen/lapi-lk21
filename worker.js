import { Hono } from 'hono';
import { cors } from 'hono/cors';
import * as cheerio from 'cheerio';

const app = new Hono();
app.use('*', cors());

const BASE_URL = 'https://tv12.lk21official.cc';
const CACHE_TTL = 3600; 
const MAX_PAGE = 15;    

const LIST_GENRE = [
    "drama", "comedy", "action", "thriller", "romance", "horror", "crime", "adventure",
    "mystery", "animation", "fantasy", "sci-fi", "family", "history",
    "war", "music", "documentary", "sport", "western", "musical", "kids", "movies"
];
const VALID_COUNTRIES = ["usa", "japan", "south-korea", "china", "thailand", "uk"];

async function scrapePage(c, cacheKey, pathPrefix, page) {
    const pageNum = parseInt(page || '1', 10);
    if (isNaN(pageNum) || pageNum < 1 || pageNum > MAX_PAGE) {
        return c.json({ error: true, error_msg: `Halaman dibatasi max ${MAX_PAGE}` }, 400);
    }
    const forceRefresh = c.req.query('refresh') === 'true';

    if (!forceRefresh) {
        try {
            const cachedData = await c.env.LK21_KV.get(`${cacheKey}_p${pageNum}`, { type: 'json' });
            if (cachedData && cachedData.data?.length > 0) return c.json({ status: true, source: "KV Cache", ...cachedData });
        } catch (e) { }
    }

    const targetUrl = pageNum === 1 ? `${BASE_URL}/${pathPrefix}/` : `${BASE_URL}/${pathPrefix}/page/${pageNum}/`;

    try {
        const res = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Referer': `${BASE_URL}/`
            }
        });
        if (!res.ok) return c.json({ error: true, status_code: res.status, error_msg: "Gagal scrape LK21" }, 400);

        const html = await res.text();
        const $ = cheerio.load(html);
        const results = [];

        $('.movie-box, article, .grid-item, .search-item').each((_, el) => {
            const $link = $(el).find('a').first();
            const $img = $(el).find('img').first();
            const href = $link.attr('href');
            if (!href || href.includes('/genre/')) return;

            const judul = $img.attr('alt') || $link.attr('title') || $(el).find('h2, h3').text().trim();
            let thumbnail = $img.attr('src') || $img.attr('data-src');
            if (thumbnail && thumbnail.startsWith('//')) thumbnail = `https:${thumbnail}`;
            
            const slug = href.replace(/https?:\/\/[^\/]+/, '').replace(/^\/|\/$/g, '');
            const rawText = $(el).text();
            const rating = rawText.match(/(\d+\.\d+)/)?.[1] || null;
            const kualitas = rawText.includes('HD') ? 'HD' : null;

            if (judul && slug && !results.some(r => r.slug === slug)) {
                results.push({ judul: judul.replace(/Permalink to /i, ''), slug, url: `${BASE_URL}/${slug}/`, thumbnail, rating, kualitas });
            }
        });

        const responseData = { page: pageNum, max_page: MAX_PAGE, total_data: results.length, data: results };
        if (results.length > 0) await c.env.LK21_KV.put(`${cacheKey}_p${pageNum}`, JSON.stringify(responseData), { expirationTtl: CACHE_TTL });
        return c.json({ status: true, source: "Live Scrape", ...responseData });
    } catch (err) {
        return c.json({ error: true, error_msg: err.message }, 500);
    }
}

app.get('/', (c) => scrapePage(c, 'latest', 'latest', c.req.query('page')));
app.get('/latest-series', (c) => scrapePage(c, 'latest_series', 'latest-series', c.req.query('page')));
app.get('/populer', (c) => scrapePage(c, 'populer', 'populer', c.req.query('page')));
app.get('/genre/:name', (c) => scrapePage(c, `genre_${c.req.param('name')}`, `genre/${c.req.param('name')}`, c.req.query('page')));

// 7. DETAIL ENDPOINT DENGAN TRIK PROXY PLAYERIFRAME.LOL
app.get('/detail/:slug', async (c) => {
    const slug = c.req.param('slug');
    const cacheKey = `detail_${slug}`;
    const forceRefresh = c.req.query('refresh') === 'true';

    if (!forceRefresh) {
        try {
            const cachedData = await c.env.LK21_KV.get(cacheKey, { type: 'json' });
            if (cachedData) return c.json({ status: true, source: "KV Cache", ...cachedData });
        } catch (e) { }
    }

    try {
        const res = await fetch(`${BASE_URL}/${slug}/`, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': `${BASE_URL}/` }
        });
        if (!res.ok) return c.json({ error: true, error_msg: "Gagal mengambil detail" }, 400);

        const html = await res.text();
        const $ = cheerio.load(html);
        const extractedServers = [];

        // LOGIKA BARU: Ambil URL dari tag <a> yang disembunyikan LK21 lalu bungkus proxy
        $('#loadProviders li a, ul.providers li a, .server-option').each((_, el) => {
            let rawUrl = $(el).attr('href') || $(el).attr('data-url');
            if (rawUrl && rawUrl.includes('url=')) {
                let actualPlayerUrl = rawUrl.split('url=')[1];
                let decodedUrl = decodeURIComponent(actualPlayerUrl);
                
                // Gunakan trik playeriframe.lol
                let proxyUrl = `https://playeriframe.lol/iframe.php?url=${encodeURIComponent(decodedUrl)}`;
                
                if (!extractedServers.some(s => s.url === proxyUrl)) {
                    extractedServers.push({ name: "Server VIP (Bypass)", url: proxyUrl });
                }
            }
        });

        // Fallback: Ambil Iframe biasa
        $('#playeriframe, iframe').each((_, el) => {
            let src = $(el).attr('src');
            if (src && !extractedServers.some(s => s.url === src)) {
                extractedServers.push({ name: "Server LK21 Asli", url: src.startsWith('//') ? `https:${src}` : src });
            }
        });

        const sinopsis = $('.synopsis, #movie-detail p').text().trim() || "Sinopsis tidak tersedia.";
        
        const responseData = {
            slug,
            default_embed: extractedServers.length > 0 ? extractedServers[0].url : null,
            servers: extractedServers,
            sinopsis
        };

        if (extractedServers.length > 0) await c.env.LK21_KV.put(cacheKey, JSON.stringify(responseData), { expirationTtl: CACHE_TTL });
        return c.json({ status: true, source: "Live Scrape", ...responseData });

    } catch (err) {
        return c.json({ error: true, error_msg: err.message }, 500);
    }
});

export default app;
