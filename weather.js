// 天气：浏览器里只能用支持 CORS 的源，open-meteo 是最稳的（含过去几天，可回取 92 天）
// 只取需要的日期，其他字段对齐 Android 版的展示格式：`济宁市 小雨 13~18℃  东风2级`

const CITY = '济宁市';
const LAT = 35.415;
const LON = 116.587;

const WMO = {
  0: '晴', 1: '多云', 2: '多云', 3: '阴',
  45: '雾', 48: '雾',
  51: '小雨', 53: '小雨', 55: '中雨',
  56: '冻雨', 57: '冻雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪',
  80: '阵雨', 81: '阵雨', 82: '暴雨',
  85: '阵雪', 86: '阵雪',
  95: '雷阵雨', 96: '雷阵雨', 99: '雷阵雨',
};

function windDir(deg) {
  const dirs = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  const idx = Math.round(((deg % 360) + 360) % 360 / 45) % 8;
  return dirs[idx];
}

function kmhToLevel(kmh) {
  const table = [1, 5, 11, 19, 28, 38, 49, 61, 74, 88, 102, 117];
  let level = 0;
  for (const limit of table) {
    if (kmh >= limit) level++; else break;
  }
  return Math.max(0, Math.min(12, level));
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysBetween(a, b) {
  const ms = new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00');
  return Math.round(ms / 86400000);
}

/**
 * @param {string[]} ymds 需要的日期（YYYY-MM-DD）
 * @returns {Promise<Record<string,string>>} ymd -> 展示文案
 */
export async function fetchWeather(ymds) {
  const list = [...new Set(ymds.filter(Boolean))].sort();
  if (!list.length) return {};
  const today = todayStr();
  const min = list[0];
  const max = list[list.length - 1];
  const pastDays = Math.max(0, Math.min(92, daysBetween(min, today)));
  const forecastDays = Math.max(7, Math.min(16, daysBetween(today, max) + 1));

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}`
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,'
    + 'wind_speed_10m_max,wind_direction_10m_dominant'
    + `&timezone=Asia%2FShanghai&past_days=${pastDays}&forecast_days=${forecastDays}`;

  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  const daily = json.daily;
  if (!daily || !daily.time) throw new Error('天气数据为空');

  const out = {};
  for (let i = 0; i < daily.time.length; i++) {
    const ymd = daily.time[i];
    const code = daily.weather_code?.[i];
    const high = daily.temperature_2m_max?.[i];
    const low = daily.temperature_2m_min?.[i];
    const speed = daily.wind_speed_10m_max?.[i];
    const dir = daily.wind_direction_10m_dominant?.[i];
    if (code === null || code === undefined) continue;
    let text = `${CITY} ${WMO[code] ?? '多云'}`;
    if (high !== null && high !== undefined) text += ` ${Math.round(low)}~${Math.round(high)}℃`;
    if (speed !== null && speed !== undefined) {
      text += `  ${windDir(dir ?? 0)}风${kmhToLevel(speed)}级`;
    }
    out[ymd] = text;
  }
  return out;
}
