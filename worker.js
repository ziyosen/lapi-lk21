import { Hono } from 'hono';
import { cors } from 'hono/cors';
import * as cheerio from 'cheerio';

const app = new Hono();
app.use('*', cors());

const BASE_URL = 'https://tv12.lk21official.cc';
const CACHE_TTL = 3600; // Cache selama 1 jam (3600 detik)
const MAX_PAGE = 15;    // Diatur sampai 15 Halaman

// ==================== LIST GENRE & COUNTRY ====================
const LIST_GENRE = [
    "drama", "comedy", "action", "thriller", "romance", "horror", "crime", "adventure",
    "mystery", "animation", "fantasy", "sci-fi", "family", "wrestling", "biography", "history",
    "war", "music", "documentary", "sport", "western", "musical", "science-fiction", "short",
    "film-noir", "tv-movie", "shounen", "school", "news", "magic", "supernatural", "mecha",
    "military", "historical", "foreign", "slice-of-life", "horor", "suspense", "psychological", "sports",
    "live-action", "samurai", "erotic", "adult", "recommend", "police", "youth", "kids",
    "costume", "super-power", "actin-comedy", "detective", "investigation", "doraemon", "movies",
    "oscar-nominated-short-film", "mandarin", "mature", "mistery", "omnibus", "adventures",
    "time-travel", "special", "ova", "parody", "seinen", "shoujo"
];

const VALID_COUNTRIES = ["usa", "japan", "south-korea", "china", "thailand", "uk"];

// ==================== HELPER SCRAPER ====================
async function scrapePage(c, cacheKey, pathPrefix, page) {
    const pageNum = parseInt(page || '1', 10);
    if (isNaN(pageNum) || pageNum < 1 || pageNum > MAX_PAGE) {
        return c.json({ error: true, error_msg: `Halaman hanya diperbolehkan dari 1 sampai ${MAX_PAGE}` }, 400);
    }

    const forceRefresh = c.req.query('refresh') === 'true';

    // 1. Cek KV Cache
    if (!forceRefresh) {
        try {
            const cachedData = await c.env.LK21_KV.get(`${cacheKey}_p${pageNum}`, { type: 'json' });
            if (cachedData && cachedData.data?.length > 0) {
                return c.json({ status: true, source: "KV Cache (Fast)", ...cachedData });
            }
        } catch (e) {
            console.error("KV Error:", e.message);
        }
    }

    // 2. Format Target URL
    const targetUrl = pageNum === 1 
        ? `${BASE_URL}/${pathPrefix}/` 
        : `${BASE_URL}/${pathPrefix}/page/${pageNum}/`;

    try {
        const res = await fetch(targetUrl, {
            method: 'GET',
            redirect: 'follow',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Referer': `${BASE_URL}/`
            }
        });

        if (!res.ok && res.status !== 302) {
            return c.json({ error: true, status_code: res.status, error_msg: "Gagal mengambil data dari LK21" }, 400);
        }

        const html = await res.text();
        const $ = cheerio.load(html);
        const results = [];

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
            
            // Refined Rating & Quality Parsing
            const rawText = $item.text();
            const ratingMatch = rawText.match(/(\d+\.\d+)/);
            const rating = ratingMatch ? ratingMatch[1] : null;
            const kualitas = rawText.includes('HD') ? 'HD' : null;

            if (judul && slug && !results.some(r => r.slug === slug)) {
                results.push({
                    judul: judul.replace(/Permalink to /i, ''),
                    slug,
                    url: `${BASE_URL}/${slug}/`,
                    thumbnail,
                    rating,
                    kualitas
                });
            }
        });

        const responseData = { page: pageNum, max_page: MAX_PAGE, total_data: results.length, data: results };

        // 3. Simpan ke KV Cache jika sukses
        if (results.length > 0) {
            try {
                await c.env.LK21_KV.put(`${cacheKey}_p${pageNum}`, JSON.stringify(responseData), {
                    expirationTtl: CACHE_TTL
                });
            } catch (e) {
                console.error("KV Set Error:", e.message);
            }
        }

        return c.json({ status: true, source: "Live Scrape", ...responseData });

    } catch (err) {
        return c.json({ error: true, error_msg: err.message }, 500);
    }
}

// ==================== ENDPOINTS ====================

// 1. Latest Movies (Root)
app.get('/', (c) => scrapePage(c, 'latest', 'latest', c.req.query('page')));

// 2. Latest Series
app.get('/latest-series', (c) => scrapePage(c, 'latest_series', 'latest-series', c.req.query('page')));

// 3. Maraton Drakor
app.get('/maraton-drakor', (c) => scrapePage(c, 'maraton_drakor', 'maraton-drakor', c.req.query('page')));

// 4. Populer
app.get('/populer', (c) => scrapePage(c, 'populer', 'populer', c.req.query('page')));

// 5. List Genre & Genre Scraper
app.get('/genre', (c) => c.json({ status: true, available_genres: LIST_GENRE }));

app.get('/genre/:name', (c) => {
    const genreName = c.req.param('name').toLowerCase();
    if (!LIST_GENRE.includes(genreName)) {
        return c.json({ error: true, error_msg: "Genre tidak ditemukan", available_genres: LIST_GENRE }, 400);
    }
    return scrapePage(c, `genre_${genreName}`, `genre/${genreName}`, c.req.query('page'));
});

// 6. Country Scraper
app.get('/country/:code', (c) => {
    const countryCode = c.req.param('code').toLowerCase();
    if (!VALID_COUNTRIES.includes(countryCode)) {
        return c.json({ error: true, error_msg: "Country tidak valid", available_countries: VALID_COUNTRIES }, 400);
    }
    return scrapePage(c, `country_${countryCode}`, `country/${countryCode}`, c.req.query('page'));
});

// 7. Detail Film & Video Player Embed
app.get('/detail/:slug', async (c) => {
    const slug = c.req.param('slug');
    const cacheKey = `detail_${slug}`;
    const forceRefresh = c.req.query('refresh') === 'true';

    // Cek KV Cache
    if (!forceRefresh) {
        try {
            const cachedData = await c.env.LK21_KV.get(cacheKey, { type: 'json' });
            if (cachedData) {
                return c.json({ status: true, source: "KV Cache (Fast)", ...cachedData });
            }
        } catch (e) {
            console.error("KV Error:", e.message);
        }
    }

    const targetUrl = `${BASE_URL}/${slug}/`;

    try {
        const res = await fetch(targetUrl, {
            method: 'GET',
            redirect: 'follow',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Referer': `${BASE_URL}/`
            }
        });

        if (!res.ok) {
            return c.json({ error: true, status_code: res.status, error_msg: "Gagal mengambil detail film" }, 400);
        }

        const html = await res.text();
        const $ = cheerio.load(html);

        // Ekstrak URL iframe embed player
        let embedUrl = $('#playeriframe').attr('src') || $('iframe[src*="player"]').attr('src') || $('iframe').first().attr('src');
        
        if (embedUrl && embedUrl.startsWith('//')) {
            embedUrl = `https:${embedUrl}`;
        }

        const sinopsis = $('.synopsis, #movie-detail p').text().trim() || "Sinopsis tidak tersedia.";
        const genres = [];
        $('a[href*="/genre/"]').each((_, el) => genres.push($(el).text().trim()));

        const responseData = {
            slug,
            embed_url: embedUrl || null,
            sinopsis,
            genres: [...new Set(genres)]
        };

        if (embedUrl) {
            try {
                await c.env.LK21_KV.put(cacheKey, JSON.stringify(responseData), { expirationTtl: CACHE_TTL });
            } catch (e) {
                console.error("KV Set Error:", e.message);
            }
        }

        return c.json({ status: true, source: "Live Scrape", ...responseData });

    } catch (err) {
        return c.json({ error: true, error_msg: err.message }, 500);
    }
});

export default app;
