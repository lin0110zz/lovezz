// 歌曲宝播放地址代理接口（完整流程：详情页取play_id -> common-play-url取真实地址 -> 代理音频流）
// 用法: /api/play?id=4190
const https = require('https');
const http = require('http');

// 通用 HTTPS GET，返回 { body, cookies, headers }
function httpsGet(url, headers = {}, cookies = '') {
  return new Promise((resolve, reject) => {
    const allHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      ...headers
    };
    if (cookies) allHeaders['Cookie'] = cookies;

    https.get(url, { headers: allHeaders }, (resp) => {
      let data = '';
      resp.on('data', (chunk) => { data += chunk; });
      resp.on('end', () => {
        const setCookies = resp.headers['set-cookie'] || [];
        resolve({ body: data, cookies: setCookies, headers: resp.headers, status: resp.statusCode });
      });
    }).on('error', reject);
  });
}

// 通用 HTTPS POST
function httpsPost(url, body, headers = {}, cookies = '') {
  return new Promise((resolve, reject) => {
    const allHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': 'https://www.gequbao.com',
      ...headers
    };
    if (cookies) allHeaders['Cookie'] = cookies;

    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: allHeaders
    }, (resp) => {
      let data = '';
      resp.on('data', (chunk) => { data += chunk; });
      resp.on('end', () => resolve({ body: data, status: resp.statusCode, headers: resp.headers }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// 从详情页 HTML 提取 play_id
function extractPlayId(html) {
  // 格式1: \u0022play_id\u0022:\u0022...\u0022
  let m = html.match(/\\u0022play_id\\u0022:\\u0022([^\\]+)\\u0022/);
  if (m) return m[1];
  // 格式2: "play_id":"..."
  m = html.match(/"play_id":"([^"]+)"/);
  if (m) return m[1];
  return null;
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const id = req.query.id;
  if (!id) {
    res.status(400).json({ error: '缺少 id 参数' });
    return;
  }

  try {
    // 第一步：访问详情页，获取 play_id 和 Cookie
    const detailUrl = `https://www.gequbao.com/music/${id}`;
    const detail = await httpsGet(detailUrl, {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    });

    const playId = extractPlayId(detail.body);
    if (!playId) {
      res.status(502).json({ error: '未能从详情页提取 play_id', detail: detail.body.substring(0, 500) });
      return;
    }

    // 组装 Cookie
    const cookieStr = detail.cookies.map(c => c.split(';')[0]).join('; ');

    // 第二步：调用 /member/common-play-url 获取真实播放地址
    const postBody = `id=${encodeURIComponent(playId)}&purpose=play`;
    const playResp = await httpsPost(
      'https://www.gequbao.com/member/common-play-url',
      postBody,
      { 'Referer': detailUrl },
      cookieStr
    );

    let playJson;
    try {
      playJson = JSON.parse(playResp.body);
    } catch (e) {
      res.status(502).json({ error: '播放地址接口返回非JSON', raw: playResp.body.substring(0, 500) });
      return;
    }

    if (playJson.code !== 1 || !playJson.data || !playJson.data.url) {
      res.status(404).json({
        error: playJson.msg || '未获取到播放地址，该歌曲可能需要VIP或已下架',
        raw: playJson
      });
      return;
    }

    const realUrl = playJson.data.url;

    // 第三步：代理音频流（带伪造 Referer 解决 CDN 防盗链）
    const client = realUrl.startsWith('https') ? https : http;
    const range = req.headers['range'];
    const audioHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://www.gequbao.com/'
    };
    if (range) audioHeaders['Range'] = range;

    const audioReq = client.get(realUrl, { headers: audioHeaders }, (audioResp) => {
      if (audioResp.headers['content-type']) {
        res.setHeader('Content-Type', audioResp.headers['content-type']);
      } else {
        res.setHeader('Content-Type', 'audio/mpeg');
      }
      if (audioResp.headers['content-length']) {
        res.setHeader('Content-Length', audioResp.headers['content-length']);
      }
      if (audioResp.headers['content-range']) {
        res.setHeader('Content-Range', audioResp.headers['content-range']);
      }
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.status(audioResp.statusCode === 206 ? 206 : 200);
      audioResp.pipe(res);
    });

    audioReq.on('error', (err) => {
      if (!res.headersSent) {
        res.status(502).json({ error: '音频流代理失败', detail: err.message });
      }
    });

  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: '播放代理出错', detail: err.message });
    }
  }
};
