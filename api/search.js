// 歌曲宝搜索代理接口
// 用法: /api/search?keyword=稻香
const https = require('https');

module.exports = (req, res) => {
  // CORS 跨域
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const keyword = req.query.keyword;
  if (!keyword || !keyword.trim()) {
    res.status(400).json({ error: '缺少 keyword 参数' });
    return;
  }

  const url = `https://www.gequbao.com/s/${encodeURIComponent(keyword.trim())}`;

  https.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9'
    }
  }, (resp) => {
    let data = '';
    resp.on('data', (chunk) => { data += chunk; });
    resp.on('end', () => {
      try {
        const songs = [];
        const seen = new Set();
        // 匹配 <a href="/music/ID" title="歌名 - 歌手">
        const regex = /<a[^>]*href="\/music\/(\d+)"[^>]*title="([^"]*)"/g;
        let match;
        while ((match = regex.exec(data)) !== null) {
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
          songs.push({
            id: id,
            name: name,
            artist: artist,
            title: title,
            source: 'gequbao',
            vip: false
          });
          if (songs.length >= 30) break;
        }
        res.json({
          keyword: keyword,
          count: songs.length,
          songs: songs
        });
      } catch (e) {
        res.status(500).json({ error: '解析搜索结果失败', detail: e.message });
      }
    });
  }).on('error', (err) => {
    res.status(502).json({ error: '搜索请求失败', detail: err.message });
  });
};
