// Cloudflare Worker - 歌曲宝搜索和播放代理
// 部署后访问：https://your-worker.workers.dev/api/search?keyword=xxx
//           https://your-worker.workers.dev/api/play?id=xxx

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Range',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // OPTIONS 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === '/api/search') {
      return handleSearch(url);
    } else if (url.pathname === '/api/play') {
      return handlePlay(url, request);
    }

    return new Response(JSON.stringify({ error: 'Not Found', path: url.pathname }), {
      status: 404,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  },
};

// 搜索接口
async function handleSearch(url) {
  const keyword = url.searchParams.get('keyword');
  if (!keyword || !keyword.trim()) {
    return new Response(JSON.stringify({ error: '缺少 keyword 参数' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  try {
    const targetUrl = `https://www.gequbao.com/s/${encodeURIComponent(keyword.trim())}`;
    const resp = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    const html = await resp.text();

    // 解析歌曲列表
    const songs = [];
    const seen = new Set();
    const regex = /<a[^>]*href="\/music\/(\d+)"[^>]*title="([^"]*)"/g;
    let match;
    while ((match = regex.exec(html)) !== null) {
      const id = match[1];
      const title = match[2].replace(/&amp;/g, '&').replace(/&quot;/g, '"');
      if (seen.has(id)) continue;
      seen.add(id);

      // 解析 "歌名 - 歌手" 格式
      const sepIndex = title.indexOf(' - ');
      let name, artist;
      if (sepIndex > 0) {
        name = title.substring(0, sepIndex).trim();
        artist = title.substring(sepIndex + 3).trim();
      } else {
        name = title;
        artist = '';
      }

      songs.push({ id, name, artist, title, source: 'gequbao', vip: false });
      if (songs.length >= 30) break;
    }

    return new Response(JSON.stringify({ keyword, count: songs.length, songs }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: '搜索请求失败', detail: e.message }), {
      status: 502,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
}

// 播放地址接口
async function handlePlay(url, request) {
  const id = url.searchParams.get('id');
  if (!id) {
    return new Response(JSON.stringify({ error: '缺少 id 参数' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  try {
    // 第一步：访问详情页，获取 play_id 和 Cookie
    const detailUrl = `https://www.gequbao.com/music/${id}`;
    const detailResp = await fetch(detailUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    const detailHtml = await detailResp.text();
    const setCookie = detailResp.headers.get('set-cookie') || '';

    // 提取 play_id
    let playId = null;
    let m = detailHtml.match(/\\u0022play_id\\u0022:\\u0022([^\\]+)\\u0022/);
    if (m) playId = m[1];
    if (!playId) {
      m = detailHtml.match(/"play_id":"([^"]+)"/);
      if (m) playId = m[1];
    }

    if (!playId) {
      return new Response(JSON.stringify({ error: '未能从详情页提取 play_id' }), {
        status: 502,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    // 第二步：调用 common-play-url 获取真实播放地址
    const postBody = `id=${encodeURIComponent(playId)}&purpose=play`;
    const playResp = await fetch('https://www.gequbao.com/member/common-play-url', {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': 'https://www.gequbao.com',
        'Referer': detailUrl,
        'Cookie': setCookie,
      },
      body: postBody,
    });
    const playText = await playResp.text();

    let playJson;
    try {
      playJson = JSON.parse(playText);
    } catch (e) {
      return new Response(JSON.stringify({ error: '播放地址接口返回非JSON' }), {
        status: 502,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    if (playJson.code !== 1 || !playJson.data || !playJson.data.url) {
      return new Response(JSON.stringify({ error: playJson.msg || '未获取到播放地址，该歌曲可能需要VIP或已下架' }), {
        status: 404,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const realUrl = playJson.data.url;

    // 第三步：代理音频流（带伪造 Referer 解决 CDN 防盗链）
    const range = request.headers.get('range');
    const audioHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://www.gequbao.com/',
    };
    if (range) audioHeaders['Range'] = range;

    const audioResp = await fetch(realUrl, { headers: audioHeaders });

    // 构建响应头
    const responseHeaders = { ...CORS_HEADERS };
    const contentType = audioResp.headers.get('content-type');
    responseHeaders['Content-Type'] = contentType || 'audio/mpeg';
    const contentLength = audioResp.headers.get('content-length');
    if (contentLength) responseHeaders['Content-Length'] = contentLength;
    const contentRange = audioResp.headers.get('content-range');
    if (contentRange) responseHeaders['Content-Range'] = contentRange;
    responseHeaders['Accept-Ranges'] = 'bytes';
    responseHeaders['Cache-Control'] = 'public, max-age=3600';

    return new Response(audioResp.body, {
      status: audioResp.status === 206 ? 206 : 200,
      headers: responseHeaders,
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: '播放代理出错', detail: e.message }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
}
